import { Decimal } from 'decimal.js';

import {
  KaminoManager,
  KaminoReserve,
  KaminoVault,
  lamportsToDecimal,
  ReserveAllocationConfig,
  ReserveWithAddress,
  U64_MAX,
  VaultState,
} from '@kamino-finance/klend-sdk';
import { Address, IInstruction, Slot, TransactionSigner } from '@solana/kit';
import { logger } from 'kvaults-investing-bot-logger';
import BN from 'bn.js';
import { AllocationWithAPY } from '../utils/maxYieldOptimizers.js';
import {
  computeVaultTargetAllocation,
  getVaultTotalAllocationsWeights,
  VaultAllocationProjectionContext,
} from '../utils/allocationHelper.js';
import {
  AllocationWeightBounds,
  applyReserveConstraints,
  calculateReserveAllocationWeightBounds,
  getTargetTokenConstraintType,
  normalizeWeightsToTotal,
  redistributeWeightDifferenceWithinBounds,
  ReserveConstraints,
} from '../utils/allocationConstraints.js';
import {
  getAllocationCapInTokensOrDefault,
  getVaultAllocationForReserve,
  shouldUpdateAllocation,
} from '../vaultUtils.js';
import { getInvestedReservesForUniverse } from '../rebalanceUniverse.js';

/**
 * Common vault context needed for allocation strategies
 */
export interface VaultContext {
  vaultState: VaultState;
  totalAllocationsWeights: Decimal;
  vaultAUMTokens: Decimal;
  investedInReservesTokensMap: Map<Address, Decimal>;
  allInvestedInReservesTokensMap: Map<Address, Decimal>;
  allocationProjectionContext: VaultAllocationProjectionContext;
}

function getRebalancedAllocationWeight(vaultState: VaultState, preservedReserves: ReadonlySet<string>): Decimal {
  let rebalancedWeight = getVaultTotalAllocationsWeights(vaultState);
  for (const allocation of vaultState.vaultAllocationStrategy) {
    if (preservedReserves.has(allocation.reserve.toString())) {
      rebalancedWeight = rebalancedWeight.sub(allocation.targetAllocationWeight.toString());
    }
  }
  return rebalancedWeight;
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
  currentSlot: Slot,
  allVaultReserves: Map<Address, KaminoReserve> = optimizationReserves,
  preservedReserves: ReadonlySet<string> = new Set(),
  forcedZeroReserves: ReadonlySet<string> = new Set()
): Promise<VaultContext> {
  const vaultState = await kaminoVault.getState();
  const totalAllocationsWeights = getRebalancedAllocationWeight(vaultState, preservedReserves);

  const vaultHoldings = await kaminoManager.getVaultHoldings(vaultState, currentSlot, allVaultReserves, currentSlot);
  const totalVaultAUMTokens = Decimal.max(vaultHoldings.totalAUMIncludingFees.sub(vaultHoldings.pendingFees ?? 0), 0);
  const vaultAUMTokens = getRebalancedVaultAUMTokens(
    totalVaultAUMTokens,
    vaultHoldings.investedInReserves,
    preservedReserves
  );
  const investedInReservesTokensMap = getInvestedReservesForUniverse(
    vaultHoldings.investedInReserves,
    optimizationReserves
  );
  const currentVaultAllocations = kaminoManager.getVaultAllocations(vaultState);

  return {
    vaultState,
    totalAllocationsWeights,
    vaultAUMTokens,
    investedInReservesTokensMap,
    allInvestedInReservesTokensMap: vaultHoldings.investedInReserves,
    allocationProjectionContext: {
      vaultState,
      // The SDK mirrors the contract and projects every configured reserve, including preserved ones.
      vaultAUMTokens: totalVaultAUMTokens,
      currentVaultAllocations,
      allVaultReserves,
      currentSlot,
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
  reservesWithMinAllocation: Address[],
  stabilizationFactor?: Decimal
): void {
  let strategyString = strategyName;
  if (reservesWithMinAllocation.length > 0) {
    strategyString = `${strategyName}_WITH_FIXED_RESERVES`;
  }

  let logMsg = `[allocation-rebalance-loop] Rebalancing allocation for vault ${kaminoVault.address.toString()}; strategy: ${strategyString}`;

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
  currentSlot: Slot,
  currentUnixTimestamp: number
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
      reserve.getEstimatedTotalSupply(currentSlot, 0).toString(),
      decimals
    ),
    availableLiquidityInReserveTokens: lamportsToDecimal(
      reserve.getFreelyAvailableLiquidityAmount(currentSlot).toString(),
      decimals
    ),
    reserveWithdrawalCapCapacityTokens: withdrawalCapDisabled
      ? null
      : lamportsToDecimal(reserve.getDepositWithdrawalCapCapacity().toString(), decimals),
    reserveWithdrawalCapCurrentTokens: withdrawalCapDisabled
      ? null
      : lamportsToDecimal(reserve.getDepositWithdrawalCapCurrent(currentUnixTimestamp).toString(), decimals),
  };
}

/**
 * Builds allocation rebalance instructions from allocation results
 */
export async function buildAllocationRebalanceInstructions(
  kaminoManager: KaminoManager,
  kaminoVault: KaminoVault,
  vaultState: VaultState,
  vaultsReserves: Map<Address, KaminoReserve>,
  proposedAllocation: AllocationWithAPY,
  signer: TransactionSigner,
  currentSlot: Slot,
  currentUnixTimestamp: number,
  allVaultReserves: Map<Address, KaminoReserve> = vaultsReserves,
  preservedReserves: ReadonlySet<string> = new Set(),
  forcedZeroReserves: ReadonlySet<string> = new Set()
): Promise<IInstruction[]> {
  const allocationRebalanceIxs: IInstruction[] = [];

  const vaultHoldings = await kaminoManager.getVaultHoldings(vaultState, currentSlot, allVaultReserves, currentSlot);
  const investedInReservesTokens = vaultHoldings.investedInReserves;
  const totalVaultAUMTokens = Decimal.max(vaultHoldings.totalAUMIncludingFees.sub(vaultHoldings.pendingFees), 0);
  const rebalancedVaultAUMTokens = getRebalancedVaultAUMTokens(
    totalVaultAUMTokens,
    investedInReservesTokens,
    preservedReserves
  );

  // Redistribute blacklisted weight across the active universe, but leave cooldown
  // weight untouched because that reserve remains configured and invested.
  const totalTargetWeight = getRebalancedAllocationWeight(vaultState, preservedReserves);
  const weightsForAUMProjection = totalTargetWeight.gt(0)
    ? normalizeWeightsToTotal(proposedAllocation.reservesWithAllocation, totalTargetWeight)
    : proposedAllocation.reservesWithAllocation;
  const projectedUnallocatedTokens = computeVaultTargetAllocation(weightsForAUMProjection, {
    vaultState,
    vaultAUMTokens: totalVaultAUMTokens,
    currentVaultAllocations: kaminoManager.getVaultAllocations(vaultState),
    allVaultReserves,
    currentSlot,
    forcedZeroReserves,
  }).targetUnallocatedAmount;
  // Weight bounds apply only to tokens the SDK projects into reserves; including the unallocated
  // target would inflate every reserve's proportional token target.
  const aumTokens = Decimal.max(rebalancedVaultAUMTokens.sub(projectedUnallocatedTokens), 0);

  // Create a copy of the allocation to modify
  const adjustedAllocation = new Map<Address, Decimal>();
  for (const [reserve, weight] of proposedAllocation.reservesWithAllocation) {
    adjustedAllocation.set(reserve, weight);
  }

  // First pass: derive every reserve's safe interval and clamp direct violations
  const weightBounds = new Map<Address, AllocationWeightBounds>();

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

    const reserve = vaultsReserves.get(reserveToUpdate);
    if (!reserve) {
      logger.error(`Reserve ${reserveToUpdate} not found in vault reserves`);
      continue;
    }

    const currentWeight = new Decimal(allocForReserve.targetAllocationWeight.toString());

    // Build constraints object (shared with the MAX_YIELD_DRIPPING utilization filter).
    const constraints: ReserveConstraints = {
      ...buildReserveConstraintsBase(
        reserveToUpdate,
        reserve,
        currentWeight,
        investedTokensInReserve,
        currentSlot,
        currentUnixTimestamp
      ),
      targetWeight,
    };
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
      return [];
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
      return [];
    }
    finalAllocation = redistributionResult.allocation;
  }

  const targetAllocation = computeVaultTargetAllocation(finalAllocation, {
    vaultState,
    vaultAUMTokens: totalVaultAUMTokens,
    currentVaultAllocations: kaminoManager.getVaultAllocations(vaultState),
    allVaultReserves,
    currentSlot,
    forcedZeroReserves,
  });
  for (const [reserveAddress] of finalAllocation) {
    const reserve = vaultsReserves.get(reserveAddress);
    const allocForReserve = getVaultAllocationForReserve(vaultState, reserveAddress);
    if (!reserve || !allocForReserve) {
      logger.warn(
        `[allocation-rebalance-loop] Cannot validate canonical target for reserve ${reserveAddress}. Staying put.`
      );
      return [];
    }
    const constraints = buildReserveConstraintsBase(
      reserveAddress,
      reserve,
      new Decimal(allocForReserve.targetAllocationWeight.toString()),
      investedInReservesTokens.get(reserveAddress) ?? new Decimal(0),
      currentSlot,
      currentUnixTimestamp
    );
    const targetTokens = targetAllocation.targetReservesAllocation.get(reserveAddress) ?? new Decimal(0);
    const constraintType = getTargetTokenConstraintType(constraints, targetTokens);
    if (constraintType !== 'none') {
      logger.warn(
        `[allocation-rebalance-loop] Canonical target ${targetTokens} for reserve ${reserveAddress} exceeds its ${constraintType} capacity. Staying put.`
      );
      return [];
    }
  }

  // Log redistribution results
  for (const [reserve, weight] of finalAllocation) {
    const originalWeight = proposedAllocation.reservesWithAllocation.get(reserve)!;
    if (!weight.eq(originalWeight)) {
      logger.info(`Reserve ${reserve} final weight: ${originalWeight} -> ${weight}`);
    }
  }

  // Final pass: build instructions with adjusted weights
  for (const [reserveToUpdate, adjustedWeight] of finalAllocation) {
    const allocForReserve = getVaultAllocationForReserve(vaultState, reserveToUpdate);
    if (!allocForReserve) {
      continue;
    }

    const currentWeight = new Decimal(allocForReserve.targetAllocationWeight.toString());
    const weightDelta = adjustedWeight.sub(currentWeight);

    if (!weightDelta.eq(0)) {
      const reserveWithConfig: ReserveWithAddress = {
        address: reserveToUpdate,
        state: vaultsReserves.get(reserveToUpdate)!.state,
      };

      const allocationCapTokens = getAllocationCapInTokensOrDefault(vaultState, reserveToUpdate);
      const reserveAllocationConfig: ReserveAllocationConfig = new ReserveAllocationConfig(
        reserveWithConfig,
        Math.round(adjustedWeight.toNumber()), // Ensure integer weight
        allocationCapTokens
      );

      const shouldUpdateAlloc = shouldUpdateAllocation(vaultState, reserveAllocationConfig);
      if (shouldUpdateAlloc) {
        const updateAllocationIxs = await kaminoManager.updateVaultReserveAllocationIxs(
          kaminoVault,
          reserveAllocationConfig,
          signer
        );
        allocationRebalanceIxs.push(updateAllocationIxs.updateReserveAllocationIx);
      }
    }
  }

  return allocationRebalanceIxs;
}
