import { Decimal } from 'decimal.js';

import {
  KaminoManager,
  KaminoReserve,
  KaminoVault,
  LedgerInstant,
  lamportsToDecimal,
  U64_MAX,
  VaultState,
} from '@kamino-finance/klend-sdk';
import { Address, IInstruction, TransactionSigner } from '@solana/kit';
import { logger } from 'kvaults-investing-bot-logger';
import BN from 'bn.js';
import { AllocationWithAPY, getYieldSimulation } from '../utils/maxYieldOptimizers.js';
import {
  computeVaultTargetAllocation,
  simulateVaultYield,
  VaultAllocationProjectionContext,
} from '../utils/allocationHelper.js';
import {
  AllocationWeightBounds,
  applyReserveConstraints,
  calculateReserveAllocationWeightBounds,
  calculateTotalWeight,
  getTargetTokenConstraintType,
  normalizeWeightsToTotal,
  redistributeWeightDifferenceWithinBounds,
  ReserveConstraints,
} from '../utils/allocationConstraints.js';
import { buildWeightUpdateIx, getReserveAllocationsMap, getVaultAllocationForReserve } from '../vaultUtils.js';
import { filterToUniverse } from '../rebalanceUniverse.js';
import { MIN_ALLOCATION_WEIGHT_TOTAL } from '../consts.js';
import type { StrategyContext } from '../strategyRegistry.js';

/**
 * Common vault context needed for allocation strategies
 */
export interface VaultContext {
  vaultState: VaultState;
  /** The weight total the pipeline writes for the reserves outside reinvest cooldown (see getAllocationWeightTotal). */
  totalAllocationsWeights: Decimal;
  /** The whole factor the vault's on-chain weights are raised by; 1 keeps them. */
  weightScale: Decimal;
  /** The on-chain weights of the healthy reserves, in vault order. */
  healthyWeights: ReadonlyMap<Address, Decimal>;
  /** AUM available to the optimizer, excluding holdings in preserved reserves, in tokens. */
  vaultAUMTokens: Decimal;
  investedInReservesTokensMap: Map<Address, Decimal>;
  allInvestedInReservesTokensMap: Map<Address, Decimal>;
  allocationProjectionContext: VaultAllocationProjectionContext;
}

export interface AllocationWeightTotal {
  /** The weight total the pipeline writes for the reserves outside reinvest cooldown. */
  total: Decimal;
  /** The whole factor the vault's on-chain weights are raised by; 1 keeps them. */
  scale: Decimal;
}

/**
 * The reserve weight total the pipeline writes. It keeps the vault's total, so the share the vault leaves unallocated
 * stays the same: the allocation admin cannot change `unallocatedWeight`. A vault with no unallocated weight and a total
 * under MIN_ALLOCATION_WEIGHT_TOTAL has its weights raised by a whole factor, so a weight unit is a finer share and
 * rounding moves less. The raise waits while a reserve in reinvest cooldown holds weight, because it would rewrite it.
 */
export function getAllocationWeightTotal(
  vaultState: VaultState,
  preservedReserves: ReadonlySet<string>
): AllocationWeightTotal {
  const vaultWeights = getReserveAllocationsMap(vaultState);
  const vaultWeight = calculateTotalWeight(vaultWeights);
  const rebalancedWeight = calculateTotalWeight(
    new Map([...vaultWeights].filter(([reserve]) => !preservedReserves.has(reserve.toString())))
  );
  const canRaise =
    new Decimal(vaultState.unallocatedWeight.toString()).eq(0) &&
    rebalancedWeight.eq(vaultWeight) &&
    vaultWeight.gt(0) &&
    vaultWeight.lt(MIN_ALLOCATION_WEIGHT_TOTAL);
  if (!canRaise) {
    return { total: rebalancedWeight, scale: new Decimal(1) };
  }
  const scale = new Decimal(MIN_ALLOCATION_WEIGHT_TOTAL).div(vaultWeight).ceil();
  return { total: rebalancedWeight.mul(scale), scale };
}

function getRebalancedVaultAUMTokens(
  totalVaultAUMTokens: Decimal,
  investedInReservesTokens: ReadonlyMap<Address, Decimal>,
  preservedReserves: ReadonlySet<string>
): Decimal {
  let rebalancedVaultAUMTokens = totalVaultAUMTokens;
  for (const [reserve, investedTokens] of investedInReservesTokens) {
    if (preservedReserves.has(reserve.toString())) {
      rebalancedVaultAUMTokens = rebalancedVaultAUMTokens.sub(investedTokens);
    }
  }
  return Decimal.max(rebalancedVaultAUMTokens, 0);
}

/**
 * Extracts common vault context needed for allocation strategies
 */
export async function getVaultContext(
  kaminoManager: KaminoManager,
  kaminoVault: KaminoVault,
  optimizationReserves: Map<Address, KaminoReserve>,
  currentLedgerInstant: LedgerInstant,
  allVaultReserves: Map<Address, KaminoReserve> = optimizationReserves,
  preservedReserves: ReadonlySet<string> = new Set(),
  forcedZeroReserves: ReadonlySet<string> = new Set()
): Promise<VaultContext> {
  const vaultState = await kaminoVault.getState();
  const { total: totalAllocationsWeights, scale: weightScale } = getAllocationWeightTotal(
    vaultState,
    preservedReserves
  );

  const vaultHoldings = await kaminoManager.getVaultHoldings(
    vaultState,
    currentLedgerInstant,
    allVaultReserves,
    currentLedgerInstant
  );
  const totalVaultAUMTokens = Decimal.max(vaultHoldings.totalAUMIncludingFees.sub(vaultHoldings.pendingFees ?? 0), 0);
  const vaultAUMTokens = getRebalancedVaultAUMTokens(
    totalVaultAUMTokens,
    vaultHoldings.investedInReserves,
    preservedReserves
  );
  const investedInReservesTokensMap = filterToUniverse(vaultHoldings.investedInReserves, optimizationReserves);
  const currentVaultAllocations = kaminoManager.getVaultAllocations(vaultState);

  return {
    vaultState,
    totalAllocationsWeights,
    weightScale,
    healthyWeights: filterToUniverse(getReserveAllocationsMap(vaultState), optimizationReserves),
    vaultAUMTokens,
    investedInReservesTokensMap,
    allInvestedInReservesTokensMap: vaultHoldings.investedInReserves,
    allocationProjectionContext: {
      vaultState,
      // The SDK mirrors the contract and projects every configured reserve, including preserved ones.
      vaultAUMTokens: totalVaultAUMTokens,
      currentVaultAllocations,
      allVaultReserves,
      currentLedgerInstant,
      forcedZeroReserves,
    },
  };
}

/**
 * Logs allocation strategy results with consistent formatting
 */
export function logAllocationResult(
  kaminoVault: KaminoVault,
  strategyName: string,
  allocation: AllocationWithAPY,
  stabilizationFactor?: Decimal
): void {
  let logMsg = `[allocation-rebalance-loop] Rebalancing allocation for vault ${kaminoVault.address.toString()}; strategy: ${strategyName}`;

  if (stabilizationFactor !== undefined) {
    logMsg += `; stabilization factor: ${stabilizationFactor.toString()}`;
  }

  logMsg += `; apy: ${allocation.apy.toString()}; Allocations: `;

  allocation.reservesWithAllocation.forEach((weight, reserve) => {
    logMsg += `Reserve ${reserve.toString()} weight: ${weight.toString()}; `;
  });

  logger.info(logMsg);
}

/**
 * Build the per-reserve inputs to `applyReserveConstraints` that do NOT depend on the candidate
 * target weight. Extracted so the same deposit/withdrawal-cap logic backs both the instruction
 * builder below and the MAX_YIELD_DRIPPING utilization filter — a single source of truth for "would
 * this deposit/withdrawal hit a chain-side reserve constraint".
 */
export function buildReserveConstraintsBase(
  reserveAddress: Address,
  reserve: KaminoReserve,
  currentWeight: Decimal,
  investedTokensInReserve: Decimal,
  currentLedgerInstant: LedgerInstant
): Omit<ReserveConstraints, 'targetWeight'> {
  const decimals = reserve.state.liquidity.mintDecimals.toNumber();
  const withdrawalCapDisabled = reserve.state.config.depositWithdrawalCap.configIntervalLengthSeconds.toNumber() === 0;
  return {
    reserve: reserveAddress,
    currentWeight,
    investedTokensInReserve,
    depositLimitTokens: reserve.state.config.depositLimit.eq(new BN(U64_MAX))
      ? null
      : lamportsToDecimal(reserve.state.config.depositLimit.toString(), decimals),
    currentTotalSupplyInReserveTokens: lamportsToDecimal(
      reserve.getEstimatedTotalSupply(currentLedgerInstant, 0).toString(),
      decimals
    ),
    availableLiquidityInReserveTokens: lamportsToDecimal(
      reserve.getFreelyAvailableLiquidityAmount(currentLedgerInstant, 0).toString(),
      decimals
    ),
    reserveWithdrawalCapCapacityTokens: withdrawalCapDisabled
      ? null
      : lamportsToDecimal(reserve.getDepositWithdrawalCapCapacity().toString(), decimals),
    reserveWithdrawalCapCurrentTokens: withdrawalCapDisabled
      ? null
      : lamportsToDecimal(
          reserve.getDepositWithdrawalCapCurrent(Number(currentLedgerInstant.blockTime)).toString(),
          decimals
        ),
  };
}

/**
 * The APY of `weights` over the healthy reserves, with the same farms-aware computation the grid search uses to
 * score candidates. The caller guarantees a positive weight total.
 */
export async function computeWeightsApy(ctx: StrategyContext, weights: Map<Address, Decimal>): Promise<Decimal> {
  const proposedWeights = new Map<Address, Decimal>();
  for (const reserve of ctx.vaultContext.healthyWeights.keys()) {
    proposedWeights.set(reserve, weights.get(reserve) ?? new Decimal(0));
  }
  return (await simulateVaultYield(proposedWeights, getYieldSimulation(ctx))).apy;
}

/** The strategy inputs the instruction builders read. */
export type InstructionBuilderContext = Pick<
  StrategyContext,
  'kaminoManager' | 'kaminoVault' | 'healthyVaultsReserves' | 'vaultContext' | 'currentLedgerInstant'
>;

/**
 * The weights a strategy without preserved accounting writes: `targetWeights` scaled to the vault's weight total (see
 * getAllocationWeightTotal), which keeps the strategy's shares and the share the vault leaves unallocated. An
 * unallocated vault, or an all-zero target, keeps the target as the strategy set it.
 */
export function getAbsoluteWeights(
  vaultContext: VaultContext,
  targetWeights: Map<Address, Decimal>
): Map<Address, Decimal> {
  const weightTotal = vaultContext.totalAllocationsWeights;
  return weightTotal.gt(0) && calculateTotalWeight(targetWeights).gt(0)
    ? normalizeWeightsToTotal(targetWeights, weightTotal)
    : targetWeights;
}

/**
 * Builds one update per reserve whose weight in `weights` (see getAbsoluteWeights) differs from its on-chain weight. No
 * constraints apply.
 */
export async function buildAbsoluteWeightInstructions(
  ctx: InstructionBuilderContext,
  weights: Map<Address, Decimal>,
  signer: TransactionSigner
): Promise<IInstruction[]> {
  const { kaminoManager, kaminoVault, healthyVaultsReserves, vaultContext } = ctx;
  const { vaultState } = vaultContext;
  const allocationRebalanceIxs: IInstruction[] = [];
  for (const [reserve, targetWeight] of weights) {
    const kaminoReserveState = healthyVaultsReserves.get(reserve);
    if (!kaminoReserveState) {
      throw new Error(`Reserve ${reserve} not found`);
    }
    const weight = Math.round(targetWeight.toNumber());
    const updateIx = await buildWeightUpdateIx(
      kaminoManager,
      kaminoVault,
      vaultState,
      { address: reserve, state: kaminoReserveState.state },
      weight,
      signer
    );
    if (updateIx) {
      logger.info(
        `[allocation-rebalance-loop] Updating reserve allocation for vault ${kaminoVault.address.toString()} with reserve ${reserve} to weight ${weight}`
      );
      allocationRebalanceIxs.push(updateIx);
    }
  }
  return allocationRebalanceIxs;
}

/** The update instructions and the healthy reserve weights the vault holds once they land. */
export interface WeightUpdate {
  ixns: IInstruction[];
  weights: Map<Address, Decimal>;
}

export class FinalAllocationConstraintError extends Error {
  constructor(vaultAddress: Address, options?: ErrorOptions) {
    super(
      options
        ? `Cannot validate strategy limits for vault ${vaultAddress}`
        : `Final allocation exceeds strategy limits for vault ${vaultAddress}`,
      options
    );
    this.name = 'FinalAllocationConstraintError';
  }
}

/**
 * Builds allocation rebalance instructions from allocation results. When it stays put, it returns no instructions and
 * the current weights.
 */
export async function buildAllocationRebalanceInstructions(
  ctx: InstructionBuilderContext,
  proposedAllocation: AllocationWithAPY,
  signer: TransactionSigner,
  allocationFilter?: (weights: Map<Address, Decimal>) => boolean
): Promise<WeightUpdate> {
  const { kaminoManager, kaminoVault, healthyVaultsReserves, vaultContext, currentLedgerInstant } = ctx;
  const { vaultState, allocationProjectionContext } = vaultContext;
  const investedInReservesTokens = vaultContext.allInvestedInReservesTokensMap;
  const allocationRebalanceIxs: IInstruction[] = [];
  const stayPut = (): WeightUpdate => {
    const weights = new Map(vaultContext.healthyWeights);
    if (allocationFilter && !allocationFilter(weights)) {
      throw new FinalAllocationConstraintError(kaminoVault.address);
    }
    return { ixns: [], weights };
  };

  // Redistribute blacklisted weight across the active universe, but leave cooldown
  // weight untouched because that reserve remains configured and invested.
  const totalTargetWeight = vaultContext.totalAllocationsWeights;
  const weightsForAUMProjection = totalTargetWeight.gt(0)
    ? normalizeWeightsToTotal(proposedAllocation.reservesWithAllocation, totalTargetWeight)
    : proposedAllocation.reservesWithAllocation;
  const projectedUnallocatedTokens = computeVaultTargetAllocation(
    weightsForAUMProjection,
    allocationProjectionContext
  ).targetUnallocatedAmount;
  // Weight bounds apply only to tokens the SDK projects into reserves; including the unallocated
  // target would inflate every reserve's proportional token target.
  const aumTokens = Decimal.max(vaultContext.vaultAUMTokens.sub(projectedUnallocatedTokens), 0);

  // Create a copy of the allocation to modify
  const adjustedAllocation = new Map<Address, Decimal>();
  for (const [reserve, weight] of proposedAllocation.reservesWithAllocation) {
    adjustedAllocation.set(reserve, weight);
  }

  // First pass: derive every reserve's safe interval and clamp direct violations
  const weightBounds = new Map<Address, AllocationWeightBounds>();
  const baseConstraints = new Map<Address, Omit<ReserveConstraints, 'targetWeight'>>();

  for (const [reserveToUpdate, targetWeight] of adjustedAllocation) {
    const allocForReserve = getVaultAllocationForReserve(vaultState, reserveToUpdate);
    if (!allocForReserve) {
      logger.error(`Reserve ${reserveToUpdate} not found in vault allocation`);
      continue;
    }

    const investedTokensInReserve = investedInReservesTokens.get(reserveToUpdate);
    if (!investedTokensInReserve) {
      logger.error(`Reserve ${reserveToUpdate} not found in vault holdings`);
      continue;
    }

    const reserve = healthyVaultsReserves.get(reserveToUpdate);
    if (!reserve) {
      logger.error(`Reserve ${reserveToUpdate} not found in vault reserves`);
      continue;
    }

    // Match the weight scale selected for this pass.
    const currentWeight = new Decimal(allocForReserve.targetAllocationWeight.toString()).mul(vaultContext.weightScale);

    // Build constraints object (shared with the MAX_YIELD_DRIPPING utilization filter).
    const base = buildReserveConstraintsBase(
      reserveToUpdate,
      reserve,
      currentWeight,
      investedTokensInReserve,
      currentLedgerInstant
    );
    baseConstraints.set(reserveToUpdate, base);
    const constraints: ReserveConstraints = { ...base, targetWeight };
    weightBounds.set(
      reserveToUpdate,
      calculateReserveAllocationWeightBounds(constraints, aumTokens, totalTargetWeight)
    );

    // Apply constraints
    const constraintResult = applyReserveConstraints(constraints, aumTokens, totalTargetWeight);

    if (constraintResult.constraintHit) {
      adjustedAllocation.set(reserveToUpdate, constraintResult.adjustedWeight);

      logger.info(
        `Reserve ${reserveToUpdate} ${constraintResult.constraintType} constraint: target=${targetWeight}, adjusted=${constraintResult.adjustedWeight}, delta=${constraintResult.adjustedWeight.sub(targetWeight)}`
      );
    }
  }

  // Preserve the existing bootstrap behavior for vaults whose current total is zero.
  let finalAllocation = adjustedAllocation;
  if (totalTargetWeight.gt(0)) {
    if (weightBounds.size !== adjustedAllocation.size) {
      logger.warn(`[allocation-rebalance-loop] Cannot derive reserve bounds for every allocation. Staying put.`);
      return stayPut();
    }
    const redistributionResult = redistributeWeightDifferenceWithinBounds(
      adjustedAllocation,
      totalTargetWeight,
      weightBounds
    );
    if (!redistributionResult.isFeasible) {
      logger.warn(
        `[allocation-rebalance-loop] Cannot conserve total allocation weight ${totalTargetWeight} within reserve deposit and withdrawal bounds. Staying put.`
      );
      return stayPut();
    }
    finalAllocation = redistributionResult.allocation;
  }

  const writtenWeights = new Map(
    [...finalAllocation].map(([reserve, weight]) => [reserve, new Decimal(Math.round(weight.toNumber()))])
  );
  const targetAllocation = computeVaultTargetAllocation(writtenWeights, allocationProjectionContext);
  for (const [reserveAddress] of writtenWeights) {
    const reserve = healthyVaultsReserves.get(reserveAddress);
    const allocForReserve = getVaultAllocationForReserve(vaultState, reserveAddress);
    if (!reserve || !allocForReserve) {
      logger.warn(
        `[allocation-rebalance-loop] Cannot validate canonical target for reserve ${reserveAddress}. Staying put.`
      );
      return stayPut();
    }
    const constraints =
      baseConstraints.get(reserveAddress) ??
      buildReserveConstraintsBase(
        reserveAddress,
        reserve,
        new Decimal(allocForReserve.targetAllocationWeight.toString()),
        investedInReservesTokens.get(reserveAddress) ?? new Decimal(0),
        currentLedgerInstant
      );
    const targetTokens = targetAllocation.targetReservesAllocation.get(reserveAddress) ?? new Decimal(0);
    const constraintType = getTargetTokenConstraintType(constraints, targetTokens);
    if (constraintType !== 'none') {
      logger.warn(
        `[allocation-rebalance-loop] Canonical target ${targetTokens} for reserve ${reserveAddress} exceeds its ${constraintType} capacity. Staying put.`
      );
      return stayPut();
    }
  }

  if (allocationFilter && !allocationFilter(writtenWeights)) {
    throw new FinalAllocationConstraintError(kaminoVault.address);
  }

  // Log redistribution results
  for (const [reserve, weight] of finalAllocation) {
    const originalWeight = proposedAllocation.reservesWithAllocation.get(reserve)!;
    if (!weight.eq(originalWeight)) {
      logger.info(`Reserve ${reserve} final weight: ${originalWeight} -> ${weight}`);
    }
  }

  // Final pass: build instructions with adjusted weights. The validation above found every reserve.
  for (const [reserveToUpdate, adjustedWeight] of writtenWeights) {
    const weight = adjustedWeight.toNumber();
    const updateIx = await buildWeightUpdateIx(
      kaminoManager,
      kaminoVault,
      vaultState,
      { address: reserveToUpdate, state: healthyVaultsReserves.get(reserveToUpdate)!.state },
      weight,
      signer
    );
    if (updateIx) {
      allocationRebalanceIxs.push(updateIx);
    }
  }

  return { ixns: allocationRebalanceIxs, weights: writtenWeights };
}
