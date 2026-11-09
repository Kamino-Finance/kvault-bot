import { AddressLookupTable } from '@solana-program/address-lookup-table';
import { Account, Address, IInstruction, TransactionSigner } from '@solana/kit';
import {
  getCurrentLedgerInstant,
  KaminoManager,
  KaminoReserve,
  KaminoVault,
  LedgerInstant,
} from '@kamino-finance/klend-sdk';
import { logger } from 'kvaults-investing-bot-logger';
import { ConnectionPool } from 'kvaults-investing-bot-tx/ConnectionPool';
import { sendAndConfirmTransactionV0, SendTransactionOptions } from 'kvaults-investing-bot-tx/instruction';
import type { InvestUtilizationCap } from '../investing/utilizationCap.js';
import { withVaultLookupTableRecovery } from '../libs/lut.js';
import { LoopHeartbeat, whileBeating, yieldAndBeat } from './loop.js';
import { sendInstructionBatches } from './sendInstructionBatches.js';
import { RPC_REQUEST_TIMEOUT_MS, withTimeout } from './timeout.js';
import { depositsInto } from './noNewFunds.js';
import {
  describeProgramFailure,
  failedOutsideInstructions,
  failureCanFollowMissingWithdrawalProceeds,
  isInvestAmountBelowMinimumFailure,
  isPayerRoundingShortfall,
  isReserveAttributableFailure,
} from './programFailure.js';
import { planReserveInstructions, ReserveIx, sendReserveBatches } from './reserveBatches.js';
import { isUtilizationChangeAllowed } from './utilizationCap.js';

/**
 * Per-vault, per-reserve back-off for reserves whose invest/disinvest instruction fails on-chain (for
 * example a reserve whose refresh is rejected while its oracle is paused). While a pair cools down,
 * its instruction is dropped from that vault's invest instead of being retried every loop.
 *
 * In-memory only, deliberately: a restart just means one more attempt for the reserve, after which
 * it is back on cooldown. Nothing safety-relevant is lost; the danger blacklist is the persisted state.
 * A cooldown of 0 ms disables the back-off: a failed reserve is retried on the very next pass.
 */
export class ReserveInvestCooldowns {
  private readonly coolingDownUntilMs = new Map<Address, Map<Address, number>>();

  constructor(
    private readonly cooldownMs: number,
    private readonly nowMs: () => number = Date.now,
    /** Log prefix of the loop that owns the cooldowns. */
    private readonly logPrefix: string = '[investing-loop]'
  ) {}

  /** Expire elapsed cooldowns. Call once per loop iteration. */
  tick(): void {
    const now = this.nowMs();
    for (const [vault, reserveCooldowns] of this.coolingDownUntilMs) {
      for (const [reserve, untilMs] of reserveCooldowns) {
        if (now >= untilMs) {
          reserveCooldowns.delete(reserve);
          logger.info(
            `${this.logPrefix} reserve ${reserve} invest cooldown elapsed for vault ${vault}, it is investable again`
          );
        }
      }
      if (reserveCooldowns.size === 0) this.coolingDownUntilMs.delete(vault);
    }
  }

  isCoolingDown(reserve: Address, vault: Address): boolean {
    const untilMs = this.coolingDownUntilMs.get(vault)?.get(reserve);
    return untilMs !== undefined && this.nowMs() < untilMs;
  }

  /** Start (or extend) the cooldown; logs once per start. */
  start(reserve: Address, vault: Address, reason: string): void {
    const untilMs = this.nowMs() + this.cooldownMs;
    let reserveCooldowns = this.coolingDownUntilMs.get(vault);
    if (reserveCooldowns === undefined) {
      reserveCooldowns = new Map<Address, number>();
      this.coolingDownUntilMs.set(vault, reserveCooldowns);
    }
    reserveCooldowns.set(reserve, untilMs);
    logger.error(
      `${this.logPrefix} reserve ${reserve} is not investable for vault ${vault} (${reason}); skipping it for ${Math.round(this.cooldownMs / 1000)}s`
    );
  }

  getReserves(vault: Address): Address[] {
    return Array.from(this.coolingDownUntilMs.get(vault)?.keys() ?? []);
  }
}

export interface SendInvestIxsRequest {
  connectionPool: ConnectionPool;
  payer: TransactionSigner;
  /** Instructions from `investAllReservesIxs`, in SDK order (disinvests before invests). */
  instructions: IInstruction[];
  lookupTables: Account<AddressLookupTable>[];
  vaultAddress: Address;
  kvaultsProgramId: Address;
  /** Reserves of the vault's allocation strategy. An invest ix whose reserve slot holds any other account is not trusted. */
  vaultReserves: Address[];
  cooldowns: ReserveInvestCooldowns;
  batchSize: number;
  description: string;
  options?: SendTransactionOptions;
  heartbeat?: LoopHeartbeat;
  sendTx?: typeof sendAndConfirmTransactionV0;
  /** Called after each transaction that carries invest instructions lands, also when a later one then throws. */
  onInvestLanded?: () => void;
  /** Log prefix of the caller. */
  logPrefix?: string;
  /** Reserves whose instruction is not sent this pass, with no cooldown: deposits into reserves that get no new funds. */
  skipReserves?: ReadonlySet<Address>;
}

export interface SendInvestIxsOutcome {
  /** Reserves whose instruction was confirmed. */
  sent: Address[];
  /** Reserves dropped up front because they were already cooling down. */
  skipped: Address[];
  /** Reserves whose instruction failed this pass. */
  failed: Address[];
  /**
   * Set when the instructions could not be attributed to reserves (the kvault ix layout changed) and were
   * all sent in plain batches, ignoring cooldowns, instead. The three lists are then empty.
   */
  fallbackReason?: string;
}

/**
 * Send a vault's invest instructions so that one non-investable reserve does not block the others.
 * Instructions of reserves in cooldown are dropped. The rest go out in SDK order in batches; when a
 * batch fails for a program-level reason, its instructions are retried one reserve at a time. A failed
 * instruction enters cooldown unless it failed the minimum invest amount, or an earlier omission can cause its
 * funding failure.
 * Infrastructure failures are rethrown unchanged.
 *
 * Fails open: when the instructions cannot be attributed to reserves, all of them are sent in plain
 * batches exactly as before per-reserve isolation existed, and cooldowns are neither consulted nor started.
 */
export async function sendInvestIxsPerReserve({
  connectionPool,
  payer,
  instructions,
  lookupTables,
  vaultAddress,
  kvaultsProgramId,
  vaultReserves,
  cooldowns,
  batchSize,
  description,
  options,
  heartbeat,
  sendTx: sendTransaction = sendAndConfirmTransactionV0,
  onInvestLanded,
  logPrefix = '[investing-loop]',
  skipReserves,
}: SendInvestIxsRequest): Promise<SendInvestIxsOutcome> {
  const sendTx = withVaultLookupTableRecovery(sendTransaction);
  const plan = planReserveInstructions(instructions, kvaultsProgramId, vaultReserves);
  if ('fallbackReason' in plan) {
    logger.error(
      `${logPrefix} vault ${vaultAddress}: ${plan.fallbackReason}; sending all ${instructions.length} instruction(s) in plain batches, ignoring reserve cooldowns`
    );
    await sendInstructionBatches({
      connectionPool,
      payer,
      instructions,
      lookupTables,
      description,
      batchSize,
      options,
      heartbeat,
      sendTx,
      onBatchLanded: onInvestLanded,
    });
    return { sent: [], skipped: [], failed: [], fallbackReason: plan.fallbackReason };
  }
  const reserveIxs: ReserveIx[] = [];
  const skipped: Address[] = [];
  let earliestMissingOrdinal: number | undefined;
  for (const reserveIx of plan.reserveIxs) {
    if (cooldowns.isCoolingDown(reserveIx.reserve, vaultAddress) || skipReserves?.has(reserveIx.reserve)) {
      skipped.push(reserveIx.reserve);
      earliestMissingOrdinal =
        earliestMissingOrdinal === undefined ? reserveIx.ordinal : Math.min(earliestMissingOrdinal, reserveIx.ordinal);
    } else {
      reserveIxs.push(reserveIx);
    }
  }

  const sent: Address[] = [];
  const failed: Address[] = [];
  const recordProgramFailure = (reserveIx: ReserveIx, error: unknown): void => {
    const hasEarlierMissingInstruction =
      earliestMissingOrdinal !== undefined && earliestMissingOrdinal < reserveIx.ordinal;
    if (isPayerRoundingShortfall(error, kvaultsProgramId)) {
      // A payer funding problem: the next pass retries the reserve, after crank funding tops the payer up.
      logger.error(
        `${logPrefix} vault ${vaultAddress}: payer ${payer.address} holds too few vault tokens to pay the rounding loss of the invest into reserve ${reserveIx.reserve}; no reserve cooldown`
      );
    } else if (
      !isInvestAmountBelowMinimumFailure(error, kvaultsProgramId) &&
      (!hasEarlierMissingInstruction || !failureCanFollowMissingWithdrawalProceeds(error, kvaultsProgramId))
    ) {
      cooldowns.start(reserveIx.reserve, vaultAddress, describeProgramFailure(error));
    }
    earliestMissingOrdinal =
      earliestMissingOrdinal === undefined ? reserveIx.ordinal : Math.min(earliestMissingOrdinal, reserveIx.ordinal);
    failed.push(reserveIx.reserve);
  };
  await sendReserveBatches<{ verdict: unknown }>({ preamble: plan.preamble, reserveIxs }, batchSize, {
    sendPreamble: (preamble) =>
      sendInstructionBatches({
        connectionPool,
        payer,
        instructions: preamble,
        lookupTables,
        description,
        batchSize,
        options,
        heartbeat,
        sendTx,
      }),
    // A program verdict about one of the batch's reserve instructions is handled; infrastructure failures and verdicts
    // about other instructions are rethrown.
    send: async (batch, ixs) => {
      try {
        await whileBeating(heartbeat, () =>
          sendTx(connectionPool, payer, ixs, lookupTables, [payer], description, options)
        );
      } catch (error) {
        if (
          !isReserveAttributableFailure(error) ||
          failedOutsideInstructions(
            error,
            ixs,
            batch.map((reserveIx) => reserveIx.ix)
          )
        )
          throw error;
        return { verdict: error };
      }
      sent.push(...batch.map((r) => r.reserve));
      onInvestLanded?.();
      await yieldAndBeat(heartbeat);
      return undefined;
    },
    onBatchFailure: (batch, { verdict }) =>
      logger.warn(
        `${logPrefix} vault ${vaultAddress}: invest batch of ${batch.length} failed (${describeProgramFailure(verdict)}); retrying one reserve at a time`
      ),
    onReserveFailure: (reserveIx, { verdict }) => recordProgramFailure(reserveIx, verdict),
  });
  return { sent, skipped, failed };
}

/** The inputs of `investVaultReserves`. */
export interface InvestVaultReservesRequest {
  connectionPool: ConnectionPool;
  kaminoManager: KaminoManager;
  payer: TransactionSigner;
  kaminoVault: KaminoVault;
  ledgerInstant: LedgerInstant;
  lookupTables: Account<AddressLookupTable>[];
  cooldowns: ReserveInvestCooldowns;
  /** Log prefix of the caller, e.g. `[investing-loop]`. */
  logPrefix: string;
  /** Transaction description; also names the invest in the warning about failed or skipped reserves. */
  description: string;
  heartbeat?: LoopHeartbeat;
  sendTx?: typeof sendAndConfirmTransactionV0;
  onInvestLanded?: () => void;
  /** Deposit exclusions read after instruction construction. */
  getNoNewFundsReserves?: () => ReadonlySet<string>;
  /** The loaded reserves, to find the planned deposits. */
  vaultsReserves: Map<Address, KaminoReserve>;
  /** Resolves the shared allocation policy after the SDK reloads the vault. A failed read blocks this invest. */
  getUtilizationCap?: () => InvestUtilizationCap | undefined;
}

/**
 * Builds the vault's invest instructions and sends them per reserve, two reserves per transaction, in SDK order so the
 * disinvests go first. Logs a warning when a reserve failed or was skipped. A build or send error throws; the caller
 * decides what it skips.
 */
export async function investVaultReserves({
  connectionPool,
  kaminoManager,
  payer,
  kaminoVault,
  ledgerInstant,
  lookupTables,
  cooldowns,
  logPrefix,
  description,
  heartbeat,
  sendTx,
  onInvestLanded,
  getNoNewFundsReserves,
  vaultsReserves,
  getUtilizationCap,
}: InvestVaultReservesRequest): Promise<void> {
  const instructions = await withTimeout(
    kaminoManager.investAllReservesIxs(payer, kaminoVault, ledgerInstant),
    RPC_REQUEST_TIMEOUT_MS,
    `${logPrefix} build invest instructions ${kaminoVault.address}`
  );
  heartbeat?.();
  const utilizationCap = getUtilizationCap?.();
  const plannedReserves =
    utilizationCap === undefined
      ? vaultsReserves
      : await withTimeout(
          kaminoManager.loadVaultsReserves([kaminoVault.state!]),
          RPC_REQUEST_TIMEOUT_MS,
          `${logPrefix} refresh utilization reserves ${kaminoVault.address}`
        );
  if (utilizationCap !== undefined) heartbeat?.();
  const validationLedgerInstant =
    utilizationCap === undefined
      ? ledgerInstant
      : await withTimeout(
          getCurrentLedgerInstant(connectionPool.getRpc()),
          RPC_REQUEST_TIMEOUT_MS,
          `${logPrefix} refresh utilization ledger instant ${kaminoVault.address}`
        );
  if (utilizationCap !== undefined) heartbeat?.();
  // The SDK reloads the vault into kaminoVault.state before it plans, and funds can arrive after any earlier read, so
  // the planned deposits are found on that snapshot. The set is read now, so a danger pass that just ended counts.
  const state = kaminoVault.state!;
  const readSnapshot = () =>
    Promise.all([
      kaminoManager.getVaultComputedReservesAllocation(
        state,
        validationLedgerInstant,
        plannedReserves,
        validationLedgerInstant
      ),
      kaminoManager.getVaultHoldings(state, validationLedgerInstant, plannedReserves, validationLedgerInstant),
    ]);
  const noNewFunds = getNoNewFundsReserves?.() ?? new Set<string>();
  const snapshot = kaminoManager.getVaultReserves(state).some((reserve) => noNewFunds.has(reserve))
    ? await readSnapshot()
    : undefined;
  const skipReserves = snapshot
    ? depositsInto(noNewFunds, snapshot[0].targetReservesAllocation, snapshot[1].investedInReserves)
    : new Set<Address>();
  if (skipReserves.size > 0) {
    logger.warn(
      `${logPrefix} vault ${kaminoVault.address}: not depositing into ${skipReserves.size} reserve(s) that get no new funds: ${Array.from(skipReserves).join(', ')}`
    );
  }
  if (utilizationCap !== undefined) {
    const plan = planReserveInstructions(
      instructions,
      kaminoManager.getProgramID(),
      kaminoManager.getVaultReserves(state)
    );
    if ('fallbackReason' in plan) {
      throw new Error(`Cannot validate utilization limit for vault ${kaminoVault.address}: ${plan.fallbackReason}`);
    }
    const [allocation, holdings] =
      snapshot ??
      (await withTimeout(
        readSnapshot(),
        RPC_REQUEST_TIMEOUT_MS,
        `${logPrefix} validate utilization limit ${kaminoVault.address}`
      ));
    heartbeat?.();
    for (const { reserve: reserveAddress } of plan.reserveIxs) {
      if (cooldowns.isCoolingDown(reserveAddress, kaminoVault.address) || skipReserves.has(reserveAddress)) continue;
      const reserve = plannedReserves.get(reserveAddress);
      const targetTokens = allocation.targetReservesAllocation.get(reserveAddress);
      const currentTokens = holdings.investedInReserves.get(reserveAddress);
      if (!reserve || targetTokens === undefined || currentTokens === undefined) {
        throw new Error(
          `Cannot validate utilization limit for vault ${kaminoVault.address}: missing reserve ${reserveAddress}`
        );
      }
      if (
        !isUtilizationChangeAllowed(
          reserve,
          currentTokens,
          targetTokens,
          validationLedgerInstant,
          utilizationCap.maxUtilizationChangeBps
        )
      ) {
        throw new Error(`Current allocation exceeds utilization limit for vault ${kaminoVault.address}`);
      }
    }
  }
  const outcome = await sendInvestIxsPerReserve({
    connectionPool,
    payer,
    instructions,
    lookupTables,
    vaultAddress: kaminoVault.address,
    kvaultsProgramId: kaminoManager.getProgramID(),
    vaultReserves: kaminoManager.getVaultReserves(kaminoVault.state!),
    cooldowns,
    batchSize: 2,
    description,
    options: { reportSample: true },
    heartbeat,
    sendTx,
    onInvestLanded,
    logPrefix,
    skipReserves,
  });
  if (outcome.failed.length > 0 || outcome.skipped.length > 0) {
    logger.warn(
      `${logPrefix} ${description}: ${outcome.sent.length} reserve ix(s) sent, ${outcome.failed.length} failed, ${outcome.skipped.length} skipped (on cooldown or no new funds)`
    );
  }
}
