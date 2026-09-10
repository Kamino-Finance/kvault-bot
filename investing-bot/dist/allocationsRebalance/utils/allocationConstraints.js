import { Decimal } from 'decimal.js';
import { logger } from 'kvaults-investing-bot-logger';
/**
 * Calculate the maximum weight a reserve can have based on deposit constraints
 */
export function calculateMaxDepositWeight(targetWeight, currentWeight, investedTokensInReserve, depositLimitTokens, currentTotalSupplyInReserveTokens, aumTokens, totalTargetWeight) {
    if (!depositLimitTokens) {
        return {
            adjustedWeight: targetWeight,
            constraintHit: false,
            constraintType: 'none',
        };
    }
    if (aumTokens.lte(0) || totalTargetWeight.lte(0)) {
        return {
            adjustedWeight: targetWeight.floor(),
            constraintHit: false,
            constraintType: 'none',
        };
    }
    const newAmountInReserveTokens = aumTokens.mul(targetWeight).div(totalTargetWeight);
    const liquidityDeltaTokens = newAmountInReserveTokens.sub(investedTokensInReserve);
    const maxDepositableTokens = depositLimitTokens.sub(currentTotalSupplyInReserveTokens);
    if (maxDepositableTokens.lte(0)) {
        if (liquidityDeltaTokens.gt(0)) {
            // At a full reserve, the safe ceiling is the weight implied by what the
            // vault actually holds, not the possibly-stale configured weight.
            const maxWeight = investedTokensInReserve.mul(totalTargetWeight).div(aumTokens).floor();
            return {
                adjustedWeight: Decimal.min(targetWeight, maxWeight),
                constraintHit: true,
                constraintType: 'deposit',
            };
        }
        return {
            adjustedWeight: targetWeight.floor(),
            constraintHit: false,
            constraintType: 'none',
        };
    }
    if (liquidityDeltaTokens.gt(0) && liquidityDeltaTokens.gt(maxDepositableTokens)) {
        // Constraint hit: can't deposit as much as desired
        const maxDepositableAmountTokens = maxDepositableTokens.mul(0.98).floor(); // 2% safety margin
        const maxAmountInReserveTokens = investedTokensInReserve.add(maxDepositableAmountTokens);
        const maxWeight = maxAmountInReserveTokens.mul(totalTargetWeight).div(aumTokens);
        const adjustedWeight = Decimal.min(targetWeight, maxWeight);
        const flooredAdjustedWeight = adjustedWeight.floor(); // Ensure integer weight
        return {
            adjustedWeight: flooredAdjustedWeight,
            constraintHit: true,
            constraintType: 'deposit',
        };
    }
    return {
        adjustedWeight: targetWeight.floor(), // Ensure integer weight
        constraintHit: false,
        constraintType: 'none',
    };
}
/**
 * Calculate the minimum weight a reserve can have based on withdrawal constraints
 */
export function calculateMinWithdrawalWeight(targetWeight, currentWeight, investedTokensInReserve, availableLiquidityInReserveTokens, reserveWithdrawalCapCapacityTokens, reserveWithdrawalCapCurrentTokens, aumTokens, totalTargetWeight) {
    if (aumTokens.lte(0) || totalTargetWeight.lte(0)) {
        return {
            adjustedWeight: targetWeight.floor(),
            constraintHit: false,
            constraintType: 'none',
        };
    }
    // If withdrawal cap is disabled (null values), only use available liquidity
    const totalWithdrawableAmountInTokens = reserveWithdrawalCapCapacityTokens === null || reserveWithdrawalCapCurrentTokens === null
        ? availableLiquidityInReserveTokens
        : Decimal.min(availableLiquidityInReserveTokens, Decimal.max(reserveWithdrawalCapCapacityTokens.sub(reserveWithdrawalCapCurrentTokens), 0));
    const newAmountInReserveTokens = aumTokens.mul(targetWeight).div(totalTargetWeight);
    const liquidityDeltaTokens = newAmountInReserveTokens.sub(investedTokensInReserve);
    if (liquidityDeltaTokens.lt(0) && liquidityDeltaTokens.abs().gt(totalWithdrawableAmountInTokens)) {
        // Constraint hit: can't withdraw as much as desired
        const maxWithdrawableAmount = totalWithdrawableAmountInTokens.mul(0.98).floor(); // 2% safety margin
        const minAmountInReserve = investedTokensInReserve.sub(maxWithdrawableAmount);
        const minWeight = minAmountInReserve.mul(totalTargetWeight).div(aumTokens);
        const adjustedWeight = Decimal.max(targetWeight, minWeight);
        const ceiledAdjustedWeight = adjustedWeight.ceil(); // Never round below the minimum safe withdrawal weight
        return {
            adjustedWeight: ceiledAdjustedWeight,
            constraintHit: true,
            constraintType: 'withdrawal',
        };
    }
    return {
        adjustedWeight: targetWeight.floor(), // Ensure integer weight
        constraintHit: false,
        constraintType: 'none',
    };
}
/**
 * Apply constraints to a single reserve and return adjusted weight
 */
export function applyReserveConstraints(constraints, aumTokens, totalTargetWeight) {
    const { targetWeight, currentWeight, investedTokensInReserve, depositLimitTokens, currentTotalSupplyInReserveTokens, availableLiquidityInReserveTokens, reserveWithdrawalCapCapacityTokens, reserveWithdrawalCapCurrentTokens, } = constraints;
    // Check deposit constraints first
    const depositResult = calculateMaxDepositWeight(targetWeight, currentWeight, investedTokensInReserve, depositLimitTokens, currentTotalSupplyInReserveTokens, aumTokens, totalTargetWeight);
    if (depositResult.constraintHit) {
        return depositResult;
    }
    // Check withdrawal constraints
    const withdrawalResult = calculateMinWithdrawalWeight(targetWeight, currentWeight, investedTokensInReserve, availableLiquidityInReserveTokens, reserveWithdrawalCapCapacityTokens, reserveWithdrawalCapCurrentTokens, aumTokens, totalTargetWeight);
    return withdrawalResult;
}
/**
 * Check a canonical token target against the same reserve deposit/withdrawal
 * capacities used by the weight-bound solver.
 */
export function getTargetTokenConstraintType(constraints, targetTokens) {
    const tokenDelta = targetTokens.sub(constraints.investedTokensInReserve);
    if (tokenDelta.gt(0) && constraints.depositLimitTokens !== null) {
        const maxDepositable = Decimal.max(constraints.depositLimitTokens.sub(constraints.currentTotalSupplyInReserveTokens), 0);
        if (tokenDelta.gt(maxDepositable)) {
            return 'deposit';
        }
    }
    if (tokenDelta.lt(0)) {
        const maxWithdrawable = constraints.reserveWithdrawalCapCapacityTokens === null || constraints.reserveWithdrawalCapCurrentTokens === null
            ? constraints.availableLiquidityInReserveTokens
            : Decimal.min(constraints.availableLiquidityInReserveTokens, Decimal.max(constraints.reserveWithdrawalCapCapacityTokens.sub(constraints.reserveWithdrawalCapCurrentTokens), 0));
        if (tokenDelta.abs().gt(maxWithdrawable)) {
            return 'withdrawal';
        }
    }
    return 'none';
}
/**
 * Derive the full safe integer-weight interval for a reserve from one holdings snapshot.
 * Deposit ceilings round down; withdrawal floors round up.
 */
export function calculateReserveAllocationWeightBounds(constraints, aumTokens, totalTargetWeight) {
    if (aumTokens.lte(0) || totalTargetWeight.lte(0)) {
        const currentWeight = constraints.currentWeight.floor();
        return { minWeight: currentWeight, maxWeight: currentWeight };
    }
    const maxDepositResult = calculateMaxDepositWeight(totalTargetWeight, constraints.currentWeight, constraints.investedTokensInReserve, constraints.depositLimitTokens, constraints.currentTotalSupplyInReserveTokens, aumTokens, totalTargetWeight);
    const minWithdrawalResult = calculateMinWithdrawalWeight(new Decimal(0), constraints.currentWeight, constraints.investedTokensInReserve, constraints.availableLiquidityInReserveTokens, constraints.reserveWithdrawalCapCapacityTokens, constraints.reserveWithdrawalCapCurrentTokens, aumTokens, totalTargetWeight);
    return {
        minWeight: Decimal.max(minWithdrawalResult.adjustedWeight.ceil(), 0),
        maxWeight: Decimal.min(maxDepositResult.adjustedWeight.floor(), totalTargetWeight),
    };
}
/**
 * Project weights into inclusive bounds while preserving an exact integer total.
 */
export function redistributeWeightDifferenceWithinBounds(adjustedAllocation, targetTotalWeight, weightBounds) {
    if (targetTotalWeight.lt(0) || !targetTotalWeight.isInteger()) {
        return { allocation: new Map(adjustedAllocation), isFeasible: false };
    }
    const effectiveBounds = new Map();
    let totalMinWeight = new Decimal(0);
    let totalMaxWeight = new Decimal(0);
    for (const reserve of adjustedAllocation.keys()) {
        const bounds = weightBounds.get(reserve) ?? {
            minWeight: new Decimal(0),
            maxWeight: targetTotalWeight,
        };
        if (!bounds.minWeight.isInteger() ||
            !bounds.maxWeight.isInteger() ||
            bounds.minWeight.lt(0) ||
            bounds.maxWeight.lt(bounds.minWeight)) {
            return { allocation: new Map(adjustedAllocation), isFeasible: false };
        }
        effectiveBounds.set(reserve, bounds);
        totalMinWeight = totalMinWeight.add(bounds.minWeight);
        totalMaxWeight = totalMaxWeight.add(bounds.maxWeight);
    }
    // Clamp every weight into its bound up front. This bounded allocation is what we return on BOTH the
    // infeasible path below and the feasible path, so a caller that ignores `isFeasible` can never emit
    // a weight above a reserve's deposit cap or below its withdrawal floor: the returned allocation
    // always respects the bounds, and `isFeasible` reports only whether the exact target total was also
    // reachable within them. (Previously the infeasible target case returned the raw, unclamped input,
    // which could carry an over-cap weight straight through to a caller.)
    const boundedAllocation = new Map();
    for (const [reserve, weight] of adjustedAllocation) {
        const bounds = effectiveBounds.get(reserve);
        boundedAllocation.set(reserve, Decimal.max(bounds.minWeight, Decimal.min(bounds.maxWeight, weight)));
    }
    if (targetTotalWeight.lt(totalMinWeight) || targetTotalWeight.gt(totalMaxWeight)) {
        return { allocation: boundedAllocation, isFeasible: false };
    }
    const normalizedAllocation = normalizeWeightsToTotal(boundedAllocation, targetTotalWeight);
    for (const [reserve, weight] of normalizedAllocation) {
        const bounds = effectiveBounds.get(reserve);
        normalizedAllocation.set(reserve, Decimal.max(bounds.minWeight, Decimal.min(bounds.maxWeight, weight)));
    }
    const isFeasible = applyIntegerWeightDifference(normalizedAllocation, targetTotalWeight, effectiveBounds);
    return { allocation: normalizedAllocation, isFeasible };
}
/**
 * Scale weights proportionally to an exact integer total. Entries in
 * `constrainedReserves` are locked at their current weight.
 */
export function redistributeWeightDifference(adjustedAllocation, targetTotalWeight, constrainedReserves = new Set()) {
    const weightBounds = new Map();
    for (const reserve of constrainedReserves) {
        const weight = adjustedAllocation.get(reserve);
        if (weight) {
            weightBounds.set(reserve, { minWeight: weight, maxWeight: weight });
        }
    }
    const result = redistributeWeightDifferenceWithinBounds(adjustedAllocation, targetTotalWeight, weightBounds);
    if (!result.isFeasible) {
        logger.warn(`Cannot redistribute weights to the exact target without violating constraints.`);
    }
    return result.allocation;
}
function applyIntegerWeightDifference(allocation, targetTotalWeight, weightBounds) {
    let difference = targetTotalWeight.sub(calculateTotalWeight(allocation));
    while (!difference.eq(0)) {
        const shouldIncrease = difference.gt(0);
        const remainingWeight = difference.abs();
        const candidates = new Map();
        for (const [reserve, weight] of allocation) {
            const bounds = weightBounds.get(reserve);
            const capacity = shouldIncrease ? bounds.maxWeight.sub(weight) : weight.sub(bounds.minWeight);
            if (capacity.gt(0)) {
                candidates.set(reserve, weight);
            }
        }
        if (candidates.size === 0) {
            return false;
        }
        if (calculateTotalWeight(candidates).eq(0)) {
            for (const reserve of candidates.keys()) {
                candidates.set(reserve, new Decimal(1));
            }
        }
        const requestedAdjustments = normalizeWeightsToTotal(candidates, remainingWeight);
        let appliedWeight = new Decimal(0);
        for (const [reserve, requestedAdjustment] of requestedAdjustments) {
            const currentWeight = allocation.get(reserve);
            const bounds = weightBounds.get(reserve);
            const capacity = shouldIncrease ? bounds.maxWeight.sub(currentWeight) : currentWeight.sub(bounds.minWeight);
            const adjustment = Decimal.min(requestedAdjustment, capacity);
            allocation.set(reserve, shouldIncrease ? currentWeight.add(adjustment) : currentWeight.sub(adjustment));
            appliedWeight = appliedWeight.add(adjustment);
        }
        if (appliedWeight.eq(0)) {
            return false;
        }
        difference = shouldIncrease ? difference.sub(appliedWeight) : difference.add(appliedWeight);
    }
    for (const [reserve, weight] of allocation) {
        const bounds = weightBounds.get(reserve);
        if (!weight.isInteger() || weight.lt(bounds.minWeight) || weight.gt(bounds.maxWeight)) {
            return false;
        }
    }
    return calculateTotalWeight(allocation).eq(targetTotalWeight);
}
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
export function normalizeWeightsToTotal(allocation, targetTotal) {
    if (targetTotal.lt(0) || !targetTotal.isInteger()) {
        throw new Error(`Target total weight must be a non-negative integer: ${targetTotal}`);
    }
    if (allocation.size === 0) {
        return new Map();
    }
    const currentTotal = calculateTotalWeight(allocation);
    if (currentTotal.eq(0)) {
        const equalWeight = targetTotal.div(allocation.size).floor();
        const result = new Map();
        for (const reserve of allocation.keys()) {
            result.set(reserve, equalWeight);
        }
        let remainder = targetTotal.sub(equalWeight.mul(allocation.size)).toNumber();
        for (const reserve of allocation.keys()) {
            if (remainder <= 0)
                break;
            result.set(reserve, result.get(reserve).add(1));
            remainder--;
        }
        return result;
    }
    // First pass: scale and floor all weights
    const result = new Map();
    const scaledWeights = [];
    for (const [reserve, weight] of allocation) {
        const scaledWeight = weight.mul(targetTotal).div(currentTotal);
        const flooredWeight = scaledWeight.floor();
        const fractional = scaledWeight.sub(flooredWeight);
        result.set(reserve, flooredWeight);
        scaledWeights.push({ reserve, weight: flooredWeight, fractional });
    }
    // Calculate remainder that needs to be distributed
    const flooredTotal = calculateTotalWeight(result);
    let remainder = targetTotal.sub(flooredTotal).toNumber();
    // Sort by fractional part descending to distribute remainder fairly
    scaledWeights.sort((a, b) => b.fractional.comparedTo(a.fractional));
    // Distribute remainder one unit at a time to reserves with largest fractional parts
    for (const entry of scaledWeights) {
        if (remainder <= 0)
            break;
        const currentWeight = result.get(entry.reserve);
        result.set(entry.reserve, currentWeight.add(1));
        remainder--;
    }
    return result;
}
/**
 * Calculate the total weight of all reserves in the allocation
 */
export function calculateTotalWeight(allocation) {
    return Array.from(allocation.values()).reduce((sum, weight) => sum.add(weight), new Decimal(0));
}
//# sourceMappingURL=allocationConstraints.js.map