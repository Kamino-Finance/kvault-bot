import { Decimal } from 'decimal.js';
import { Address } from '@solana/kit';
/**
 * Represents reserve constraints for allocation calculations; everything is in tokens
 */
export interface ReserveConstraints {
    reserve: Address;
    currentWeight: Decimal;
    targetWeight: Decimal;
    investedTokensInReserve: Decimal;
    depositLimitTokens: Decimal | null;
    currentTotalSupplyInReserveTokens: Decimal;
    availableLiquidityInReserveTokens: Decimal;
    reserveWithdrawalCapCapacityTokens: Decimal | null;
    reserveWithdrawalCapCurrentTokens: Decimal | null;
}
/**
 * Represents the result of applying constraints to a reserve
 */
export interface ConstraintResult {
    adjustedWeight: Decimal;
    constraintHit: boolean;
    constraintType: 'deposit' | 'withdrawal' | 'none';
}
/**
 * Inclusive integer-weight bounds derived from reserve deposit and withdrawal constraints.
 */
export interface AllocationWeightBounds {
    minWeight: Decimal;
    maxWeight: Decimal;
}
export interface BoundedWeightRedistributionResult {
    allocation: Map<Address, Decimal>;
    isFeasible: boolean;
}
/**
 * Calculate the maximum weight a reserve can have based on deposit constraints
 */
export declare function calculateMaxDepositWeight(targetWeight: Decimal, currentWeight: Decimal, investedTokensInReserve: Decimal, depositLimitTokens: Decimal | null, currentTotalSupplyInReserveTokens: Decimal, aumTokens: Decimal, totalTargetWeight: Decimal): ConstraintResult;
/**
 * Calculate the minimum weight a reserve can have based on withdrawal constraints
 */
export declare function calculateMinWithdrawalWeight(targetWeight: Decimal, currentWeight: Decimal, investedTokensInReserve: Decimal, availableLiquidityInReserveTokens: Decimal, reserveWithdrawalCapCapacityTokens: Decimal | null, reserveWithdrawalCapCurrentTokens: Decimal | null, aumTokens: Decimal, totalTargetWeight: Decimal): ConstraintResult;
/**
 * Apply constraints to a single reserve and return adjusted weight
 */
export declare function applyReserveConstraints(constraints: ReserveConstraints, aumTokens: Decimal, totalTargetWeight: Decimal): ConstraintResult;
/**
 * Check a canonical token target against the same reserve deposit/withdrawal
 * capacities used by the weight-bound solver.
 */
export declare function getTargetTokenConstraintType(constraints: Omit<ReserveConstraints, 'targetWeight'>, targetTokens: Decimal): 'deposit' | 'withdrawal' | 'none';
/**
 * Derive the full safe integer-weight interval for a reserve from one holdings snapshot.
 * Deposit ceilings round down; withdrawal floors round up.
 */
export declare function calculateReserveAllocationWeightBounds(constraints: ReserveConstraints, aumTokens: Decimal, totalTargetWeight: Decimal): AllocationWeightBounds;
/**
 * Project weights into inclusive bounds while preserving an exact integer total.
 */
export declare function redistributeWeightDifferenceWithinBounds(adjustedAllocation: Map<Address, Decimal>, targetTotalWeight: Decimal, weightBounds: Map<Address, AllocationWeightBounds>): BoundedWeightRedistributionResult;
/**
 * Scale weights proportionally to an exact integer total. Entries in
 * `constrainedReserves` are locked at their current weight.
 */
export declare function redistributeWeightDifference(adjustedAllocation: Map<Address, Decimal>, targetTotalWeight: Decimal, constrainedReserves?: Set<Address>): Map<Address, Decimal>;
/**
 * Normalize weights to a target total while keeping them as integers.
 * Uses floor rounding and distributes any remainder by largest fractional part.
 *
 * Zero-sum input (every weight 0) with a positive target is a deliberate equal split, NOT a bug:
 * the input carries no relative proportions to scale, so the only unbiased distribution is equal.
 * This is the bootstrap-from-zero path (e.g. a freshly-allocated vault). It is intentionally NOT
 * cap-aware — callers that must respect per-reserve deposit/withdrawal caps go through
 * `redistributeWeightDifferenceWithinBounds`, which re-clamps this result to each reserve's bounds
 * and then reconciles the total via `applyIntegerWeightDifference`, so a capped reserve still ends at
 * its cap even when the equal split first proposes more. Do NOT rely on the equal split to honor a
 * strategy's intent to leave a reserve empty; encode that as a maxWeight bound instead.
 */
export declare function normalizeWeightsToTotal(allocation: Map<Address, Decimal>, targetTotal: Decimal): Map<Address, Decimal>;
/**
 * Calculate the total weight of all reserves in the allocation
 */
export declare function calculateTotalWeight(allocation: Map<Address, Decimal>): Decimal;
//# sourceMappingURL=allocationConstraints.d.ts.map