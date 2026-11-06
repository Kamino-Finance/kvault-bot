import { getCurrentLedgerInstant, KaminoManager, KaminoVault, KaminoReserve, sleep } from '@kamino-finance/klend-sdk';
import { AddressLookupTable } from '@solana-program/address-lookup-table';
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { Account, Address, IInstruction, KeyPairSigner, Rpc, SolanaRpcApi } from '@solana/kit';
import { logger } from 'kvaults-investing-bot-logger';
import { ConnectionPool } from 'kvaults-investing-bot-tx/ConnectionPool';
import {
  sendAndConfirmTransactionV0,
  SimulateTransactionError,
  TransactionError,
} from 'kvaults-investing-bot-tx/instruction';
import { buildWeightUpdateIx, getVaultAllocationForReserve } from '../allocationsRebalance/vaultUtils.js';
import { sendInstructionBatches } from '../utils/sendInstructionBatches.js';
import {
  describeProgramFailure,
  failureCanFollowMissingWithdrawalProceeds,
  failedOutsideInstructions,
  getFailedInstruction,
  isReserveAttributableFailure,
} from '../utils/programFailure.js';
import { planReserveInstructions, ReserveIx, sendReserveBatches } from '../utils/reserveBatches.js';
import { loadVaultLookupTables, withVaultLookupTableRecovery } from '../libs/lut.js';
import { ReserveDeinvestFailures } from './deinvestFailures.js';

const DEINVEST_BATCH_SIZE = 2;
const DEINVEST_DESCRIPTION = 'danger-response emergency deinvest';
const ZERO_ALLOCATION_BATCH_SIZE = 2;
const ZERO_ALLOCATION_DESCRIPTION = 'danger-response zero allocation';

/**
 * Injectable side-effecting dependencies, so the safety-critical control flow can be unit-tested
 * without real on-chain sends. Defaults to the real implementation.
 */
export interface DangerResponseDeps {
  sendTx?: typeof sendAndConfirmTransactionV0;
  /**
   * Returns true once the danger pass that started this response has been superseded. The response then
   * throws DangerResponseAbortedError before its next send or state change instead of continuing.
   */
  shouldAbort?: () => boolean;
  delay?: (milliseconds: number) => Promise<void>;
  /** The coordinator supplies one tracker so failure runs survive response calls and danger passes. */
  deinvestFailures?: ReserveDeinvestFailures;
}

/** Thrown when the caller's pass was superseded mid-response; nothing further is sent or mutated. */
export class DangerResponseAbortedError extends Error {
  constructor(where: string) {
    super(`[danger-response] aborted before ${where}: the danger pass that started this response was superseded`);
  }
}

/**
 * Execute emergency deinvestment for a vault: zero the allocation weight while
 * preserving the configured cap for all dangerous reserves, then trigger invest.
 */
export async function executeDangerResponse(
  dangerousReserveAddresses: Set<string>,
  kaminoManager: KaminoManager,
  kaminoVault: KaminoVault,
  vaultsReservesMap: Map<Address, KaminoReserve>,
  allocationAdmin: KeyPairSigner,
  c: ConnectionPool,
  deps: DangerResponseDeps = {}
): Promise<void> {
  const delay = deps.delay ?? sleep;
  const shouldAbort = deps.shouldAbort ?? (() => false);
  const assertNotAborted = (where: string): void => {
    if (shouldAbort()) throw new DangerResponseAbortedError(where);
  };
  const sendTx = withVaultLookupTableRecovery((...args) => {
    assertNotAborted(args[5] ?? 'send');
    return (deps.sendTx ?? sendAndConfirmTransactionV0)(...args);
  });
  const failures = deps.deinvestFailures ?? new ReserveDeinvestFailures();
  const kvaultsProgramId = kaminoManager.getProgramID();
  const vaultState = await kaminoVault.getState();
  const vaultReserves = kaminoManager.getVaultReserves(vaultState);

  // Filter to only reserves that belong to this vault AND are flagged dangerous
  const dangerousVaultReserves = vaultReserves.filter((r) => dangerousReserveAddresses.has(r.toString()));
  if (dangerousVaultReserves.length === 0) return;

  logger.error(
    `[danger-response] EMERGENCY: zeroing allocation for ${dangerousVaultReserves.length} reserve(s) in vault ${kaminoVault.address}`
  );

  // Build zero-allocation instructions
  const zeroAllocIxs: ReserveIx[] = [];
  for (const reserveAddr of dangerousVaultReserves) {
    const reserveState = vaultsReservesMap.get(reserveAddr);
    if (!reserveState) {
      const allocation = getVaultAllocationForReserve(vaultState, reserveAddr);
      if (allocation !== undefined && !allocation.targetAllocationWeight.isZero()) {
        logger.error(
          `[danger-response] Reserve ${reserveAddr} state is unavailable. Its nonzero allocation cannot be updated`
        );
      }
      continue;
    }

    const zeroIx = await buildWeightUpdateIx(
      kaminoManager,
      kaminoVault,
      vaultState,
      { address: reserveAddr, state: reserveState.state },
      0,
      allocationAdmin
    );
    if (!zeroIx) {
      logger.info(`[danger-response] Reserve ${reserveAddr} already at zero allocation, skipping`);
      continue;
    }
    zeroAllocIxs.push({ reserve: reserveAddr, ix: zeroIx, ordinal: zeroAllocIxs.length });
    logger.error(`[danger-response] Reserve ${reserveAddr} allocation will be zeroed`);
  }

  const luts = await loadVaultLookupTables(
    c.getRpc() as Rpc<SolanaRpcApi>,
    kaminoVault.address,
    vaultState,
    '[danger-response]'
  );

  const failedZeroAllocations = await sendZeroAllocationIxs(
    c,
    allocationAdmin,
    zeroAllocIxs,
    luts,
    kaminoVault.address,
    failures,
    sendTx
  );
  for (const reserve of failedZeroAllocations) {
    logger.error(`[danger-response] Reserve ${reserve} allocation update was rejected. Checking refreshed state`);
  }

  // Reload state and trigger deinvest
  await delay(5000);
  assertNotAborted('state reload');
  await kaminoVault.reloadState();
  const currentLedgerInstant = await getCurrentLedgerInstant(kaminoManager.getRpc());
  const investIxs = await kaminoManager.investAllReservesIxs(allocationAdmin, kaminoVault, currentLedgerInstant, true);
  const refreshedVaultState = await kaminoVault.getState();
  const confirmedZeroReserves = new Set<Address>();
  const unresolvedZeroAllocations = new Set<Address>();
  for (const reserve of dangerousVaultReserves) {
    const allocation = getVaultAllocationForReserve(refreshedVaultState, reserve);
    if (allocation !== undefined && allocation.targetAllocationWeight.isZero()) {
      confirmedZeroReserves.add(reserve);
    } else {
      unresolvedZeroAllocations.add(reserve);
    }
  }
  // Only the dangerous reserves' withdrawals go out under the emergency force-send policy. The SDK's plan
  // also carries deposits into the healthy reserves; those wait for the investing loop, which resumes
  // once the evacuation is complete. After a partial allocation update only the confirmed zeroed
  // reserves may be withdrawn and an unmappable plan fails closed. With every update confirmed, an
  // unmappable plan falls back to the plain batches the response always sent before.
  let deinvestIxs: IInstruction[];
  if (unresolvedZeroAllocations.size > 0) {
    deinvestIxs = restrictDeinvestIxsToReserves(investIxs, kvaultsProgramId, vaultReserves, confirmedZeroReserves);
  } else {
    try {
      deinvestIxs = restrictDeinvestIxsToReserves(
        investIxs,
        kvaultsProgramId,
        vaultReserves,
        new Set(dangerousVaultReserves)
      );
    } catch (error) {
      logger.error(
        `[danger-response] vault ${kaminoVault.address}: ${error}; sending the SDK's plan in plain emergency batches`
      );
      deinvestIxs = investIxs;
    }
  }
  const refreshAfterResponse = async (): Promise<void> => {
    if (deinvestIxs.length > 0) {
      // A prior batch can confirm before a later batch fails. Refresh before the next pass so the SDK
      // does not build another withdrawal for instructions that already confirmed.
      await kaminoVault.reloadState();
    }
  };
  let outcome: DeinvestOutcome;
  try {
    outcome = await sendDeinvestIxs({
      c,
      payer: allocationAdmin,
      instructions: deinvestIxs,
      lookupTables: luts,
      vaultAddress: kaminoVault.address,
      kvaultsProgramId,
      vaultReserves,
      failures,
      sendTx,
    });
  } catch (responseError) {
    try {
      await refreshAfterResponse();
    } catch (refreshError) {
      logger.error(
        `[danger-response] failed to refresh vault ${kaminoVault.address} after the emergency response failed: ` +
          `${refreshError}. The original response error is retained.`
      );
    }
    throw responseError;
  }
  await refreshAfterResponse();

  const pendingReserves = new Set([...unresolvedZeroAllocations, ...outcome.failed]);
  // A withdrawal is capped at the reserve's free liquidity, so a reserve can keep tokens after every send landed.
  const finalVaultState = await kaminoVault.getState();
  const reservesStillHoldingTokens = dangerousVaultReserves.filter(
    (reserve) => getVaultAllocationForReserve(finalVaultState, reserve)?.ctokenAllocation.isZero() === false
  );
  if (pendingReserves.size === 0 && reservesStillHoldingTokens.length > 0) {
    logger.error(
      `[danger-response] Emergency deinvest for vault ${kaminoVault.address} left tokens in ${reservesStillHoldingTokens.length} reserve(s) ` +
        `without enough free liquidity: ${reservesStillHoldingTokens.join(', ')}. The bot withdraws again in the next pass.`
    );
  } else if (zeroAllocIxs.length === 0 && deinvestIxs.length === 0 && pendingReserves.size === 0) {
    logger.error(`[danger-response] No emergency deinvest ixs to send for vault ${kaminoVault.address}`);
  } else if (pendingReserves.size === 0) {
    logger.error(
      `[danger-response] Emergency deinvest confirmed for vault ${kaminoVault.address}: ${zeroAllocIxs.length} zero-allocation + ${deinvestIxs.length} deinvest ix(s).`
    );
  } else {
    logger.error(
      `[danger-response] Emergency deinvest for vault ${kaminoVault.address} is incomplete: ` +
        `${outcome.sent.length} reserve instruction(s) confirmed, ${unresolvedZeroAllocations.size} allocation(s) ` +
        `remain nonzero or unconfirmed, and ${outcome.failed.length} withdrawal(s) failed. Pending reserves: ` +
        `${Array.from(pendingReserves).join(', ')}. The bot will retry the pending evacuation in the next pass.`
    );
  }
}

async function sendZeroAllocationIxs(
  c: ConnectionPool,
  payer: KeyPairSigner,
  instructions: ReserveIx[],
  lookupTables: Account<AddressLookupTable>[],
  vaultAddress: Address,
  failures: ReserveDeinvestFailures,
  sendTx: typeof sendAndConfirmTransactionV0
): Promise<Set<Address>> {
  const failed = new Set<Address>();
  await sendReserveBatches<{ error: unknown; broadcastAttempted: boolean; sentIxs: IInstruction[] }>(
    { preamble: [], reserveIxs: instructions },
    ZERO_ALLOCATION_BATCH_SIZE,
    {
      sendPreamble: async () => undefined,
      send: async (batch, sentIxs, soloRetryOf) => {
        const forceEligible = batch.every(({ reserve }) => failures.shouldForceSend(vaultAddress, reserve));
        const suppressForcedProgramFailures = soloRetryOf?.broadcastAttempted ?? false;
        try {
          await sendTx(c, payer, sentIxs, lookupTables, [payer], ZERO_ALLOCATION_DESCRIPTION, {
            reportSample: true,
            sendIfSimulationFailed: forceEligible,
            shouldSendAfterSimulationFailure:
              forceEligible && suppressForcedProgramFailures
                ? (error) => !isReserveAttributableFailure(error)
                : undefined,
          });
        } catch (error) {
          if (!isReserveAttributableFailure(error) && (!(error instanceof SimulateTransactionError) || forceEligible)) {
            throw error;
          }
          return { error, broadcastAttempted: error instanceof TransactionError, sentIxs };
        }

        for (const { reserve } of batch) {
          failures.recordSuccess(vaultAddress, reserve);
          failed.delete(reserve);
        }
        await new Promise((resolve) => setImmediate(resolve));
        return undefined;
      },
      onBatchFailure: (batch, batchFailure) => {
        if (!batchFailure.broadcastAttempted) return;
        const failedIx = getFailedInstruction(batchFailure.error, batchFailure.sentIxs);
        const failedReserveIx = batch.find(({ ix }) => ix === failedIx);
        if (failedReserveIx !== undefined) {
          failures.recordFailure(vaultAddress, failedReserveIx.reserve, describeProgramFailure(batchFailure.error));
        }
      },
      onReserveFailure: (reserveIx, { error, broadcastAttempted }) => {
        if (broadcastAttempted) {
          failures.recordFailure(vaultAddress, reserveIx.reserve, describeProgramFailure(error));
        }
        failed.add(reserveIx.reserve);
      },
    }
  );
  return failed;
}

function restrictDeinvestIxsToReserves(
  instructions: IInstruction[],
  kvaultsProgramId: Address,
  vaultReserves: Address[],
  allowedReserves: ReadonlySet<Address>
): IInstruction[] {
  const plan = planReserveInstructions(instructions, kvaultsProgramId, vaultReserves);
  if ('fallbackReason' in plan) {
    throw new Error(`[danger-response] cannot safely isolate withdrawals: ${plan.fallbackReason}`);
  }
  const unsafePreamble = plan.preamble.find(
    ({ programAddress }) => programAddress !== ASSOCIATED_TOKEN_PROGRAM_ADDRESS
  );
  if (unsafePreamble !== undefined) {
    throw new Error(
      `[danger-response] cannot safely isolate withdrawals: ` +
        `unrecognized instruction from program ${unsafePreamble.programAddress}`
    );
  }
  const allowedIxs = new Set(plan.reserveIxs.filter(({ reserve }) => allowedReserves.has(reserve)).map(({ ix }) => ix));
  if (allowedIxs.size === 0) return [];
  return instructions.filter((ix) => ix.programAddress === ASSOCIATED_TOKEN_PROGRAM_ADDRESS || allowedIxs.has(ix));
}

interface SendDeinvestIxsRequest {
  c: ConnectionPool;
  payer: KeyPairSigner;
  instructions: IInstruction[];
  lookupTables: Account<AddressLookupTable>[];
  vaultAddress: Address;
  kvaultsProgramId: Address;
  vaultReserves: Address[];
  failures: ReserveDeinvestFailures;
  sendTx: typeof sendAndConfirmTransactionV0;
}

interface DeinvestOutcome {
  sent: Address[];
  failed: Address[];
}

interface SendFailure {
  error: unknown;
  broadcastAttempted: boolean;
  reserveAttributable: boolean;
  sentIxs: IInstruction[];
}

/** Send emergency withdrawals in SDK order while one rejected reserve does not block healthy reserves. */
async function sendDeinvestIxs({
  c,
  payer,
  instructions,
  lookupTables,
  vaultAddress,
  kvaultsProgramId,
  vaultReserves,
  failures,
  sendTx,
}: SendDeinvestIxsRequest): Promise<DeinvestOutcome> {
  const plan = planReserveInstructions(instructions, kvaultsProgramId, vaultReserves);
  if ('fallbackReason' in plan || plan.reserveIxs.length === 0) {
    if ('fallbackReason' in plan) {
      logger.error(
        `[danger-response] vault ${vaultAddress}: ${plan.fallbackReason}; sending all ${instructions.length} ` +
          `instruction(s) in plain emergency batches without failure tracking`
      );
    }
    await sendInstructionBatches({
      connectionPool: c,
      payer,
      instructions,
      lookupTables,
      description: DEINVEST_DESCRIPTION,
      batchSize: DEINVEST_BATCH_SIZE,
      options: { reportSample: true, sendIfSimulationFailed: true },
      sendTx,
    });
    return { sent: [], failed: [] };
  }

  const sent = new Set<Address>();
  const failed = new Set<Address>();
  let earliestMissingOrdinal: number | undefined;
  const hasEarlierMissingInstruction = ({ ordinal }: ReserveIx): boolean =>
    earliestMissingOrdinal !== undefined && earliestMissingOrdinal < ordinal;
  const markMissing = (reserveIx: ReserveIx): void => {
    failed.add(reserveIx.reserve);
    earliestMissingOrdinal =
      earliestMissingOrdinal === undefined ? reserveIx.ordinal : Math.min(earliestMissingOrdinal, reserveIx.ordinal);
  };
  const isDownstreamFundingFailure = (batch: ReserveIx[], error: unknown, sentIxs: IInstruction[]): boolean => {
    if (!failureCanFollowMissingWithdrawalProceeds(error, kvaultsProgramId)) return false;
    const failedIx = getFailedInstruction(error, sentIxs);
    const failedReserveIx = batch.find(({ ix }) => ix === failedIx);
    return failedReserveIx !== undefined
      ? hasEarlierMissingInstruction(failedReserveIx)
      : batch.some(hasEarlierMissingInstruction);
  };

  const send = async (
    batch: ReserveIx[],
    sentIxs: IInstruction[],
    soloRetryOf?: SendFailure
  ): Promise<SendFailure | undefined> => {
    const forceEligible = batch.every(({ reserve }) => failures.shouldForceSend(vaultAddress, reserve));
    const hasEarlierMissing = batch.some(hasEarlierMissingInstruction);
    const suppressForcedProgramFailures = soloRetryOf?.broadcastAttempted ?? false;
    try {
      await sendTx(c, payer, sentIxs, lookupTables, [payer], DEINVEST_DESCRIPTION, {
        reportSample: true,
        sendIfSimulationFailed: forceEligible,
        shouldSendAfterSimulationFailure:
          forceEligible && (hasEarlierMissing || suppressForcedProgramFailures)
            ? (error) =>
                !(suppressForcedProgramFailures && isReserveAttributableFailure(error)) &&
                !isDownstreamFundingFailure(batch, error, sentIxs)
            : undefined,
      });
    } catch (error) {
      const reserveAttributable = isReserveAttributableFailure(error);
      if (reserveAttributable) {
        if (
          failedOutsideInstructions(
            error,
            sentIxs,
            batch.map(({ ix }) => ix)
          )
        ) {
          throw error;
        }
      } else if (!(error instanceof SimulateTransactionError)) {
        // A transaction or arbitrary sender error can have an unknown execution outcome. Do not replay it.
        throw error;
      }
      return {
        error,
        broadcastAttempted: error instanceof TransactionError,
        reserveAttributable,
        sentIxs,
      };
    }

    for (const { reserve } of batch) {
      failures.recordSuccess(vaultAddress, reserve);
      failed.delete(reserve);
      sent.add(reserve);
    }
    await new Promise((resolve) => setImmediate(resolve));
    return undefined;
  };

  const recordFailedBroadcast = (reserveIx: ReserveIx, error: unknown, sentIxs: IInstruction[]): void => {
    if (!isDownstreamFundingFailure([reserveIx], error, sentIxs)) {
      failures.recordFailure(vaultAddress, reserveIx.reserve, describeProgramFailure(error));
    }
  };

  const finishSoloFailure = (reserveIx: ReserveIx, failure: SendFailure): void => {
    if (failure.reserveAttributable && isDownstreamFundingFailure([reserveIx], failure.error, failure.sentIxs)) {
      markMissing(reserveIx);
      return;
    }

    if (failure.broadcastAttempted) {
      recordFailedBroadcast(reserveIx, failure.error, failure.sentIxs);
    }
    markMissing(reserveIx);
  };

  await sendReserveBatches<SendFailure>(plan, DEINVEST_BATCH_SIZE, {
    sendPreamble: (preamble) =>
      sendInstructionBatches({
        connectionPool: c,
        payer,
        instructions: preamble,
        lookupTables,
        description: DEINVEST_DESCRIPTION,
        batchSize: DEINVEST_BATCH_SIZE,
        options: { reportSample: true, sendIfSimulationFailed: true },
        sendTx,
      }),
    send,
    onBatchFailure: (batch, batchFailure) => {
      logger.warn(
        `[danger-response] vault ${vaultAddress}: deinvest batch of ${batch.length} failed ` +
          `(${describeProgramFailure(batchFailure.error)}); checking each reserve`
      );
      const failedIx = batchFailure.broadcastAttempted
        ? getFailedInstruction(batchFailure.error, batchFailure.sentIxs)
        : undefined;
      const failedReserveIx = batch.find(({ ix }) => ix === failedIx);
      if (failedReserveIx !== undefined) {
        recordFailedBroadcast(failedReserveIx, batchFailure.error, batchFailure.sentIxs);
      }
    },
    onReserveFailure: finishSoloFailure,
  });

  return { sent: Array.from(sent), failed: Array.from(failed) };
}
