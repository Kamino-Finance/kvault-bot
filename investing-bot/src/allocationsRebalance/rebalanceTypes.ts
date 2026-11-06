import { Decimal } from 'decimal.js';

import { KaminoManager, KaminoReserve, KaminoVault, LedgerInstant } from '@kamino-finance/klend-sdk';
import { Address, IInstruction, TransactionSigner } from '@solana/kit';
import { logger } from 'kvaults-investing-bot-logger';
import { FarmState } from '@kamino-finance/farms-sdk';
import type { LoopHeartbeat } from '../utils/loop.js';
import {
  AllocationWithAPY,
  AllocationWithAPYAndIxs,
  DEFAULT_GRID_SEARCH_BUDGET,
  GridSearchBudget,
  GridSearchBudgetExceededError,
  GridSearchNoFeasibleAllocationError,
} from './utils/maxYieldOptimizers.js';
import {
  AllocationConfig,
  getFixedReservesWithConfig,
  getReserveWeights,
  getVaultStrategy,
  VaultWithFixedReserves,
} from './rebalanceConfig.js';
import { buildReservesAllocationLog } from './utils/logging.js';
import { buildRebalanceUniverse } from './rebalanceUniverse.js';
import {
  getStrategy,
  resolveDriftRatePercent,
  resolveStrategyConfig,
  StrategyContext,
  StrategyDefinition,
  StrategyAllocationFilter,
} from './strategyRegistry.js';
import {
  buildAbsoluteWeightInstructions,
  buildAllocationRebalanceInstructions,
  FinalAllocationConstraintError,
  getAbsoluteWeights,
  getVaultContext,
  logAllocationResult,
} from './strategies/common.js';
import { getUnchangedAllocation, scoreWeights } from './strategies/basic.js';
import { applyDrift } from './drift.js';
import { RebalanceStrategy } from './strategies/index.js';

export { RebalanceStrategy };

export interface RebalanceAllocationRequest {
  kaminoManager: KaminoManager;
  kaminoVault: KaminoVault;
  vaultsReserves: Map<Address, KaminoReserve>;
  /** The allocation entry of the vault. With `vaultEntry`, it sets the strategy and the strategy's config. */
  allocationEntry: AllocationConfig;
  vaultEntry: string | VaultWithFixedReserves;
  signer: TransactionSigner;
  currentLedgerInstant: LedgerInstant;
  gridSearchResolution: number;
  /** Defaults to the documented defaults of GRID_SEARCH_MAX_CANDIDATES and GRID_SEARCH_MAX_MS. */
  gridSearchBudget?: GridSearchBudget;
  /** The loop heartbeat. The grid search calls it while it runs, through `GridSearchBudget.onProgress`. */
  heartbeat?: LoopHeartbeat;
  shouldIncludeFarmRewards: boolean;
  farmsToFarmStateMap?: Map<Address, FarmState>;
  pricesMap?: Map<Address, Decimal>;
  verbose?: boolean;
  blacklistedReserves?: ReadonlySet<string>;
  cooldownReserves?: ReadonlySet<string>;
}

/** Adds the vault context (state, holdings, projection inputs) to the strategy inputs. */
export async function buildStrategyContext(inputs: Omit<StrategyContext, 'vaultContext'>): Promise<StrategyContext> {
  const vaultContext = await getVaultContext(
    inputs.kaminoManager,
    inputs.kaminoVault,
    inputs.healthyVaultsReserves,
    inputs.currentLedgerInstant,
    inputs.allVaultReserves,
    inputs.cooldownReserves,
    inputs.blacklistedReserves
  );
  return { ...inputs, vaultContext };
}

/**
 * Target, then drift, then instructions. A strategy with preserved accounting goes through the constrained builder;
 * one without writes its absolute weights.
 */
export async function computeStrategyAllocation(
  definition: StrategyDefinition,
  ctx: StrategyContext,
  signer: TransactionSigner
): Promise<AllocationWithAPYAndIxs> {
  let allocationFilter: StrategyAllocationFilter | undefined;
  try {
    const filter = definition.getAllocationFilter?.(ctx);
    allocationFilter =
      filter &&
      ((weights) => {
        try {
          return filter(weights);
        } catch (cause) {
          throw new FinalAllocationConstraintError(ctx.kaminoVault.address, { cause });
        }
      });
  } catch (cause) {
    throw new FinalAllocationConstraintError(ctx.kaminoVault.address, { cause });
  }
  const assertCurrentAllocationIsAllowed = () => {
    if (allocationFilter && !allocationFilter(new Map(ctx.vaultContext.healthyWeights))) {
      throw new FinalAllocationConstraintError(ctx.kaminoVault.address);
    }
  };
  // Keep current weights after search-budget exhaustion or failed evaluations. Propagate other errors.
  const target = await definition.computeTarget(ctx).catch((error: unknown) => {
    const vaultAddress = ctx.kaminoVault.address.toString();
    if (error instanceof GridSearchBudgetExceededError) {
      logger.error(
        `[allocation-rebalance-loop] grid search budget exceeded for vault ${vaultAddress}: ${error.candidatesCounted} candidates in ${error.elapsedMs} ms (${error.reservesCount} reserves, resolution ${error.coarseResolution}, phase ${error.phase}); keeping the current allocation this pass`
      );
      return 'unchanged' as const;
    }
    if (error instanceof GridSearchNoFeasibleAllocationError) {
      logger.error(
        `[allocation-rebalance-loop] ${error.message} for vault ${vaultAddress}; keeping the current allocation this pass`
      );
      return 'unchanged' as const;
    }
    assertCurrentAllocationIsAllowed();
    throw error;
  });
  if (target === 'unchanged') {
    assertCurrentAllocationIsAllowed();
    return { ixns: [], bestAllocation: await getUnchangedAllocation(ctx) };
  }
  // Drift and the builders read one weight per healthy reserve of the vault; a missing one would be dropped or
  // absorbed by the others.
  for (const reserve of ctx.vaultContext.healthyWeights.keys()) {
    if (!target.weights.has(reserve)) {
      throw new Error(
        `Strategy ${definition.name} returned no target weight for reserve ${reserve} of vault ${ctx.kaminoVault.address.toString()}`
      );
    }
  }
  let bestAllocation: AllocationWithAPY = {
    reservesWithAllocation: target.weights,
    apy: target.apy ?? new Decimal(0),
  };
  if (definition.behaviours.supportsDrift && ctx.driftRatePercent !== undefined) {
    const drift = await (definition.applyDrift
      ? definition.applyDrift(ctx, target, ctx.driftRatePercent)
      : applyDrift(definition.name, ctx, target, ctx.driftRatePercent));
    if (drift.stayPut) {
      assertCurrentAllocationIsAllowed();
      return { ixns: [], bestAllocation: drift.allocation };
    }
    bestAllocation = drift.allocation;
  }
  // The logs and the APY read the weights the builder writes.
  if (!definition.behaviours.preservedAccounting) {
    const reservesWithAllocation = getAbsoluteWeights(ctx.vaultContext, bestAllocation.reservesWithAllocation);
    const writtenAllocation = { reservesWithAllocation, apy: await scoreWeights(ctx, reservesWithAllocation) };
    logAllocationResult(ctx.kaminoVault, definition.name, writtenAllocation);
    const ixns = await buildAbsoluteWeightInstructions(ctx, reservesWithAllocation, signer);
    return { ixns, bestAllocation: writtenAllocation };
  }
  // The constraint pass can clamp a weight, and it rounds every weight; when it stays put, the vault keeps its weights.
  const { ixns, weights } = await buildAllocationRebalanceInstructions(ctx, bestAllocation, signer, allocationFilter);
  return { ixns, bestAllocation: { reservesWithAllocation: weights, apy: await scoreWeights(ctx, weights) } };
}

// abstraction for rebalancing the allocation of a vault
export async function rebalanceAllocation({
  kaminoManager,
  kaminoVault,
  vaultsReserves,
  allocationEntry,
  vaultEntry,
  signer,
  currentLedgerInstant,
  gridSearchResolution,
  gridSearchBudget = DEFAULT_GRID_SEARCH_BUDGET,
  heartbeat,
  shouldIncludeFarmRewards,
  farmsToFarmStateMap,
  pricesMap,
  verbose = false,
  blacklistedReserves = new Set(),
  cooldownReserves = new Set(),
}: RebalanceAllocationRequest): Promise<IInstruction[]> {
  const strategy = getVaultStrategy(vaultEntry, allocationEntry.strategy);
  const definition = getStrategy(strategy);
  if (!definition) {
    throw new Error(`Rebalance strategy ${strategy} not implemented`);
  }
  let logMsg = `[allocation-rebalance-loop] Rebalancing allocation for vault ${kaminoVault.address.toString()} with strategy ${strategy}; `;
  const rebalanceUniverse = await buildRebalanceUniverse(
    kaminoManager,
    kaminoVault,
    vaultsReserves,
    signer,
    blacklistedReserves,
    cooldownReserves
  );
  if (rebalanceUniverse.blacklistedVaultReserves.size > 0) {
    logger.warn(
      `[allocation-rebalance-loop] Rebalance universe for vault ${kaminoVault.address.toString()} excludes ${
        rebalanceUniverse.blacklistedVaultReserves.size
      } blacklisted reserve(s)`
    );
  }
  if (rebalanceUniverse.cooldownVaultReserves.size > 0) {
    logger.warn(
      `[allocation-rebalance-loop] Rebalance universe for vault ${kaminoVault.address.toString()} excludes ${
        rebalanceUniverse.cooldownVaultReserves.size
      } reserve(s) in reinvest cooldown (no new allocation this pass)`
    );
  }
  const config = resolveStrategyConfig(definition, allocationEntry, vaultEntry);
  const ctx = await buildStrategyContext({
    kaminoManager,
    kaminoVault,
    healthyVaultsReserves: rebalanceUniverse.healthyVaultReserves,
    allVaultReserves: vaultsReserves,
    blacklistedReserves: rebalanceUniverse.blacklistedVaultReserves,
    cooldownReserves: rebalanceUniverse.cooldownVaultReserves,
    currentLedgerInstant,
    gridSearchResolution,
    gridSearchBudget: heartbeat ? { ...gridSearchBudget, onProgress: () => heartbeat() } : gridSearchBudget,
    shouldIncludeFarmRewards,
    farmsToFarmStateMap,
    pricesMap,
    verbose,
    config,
    fixedReservesConfig: getFixedReservesWithConfig(vaultEntry),
    fixedReservesWeights: definition.behaviours.fixedReserveWeights ? getReserveWeights(vaultEntry) : undefined,
    driftRatePercent: resolveDriftRatePercent(definition, config),
  });
  const allocationWithIxsAndApy = await computeStrategyAllocation(definition, ctx, signer);

  try {
    logMsg += await buildReservesAllocationLog(ctx, allocationWithIxsAndApy.bestAllocation);
    logger.info(logMsg);
  } catch (error) {
    logger.warn(
      `[allocation-rebalance-loop] Failed to build allocation log for vault ${kaminoVault.address.toString()}: ${error}`
    );
  }

  // Strategies only see healthy reserves; forced-zero ixs enforce blacklist state on-chain. They go first, so the
  // blacklist enforcement never waits on a strategy update.
  return [...rebalanceUniverse.forcedZeroIxs, ...allocationWithIxsAndApy.ixns];
}
