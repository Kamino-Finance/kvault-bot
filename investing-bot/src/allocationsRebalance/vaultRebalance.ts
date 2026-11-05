import {
  getCurrentLedgerInstant,
  KaminoManager,
  KaminoReserve,
  KaminoVault,
  LedgerInstant,
  VaultState,
} from '@kamino-finance/klend-sdk';
import { Address, IInstruction, TransactionSigner } from '@solana/kit';
import { logger } from 'kvaults-investing-bot-logger';
import { ConnectionPool } from 'kvaults-investing-bot-tx/ConnectionPool';
import {
  getTransactionV0SizeBytes,
  MAX_TRANSACTION_SIZE_BYTES,
  sendAndConfirmTransactionV0,
} from 'kvaults-investing-bot-tx/instruction';
import type { VaultRebalanceDirective } from '../danger/dangerCoordinator.js';
import { RPC_REQUEST_TIMEOUT_MS, withTimeout } from '../utils/timeout.js';
import { interruptibleSleep, LoopHeartbeat, whileBeating, yieldAndBeat } from '../utils/loop.js';
import { investVaultReserves, ReserveInvestCooldowns } from '../utils/investReserves.js';
import { loadVaultLookupTables, withVaultLookupTableRecovery } from '../libs/lut.js';
import type { InvestUtilizationCap } from '../investing/utilizationCap.js';
import {
  AllocationConfig,
  getReserveAddresses,
  validateConfiguredReserveMembership,
  VaultWithFixedReserves,
} from './rebalanceConfig.js';
import { rebalanceAllocation } from './rebalanceTypes.js';
import { buildRebalanceUniverse } from './rebalanceUniverse.js';
import { getReserveAllocationsMap } from './vaultUtils.js';
import { GridSearchBudget } from './utils/maxYieldOptimizers.js';
import { FarmData } from './dueVaults.js';
import { FinalAllocationConstraintError } from './strategies/common.js';

export interface VaultRebalanceRequest {
  kaminoManager: KaminoManager;
  kaminoVault: KaminoVault;
  allocation: AllocationConfig;
  vaultEntry: string | VaultWithFixedReserves;
  allocationAdmin: TransactionSigner;
  vaultsReserves: Map<Address, KaminoReserve>;
  directive: Extract<VaultRebalanceDirective, { skip: false }>;
  includeFarmRewards: boolean;
  /** Whether the vault's APY counts the rewards of at least one supply farm. */
  needsFarmData: boolean;
  /** Undefined when the farm states or prices failed to load this pass. */
  farmData: FarmData | undefined;
  gridSearchResolution: number;
  gridSearchBudget: GridSearchBudget;
  verbose: boolean;
  heartbeat?: LoopHeartbeat;
}

export interface VaultRebalance {
  vaultState: VaultState;
  ixs: IInstruction[];
  /** The strategy failed, so `ixs` only enforce the blacklist and may be empty. */
  strategyFailed: boolean;
  /** False when strategy limits block normal investment. Blacklist zeroing can still be sent. */
  investAllowed: boolean;
}

/**
 * Builds the vault's allocation updates. Undefined: the farm data or the vault state did not load, and the vault waits
 * for the next pass. A failed strategy returns only its blacklist enforcement, possibly none.
 */
export async function computeVaultRebalanceIxs({
  kaminoManager,
  kaminoVault,
  allocation,
  vaultEntry,
  allocationAdmin,
  vaultsReserves,
  directive,
  includeFarmRewards,
  needsFarmData,
  farmData,
  gridSearchResolution,
  gridSearchBudget,
  verbose,
  heartbeat,
}: VaultRebalanceRequest): Promise<VaultRebalance | undefined> {
  const vaultAddress = kaminoVault.address;
  if (needsFarmData && farmData === undefined) {
    logger.error(
      `[allocation-rebalance-loop] skipping vault ${vaultAddress} this pass: it counts farm rewards and the farm states or prices did not load`
    );
    return undefined;
  }
  let vaultState: VaultState;
  let currentLedgerInstant: LedgerInstant;
  try {
    vaultState = await kaminoVault.getState();
    // Yield before heavy rebalance operation
    await new Promise((resolve) => setImmediate(resolve));
    currentLedgerInstant = await withTimeout(
      getCurrentLedgerInstant(kaminoManager.getRpc()),
      RPC_REQUEST_TIMEOUT_MS,
      `[allocation-rebalance-loop] get current ledger instant ${vaultAddress}`
    );
  } catch (e) {
    // Skip this vault only; a throw out of the loop would restart it and wipe the danger baselines.
    logger.error(
      `[allocation-rebalance-loop] error reading state for vault ${vaultAddress}; skipping it this pass: ${e}`
    );
    return undefined;
  }

  try {
    if (typeof vaultEntry !== 'string') {
      validateConfiguredReserveMembership(
        vaultAddress,
        getReserveAddresses(vaultEntry.fixedReserves),
        kaminoManager.getVaultReserves(vaultState)
      );
    }
    const ixs = await rebalanceAllocation({
      kaminoManager,
      kaminoVault,
      vaultsReserves,
      allocationEntry: allocation,
      vaultEntry,
      signer: allocationAdmin,
      currentLedgerInstant,
      gridSearchResolution,
      gridSearchBudget,
      heartbeat,
      shouldIncludeFarmRewards: includeFarmRewards,
      farmsToFarmStateMap: farmData?.farmToFarmStateMap ?? new Map(),
      pricesMap: farmData?.pricesMap ?? new Map(),
      verbose,
      blacklistedReserves: directive.blacklistedReserves,
      cooldownReserves: directive.cooldownReserves,
    });
    return { vaultState, ixs, strategyFailed: false, investAllowed: true };
  } catch (error) {
    const investAllowed = !(error instanceof FinalAllocationConstraintError);
    logger.error(`[allocation-rebalance-loop] error computing rebalance for vault ${vaultAddress}: ${error}`);
    let ixs: IInstruction[];
    try {
      ixs = (
        await buildRebalanceUniverse(
          kaminoManager,
          kaminoVault,
          vaultsReserves,
          allocationAdmin,
          directive.blacklistedReserves,
          directive.cooldownReserves
        )
      ).forcedZeroIxs;
    } catch (enforcementError) {
      logger.error(
        `[allocation-rebalance-loop] could not build blacklist enforcement for vault ${vaultAddress}: ${enforcementError}`
      );
      return { vaultState, ixs: [], strategyFailed: true, investAllowed };
    }
    return { vaultState, ixs, strategyFailed: true, investAllowed };
  }
}

export enum VaultRebalanceOutcome {
  DryRun = 'dryRun',
  /** No allocation update was needed. */
  Unchanged = 'unchanged',
  /** The updates do not fit in one transaction, so none were sent. */
  TooLarge = 'tooLarge',
  SendFailed = 'sendFailed',
  /** The normal invest failed or its refreshed target failed validation. Retry the vault. */
  InvestFailed = 'investFailed',
  Sent = 'sent',
}

export interface VaultRebalanceSendRequest {
  /** Resolves the same effective policy as the allocation decision. Required even when the cap is disabled. */
  getUtilizationCap: () => InvestUtilizationCap | undefined;
  connectionPool: ConnectionPool;
  kaminoManager: KaminoManager;
  kaminoVault: KaminoVault;
  vaultState: VaultState;
  allocationAdmin: TransactionSigner;
  ixs: IInstruction[];
  /** The danger pass's blacklist. The vault is not invested while one of these reserves holds weight. */
  blacklistedReserves: ReadonlySet<string>;
  /** Reserves excluded from deposits by the danger pass. */
  noNewFundsReserves: ReadonlySet<string>;
  vaultsReserves: Map<Address, KaminoReserve>;
  dryRun: boolean;
  /** False for rejected strategy targets. The sender applies blacklist updates but does not invest. */
  investAllowed?: boolean;
  reserveInvestCooldowns: ReserveInvestCooldowns;
  heartbeat?: LoopHeartbeat;
  sendTx?: typeof sendAndConfirmTransactionV0;
  /** Waits for the weight update to settle before the invest. Resolves true when shutdown was requested. */
  settle?: (milliseconds: number) => Promise<boolean>;
}

/**
 * Sends weight updates atomically. Invests after confirmation, or when no update is needed.
 * Rechecks utilization limits and blocks investment while any blacklisted reserve holds weight.
 */
export async function sendVaultRebalance({
  connectionPool: c,
  kaminoManager,
  kaminoVault,
  vaultState,
  allocationAdmin,
  ixs,
  blacklistedReserves,
  noNewFundsReserves,
  vaultsReserves,
  dryRun,
  getUtilizationCap,
  investAllowed = true,
  reserveInvestCooldowns,
  heartbeat,
  sendTx = sendAndConfirmTransactionV0,
  settle = (milliseconds) => interruptibleSleep(milliseconds, heartbeat),
}: VaultRebalanceSendRequest): Promise<VaultRebalanceOutcome> {
  const vaultAddress = kaminoVault.address;
  if (dryRun) {
    logger.info(`[allocation-rebalance-loop] Dry run rebalancing vault ${vaultAddress}`);
    return VaultRebalanceOutcome.DryRun;
  }

  // Yield before transaction operations
  await yieldAndBeat(heartbeat);

  let outcome = VaultRebalanceOutcome.Unchanged;
  let luts: Awaited<ReturnType<typeof loadVaultLookupTables>> = [];
  try {
    luts = await loadVaultLookupTables(c.getRpc(), vaultAddress, vaultState, '[allocation-rebalance-loop]');
    const hasLut = luts.length > 0;
    if (ixs.length > 0) {
      logger.info(`[allocation-rebalance-loop] Send tx rebalancing vault ${vaultAddress}`);
      // A partly applied update would leave the vault on weights no strategy chose.
      const sizeBytes = getTransactionV0SizeBytes(allocationAdmin, ixs, luts, c.shouldMulticastJito());
      if (sizeBytes > MAX_TRANSACTION_SIZE_BYTES) {
        logger.error(
          `[allocation-rebalance-loop] the ${ixs.length} allocation update(s) of vault ${vaultAddress} need a ${sizeBytes}-byte transaction, above the ${MAX_TRANSACTION_SIZE_BYTES}-byte limit; sending none. ${hasLut ? 'The vault lookup table is not enough' : 'A vault lookup table would make them fit'}; until then the vault is not rebalanced`
        );
        return VaultRebalanceOutcome.TooLarge;
      } else {
        // This API returns a signature only after confirmation or successful ledger reconciliation. One atomic send
        // covers the entire correction; a simulation-only or missing result cannot authorize the normal invest.
        const signature = await whileBeating(heartbeat, () =>
          withVaultLookupTableRecovery(sendTx)(
            c,
            allocationAdmin,
            ixs,
            luts,
            [allocationAdmin],
            `allocation-rebalance-loop update weight allocation vault ${vaultAddress}`,
            { reportSample: true }
          )
        );
        if (!signature) {
          logger.error(
            `[allocation-rebalance-loop] No confirmed signature for allocation updates of vault ${vaultAddress}`
          );
          return VaultRebalanceOutcome.SendFailed;
        }
        outcome = VaultRebalanceOutcome.Sent;
      }
    }
  } catch (e) {
    logger.error(`[allocation-rebalance-loop] error rebalancing vault ${vaultAddress}: ${e}`);
    return VaultRebalanceOutcome.SendFailed;
  }

  if (!investAllowed) {
    logger.warn(`[allocation-rebalance-loop] Strategy limits block the invest of vault ${vaultAddress}`);
    return outcome;
  }

  // The invest runs whether or not a weight changed: with INVEST_LOOP=false it is the only path that invests new
  // deposits, and it retries an invest that failed after an earlier weight update. A weight update settles first.
  if (outcome === VaultRebalanceOutcome.Sent && (await settle(5_000))) {
    return outcome;
  }
  try {
    // Each read below can take one RPC timeout. A beat after each keeps the loop inside its heartbeat timeout.
    const reloadedState = await withTimeout(
      kaminoVault.reloadState(),
      RPC_REQUEST_TIMEOUT_MS,
      `[allocation-rebalance-loop] reload vault ${vaultAddress}`
    );
    heartbeat?.();
    // The SDK invests by on-chain weight. A blacklisted reserve keeps its weight when its zeroing failed in the danger
    // pass and did not go out above, and new deposits would flow into it.
    const weightedBlacklistedReserves = Array.from(getReserveAllocationsMap(reloadedState))
      .filter(([reserve, weight]) => blacklistedReserves.has(reserve) && weight.gt(0))
      .map(([reserve]) => reserve);
    if (weightedBlacklistedReserves.length > 0) {
      logger.error(
        `[allocation-rebalance-loop] not investing vault ${vaultAddress}: blacklisted reserve(s) still hold weight: ${weightedBlacklistedReserves.join(', ')}`
      );
      return VaultRebalanceOutcome.InvestFailed;
    }
    const investLedgerInstant = await withTimeout(
      getCurrentLedgerInstant(kaminoManager.getRpc()),
      RPC_REQUEST_TIMEOUT_MS,
      `[allocation-rebalance-loop] get invest ledger instant ${vaultAddress}`
    );
    heartbeat?.();
    await investVaultReserves({
      connectionPool: c,
      kaminoManager,
      payer: allocationAdmin,
      kaminoVault,
      ledgerInstant: investLedgerInstant,
      lookupTables: luts,
      cooldowns: reserveInvestCooldowns,
      logPrefix: '[allocation-rebalance-loop]',
      description: `allocation-rebalance-loop invest after weight update vault ${vaultAddress}`,
      heartbeat,
      sendTx,
      getNoNewFundsReserves: () => noNewFundsReserves,
      vaultsReserves,
      getUtilizationCap,
    });
  } catch (e) {
    logger.error(`[allocation-rebalance-loop] error investing vault ${vaultAddress} after its rebalance: ${e}`);
    return VaultRebalanceOutcome.InvestFailed;
  }
  return outcome;
}

/**
 * Whether the attempt counts toward the vault's rebalance frequency. A failed strategy whose blacklist enforcement went
 * out does not count, so the strategy runs again after its retry delay. A dry run counts, so it follows the frequency too.
 */
export function isRebalanceDone(outcome: VaultRebalanceOutcome, strategyFailed: boolean): boolean {
  if (strategyFailed) {
    return false;
  }
  return (
    outcome === VaultRebalanceOutcome.Sent ||
    outcome === VaultRebalanceOutcome.Unchanged ||
    outcome === VaultRebalanceOutcome.DryRun
  );
}
