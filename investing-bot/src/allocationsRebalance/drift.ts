import { Decimal } from 'decimal.js';
import { Address } from '@solana/kit';
import { logger } from 'kvaults-investing-bot-logger';
import { lamportsToDecimal } from '@kamino-finance/klend-sdk';
import { AllocationWithAPY } from './utils/maxYieldOptimizers.js';
import { calculateTotalWeight, normalizeWeightsToTotal } from './utils/allocationConstraints.js';
import { computeWeightsForTokenTargets, computeVaultTargetAllocation } from './utils/allocationHelper.js';
import { computeWeightsApy, FinalAllocationConstraintError } from './strategies/common.js';
import { StrategyAllocationFilter, StrategyContext, StrategyTarget } from './strategyRegistry.js';

/**
 * Interpolates each reserve's weight `dripRatePercent`% of the way from its
 * current weight toward its target weight, then rounds the allocation vector
 * to integer weights while preserving the current total:
 * drippedWeight = currentWeight + dripRate * (targetWeight - currentWeight)
 *
 * A reserve present in the target but absent from the current weights drips
 * from a current weight of 0.
 */
export function computeDrippedWeights(
  currentWeights: Map<Address, Decimal>,
  targetWeights: Map<Address, Decimal>,
  dripRatePercent: number
): Map<Address, Decimal> {
  const dripRate = new Decimal(dripRatePercent).div(100);
  const drippedWeights = new Map<Address, Decimal>();
  for (const [reserve, targetWeight] of targetWeights) {
    const currentWeight = currentWeights.get(reserve) ?? new Decimal(0);
    drippedWeights.set(reserve, currentWeight.add(targetWeight.sub(currentWeight).mul(dripRate)));
  }
  return normalizeWeightsToTotal(drippedWeights, calculateTotalWeight(currentWeights));
}

/** `weights` scaled exactly (no rounding) so they sum to `total`. */
function scaleWeightsToTotal(weights: Map<Address, Decimal>, total: Decimal): Map<Address, Decimal> {
  const weightsTotal = calculateTotalWeight(weights);
  const scaled = new Map<Address, Decimal>();
  for (const [reserve, weight] of weights) {
    scaled.set(reserve, weightsTotal.eq(total) ? weight : weight.mul(total).div(weightsTotal));
  }
  return scaled;
}

export interface DriftResult {
  /** True: the pipeline emits no allocation update this pass. */
  stayPut: boolean;
  allocation: AllocationWithAPY;
}

/**
 * Moves the current healthy weights `driftRatePercent`% of the way toward the target, in shares: the target is first
 * scaled to the current healthy total, so the step does not depend on the target's units. The step is skipped when
 * the largest gap to the scaled target is within the stay-put gate: the larger of the target's noise floor and the
 * smallest gap a drift step can act on.
 */
export async function applyDrift(
  strategyName: string,
  ctx: StrategyContext,
  target: StrategyTarget,
  driftRatePercent: number
): Promise<DriftResult> {
  const { kaminoVault, vaultContext } = ctx;
  const vaultAddress = kaminoVault.address.toString();

  // All drift math lives on the healthy weight scale: blacklisted weight is force-zeroed outside the strategy. On a vault
  // whose low weight total the pipeline raises, the current weights move to the raised scale first.
  const currentWeights = new Map(
    Array.from(vaultContext.healthyWeights, ([reserve, weight]) => [reserve, weight.mul(vaultContext.weightScale)])
  );
  const healthyTotalWeight = calculateTotalWeight(currentWeights);
  const stayPutOnCurrentWeights: DriftResult = {
    stayPut: true,
    allocation: { reservesWithAllocation: currentWeights, apy: new Decimal(0) },
  };

  // Drift redistributes an existing allocation; it does not bootstrap an unallocated vault (see README). This also
  // covers a blacklisted reserve holding all the weight: drifting from zero would jump instead of drift.
  if (healthyTotalWeight.lte(0)) {
    logger.info(
      `[allocation-rebalance-loop] Dripping vault ${vaultAddress}: healthy allocation weight total is 0 (unallocated vault or all weight on blacklisted reserves) - nothing to drip`
    );
    return stayPutOnCurrentWeights;
  }

  // A target in other units (EQUAL's DEFAULT_ALLOCATION_WEIGHT per reserve, FIXED_WEIGHTS config units, or a total
  // that includes blacklisted weight) is scaled to the healthy total, so drift moves shares. computeDrippedWeights
  // then only rounds to integers.
  if (calculateTotalWeight(target.weights).lte(0)) {
    logger.error(
      `[allocation-rebalance-loop] Dripping vault ${vaultAddress}: strategy ${strategyName} returned a target with a zero weight total. Staying put.`
    );
    return stayPutOnCurrentWeights;
  }
  const scaledTarget = scaleWeightsToTotal(target.weights, healthyTotalWeight);

  // Move each reserve's weight only driftRatePercent of the way from its current weight toward the target, so
  // large reallocations are spread over multiple iterations (smoother APY shifts).
  const drippedWeights = computeDrippedWeights(currentWeights, scaledTarget, driftRatePercent);

  // Floor the gate at the smallest gap a drift step can act on: below 0.5 / driftRate weight units the drifted
  // move rounds to zero integer units, so the pipeline could never close the gap and would rerun the search and
  // constraint pass every iteration without converging. Gating on the target gap (not the drifted move, which is
  // only driftRate of the gap) keeps the steady state within the noise floor of the target.
  const minActionableGap = new Decimal(0.5).mul(100).div(driftRatePercent);
  let shouldStayPut: boolean;
  if (minActionableGap.gt(healthyTotalWeight)) {
    logger.error(
      `[allocation-rebalance-loop] driftRatePercent ${driftRatePercent} cannot move vault ${vaultAddress}: the smallest actionable gap ${minActionableGap} exceeds its total weight ${healthyTotalWeight}`
    );
    shouldStayPut = true;
  } else {
    const noiseFloorWeight = target.noiseFloorWeight ?? new Decimal(0);
    const stayPutGate = Decimal.max(noiseFloorWeight, minActionableGap);
    let maxTargetGap = new Decimal(0);
    for (const [reserve, targetWeight] of scaledTarget) {
      maxTargetGap = Decimal.max(maxTargetGap, targetWeight.sub(currentWeights.get(reserve) ?? 0).abs());
    }
    shouldStayPut = maxTargetGap.lte(stayPutGate);
    if (shouldStayPut) {
      logger.info(
        `[allocation-rebalance-loop] Dripping vault ${vaultAddress}: max target gap ${maxTargetGap} <= stay-put gate ${stayPutGate} (noiseFloorWeight=${noiseFloorWeight}) - staying put`
      );
    }
  }

  const reservesWithAllocation = shouldStayPut ? currentWeights : drippedWeights;

  const chosenTotalWeight = calculateTotalWeight(reservesWithAllocation);
  // healthyTotalWeight > 0 guarantees a positive chosen total (both stay-put and drifted weights preserve it);
  // guard anyway so a broken invariant surfaces as an explicit stay-put instead of NaN weights from the division.
  if (chosenTotalWeight.lte(0)) {
    logger.error(
      `[allocation-rebalance-loop] Dripping vault ${vaultAddress}: chosen allocation weight total is ${chosenTotalWeight} despite healthy total ${healthyTotalWeight}. Staying put.`
    );
    return stayPutOnCurrentWeights;
  }
  // Report the APY with the same farms-aware computation the grid search uses to score candidates, so farm
  // rewards are included when enabled.
  let chosenApy: Decimal;
  try {
    chosenApy = await computeWeightsApy(ctx, reservesWithAllocation);
  } catch (error) {
    logger.error(
      `[allocation-rebalance-loop] Failed to compute the final APY for dripping vault ${vaultAddress}: ${error}. Staying put.`
    );
    return stayPutOnCurrentWeights;
  }

  const allocation: AllocationWithAPY = { reservesWithAllocation, apy: chosenApy };
  let dripLogMsg = `[allocation-rebalance-loop] Dripping vault ${vaultAddress}; strategy: ${strategyName}; rate: ${driftRatePercent}% of the way toward the ${strategyName} target per iteration; apy: ${allocation.apy.toString()}; Allocations: `;
  for (const [reserve, weight] of allocation.reservesWithAllocation) {
    const currentWeight = currentWeights.get(reserve) ?? new Decimal(0);
    const targetWeight = scaledTarget.get(reserve) ?? new Decimal(0);
    dripLogMsg += `Reserve ${reserve.toString()}: current=${currentWeight.toString()} target=${targetWeight.toString()} dripped=${weight.toString()}; `;
  }
  logger.info(dripLogMsg);

  // Staying put must emit no instructions: the constraint pass can still adjust weights (and emit updates) when
  // invested amounts deviate from pro-rata, which would defeat the anti-churn gate.
  return { stayPut: shouldStayPut, allocation };
}

/** Moves token targets from actual holdings, then verifies the integer weights through the canonical SDK projection. */
export async function applyHoldingsDrift(
  ctx: StrategyContext,
  target: StrategyTarget,
  ratePercent: number,
  allocationFilter: StrategyAllocationFilter
): Promise<DriftResult> {
  const { vaultContext } = ctx;
  const existingWeights = new Map(vaultContext.healthyWeights);
  const currentWeights = new Map(
    Array.from(vaultContext.healthyWeights, ([reserve, weight]) => [reserve, weight.mul(vaultContext.weightScale)])
  );
  const totalWeight = calculateTotalWeight(currentWeights);
  const unchanged = { stayPut: true, allocation: { reservesWithAllocation: existingWeights, apy: new Decimal(0) } };
  if (totalWeight.lte(0) || ratePercent <= 0) return unchanged;
  const projectionContext = vaultContext.allocationProjectionContext;
  const fullWeights = scaleWeightsToTotal(target.weights, totalWeight);
  const fullTarget = computeVaultTargetAllocation(fullWeights, projectionContext);
  const tokenUnit = lamportsToDecimal(1, projectionContext.vaultState.tokenMintDecimals.toNumber());
  // One integer weight can move this much of AUM. Allow that rounding quantum, but never relax the utilization cap.
  const roundingTokens = projectionContext.vaultAUMTokens.div(totalWeight).add(tokenUnit);
  const holdings = vaultContext.investedInReservesTokensMap;
  const tokensAt = (fraction: Decimal): Map<Address, Decimal> =>
    new Map(
      [...currentWeights.keys()].map((reserve) => {
        const current = holdings.get(reserve) ?? new Decimal(0);
        const targetTokens = fullTarget.targetReservesAllocation.get(reserve) ?? new Decimal(0);
        return [reserve, current.add(targetTokens.sub(current).mul(fraction))];
      })
    );
  const requested = new Decimal(ratePercent).div(100);
  const maxTargetGap = Decimal.max(
    0,
    ...[...tokensAt(new Decimal(1))].map(([reserve, amount]) => amount.sub(holdings.get(reserve) ?? 0).abs())
  );
  const gateTokens = Decimal.max(target.noiseFloorWeight ?? 0, new Decimal(0.5).div(requested))
    .mul(projectionContext.vaultAUMTokens)
    .div(totalWeight);
  // Keep the existing noise gate only when configured weights are safe. A stale unsafe vector still needs repair.
  if (maxTargetGap.lte(gateTokens) && allocationFilter(existingWeights)) return unchanged;
  const candidateAt = (fraction: Decimal, round = true): Map<Address, Decimal> | undefined => {
    const desired = tokensAt(fraction);
    const inverse = computeWeightsForTokenTargets(desired, fullWeights, projectionContext, totalWeight);
    if (!inverse) return undefined;
    const weights = round ? normalizeWeightsToTotal(inverse, totalWeight) : inverse;
    const tolerance = round ? roundingTokens : tokenUnit;
    const projected = computeVaultTargetAllocation(weights, projectionContext);
    // The inverse must preserve idle and excluded reserves after integer rounding as well.
    if (projected.targetUnallocatedAmount.sub(fullTarget.targetUnallocatedAmount).abs().gt(tolerance)) return undefined;
    for (const [reserve, finalTokens] of projected.targetReservesAllocation) {
      const expected = desired.get(reserve) ?? fullTarget.targetReservesAllocation.get(reserve) ?? new Decimal(0);
      if (finalTokens.sub(expected).abs().gt(tolerance)) return undefined;
      if (desired.has(reserve)) {
        const current = holdings.get(reserve) ?? new Decimal(0);
        const limit = tokensAt(requested).get(reserve)!;
        if (
          finalTokens.lt(Decimal.min(current, limit).sub(tolerance)) ||
          finalTokens.gt(Decimal.max(current, limit).add(tolerance))
        )
          return undefined;
      }
    }
    return allocationFilter(weights) ? weights : undefined;
  };
  let chosen = candidateAt(requested);
  if (!chosen && candidateAt(new Decimal(0), false)) {
    // The continuous token segment has monotonic reserve moves. Find its largest cap-safe fraction first.
    let low = new Decimal(0);
    let high = requested;
    if (candidateAt(high, false)) low = high;
    else
      for (let iteration = 0; iteration < 48; iteration++) {
        const middle = low.add(high).div(2);
        if (candidateAt(middle, false)) low = middle;
        else high = middle;
      }
    chosen = candidateAt(low);
    if (!chosen) {
      // Integer apportionment need not be monotonic. This bounded fallback retains only verified safe candidates;
      // it does not claim a global optimum over all integer weight vectors.
      high = low;
      low = new Decimal(0);
      chosen = candidateAt(low);
      for (let iteration = 0; iteration < 48; iteration++) {
        const middle = low.add(high).div(2);
        const candidate = candidateAt(middle);
        if (candidate) {
          low = middle;
          chosen = candidate;
        } else high = middle;
      }
    }
  }
  if (!chosen) {
    // A withdrawal can leave temporary idle funds that no partial weight vector represents. A safe pending target
    // must remain investable so the next deposit can finish, including when the independent investing loop is off.
    if (allocationFilter(existingWeights)) return unchanged;
    throw new FinalAllocationConstraintError(ctx.kaminoVault.address);
  }
  // A zero token gap can still require a weight repair after a failed or partial investment.
  const sameWeights = [...chosen].every(([reserve, weight]) => weight.eq(existingWeights.get(reserve) ?? 0));
  return {
    stayPut: sameWeights,
    allocation: { reservesWithAllocation: chosen, apy: await computeWeightsApy(ctx, chosen) },
  };
}
