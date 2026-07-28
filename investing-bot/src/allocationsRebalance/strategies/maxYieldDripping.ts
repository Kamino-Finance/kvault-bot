import { Decimal } from 'decimal.js';

import { KaminoManager, KaminoReserve, KaminoVault } from '@kamino-finance/klend-sdk';
import { Address, Slot, TransactionSigner } from '@solana/kit';
import { logger } from 'kvaults-investing-bot-logger';
import { Farms, FarmState } from '@kamino-finance/farms-sdk';
import { getReserveAllocationsForUniverse } from '../rebalanceUniverse.js';
import {
  AllocationWithAPY,
  AllocationWithAPYAndIxs,
  estimateResolutionsFromReservesCountAndCoarseResolution,
  gridSearchAllocationForMaxApyCoarseToFine,
} from '../utils/maxYieldOptimizers.js';
import {
  computeOverallVaultApy,
  computeVaultTargetAllocation,
  FULL_BPS,
  ReserveWithAllocation,
} from '../utils/allocationHelper.js';
import {
  calculateTotalWeight,
  getTargetTokenConstraintType,
  normalizeWeightsToTotal,
  ReserveConstraints,
} from '../utils/allocationConstraints.js';
import {
  DEFAULT_DRIPPING_RATE_PERCENT,
  DEFAULT_ENFORCE_UTILIZATION_CAP,
  MAX_UTILIZATION_CHANGE_BPS,
} from '../consts.js';
import { buildAllocationRebalanceInstructions, buildReserveConstraintsBase, getVaultContext } from './common.js';

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

export interface MaxYieldDrippingStrategyRequest {
  kaminoManager: KaminoManager;
  kaminoVault: KaminoVault;
  vaultsReserves: Map<Address, KaminoReserve>;
  signer: TransactionSigner;
  currentSlot: Slot;
  currentUnixTimestamp: number;
  gridSearchResolution: number;
  shouldIncludeFarmRewards: boolean;
  drippingRatePercent?: number;
  compoundingPeriods?: number;
  farmsToFarmStateMap?: Map<Address, FarmState>;
  pricesMap?: Map<Address, Decimal>;
  verbose?: boolean;
  enforceUtilizationCap?: boolean;
  maxUtilizationChangeBps?: number;
  allVaultReserves?: Map<Address, KaminoReserve>;
  preservedReserves?: ReadonlySet<string>;
  forcedZeroReserves?: ReadonlySet<string>;
}

export async function getMaxYieldDrippingAllocationRebalanceIxs({
  kaminoManager,
  kaminoVault,
  vaultsReserves,
  signer,
  currentSlot,
  currentUnixTimestamp,
  gridSearchResolution,
  shouldIncludeFarmRewards,
  drippingRatePercent = DEFAULT_DRIPPING_RATE_PERCENT,
  compoundingPeriods = 1,
  farmsToFarmStateMap,
  pricesMap,
  verbose = false,
  enforceUtilizationCap = DEFAULT_ENFORCE_UTILIZATION_CAP,
  maxUtilizationChangeBps = MAX_UTILIZATION_CHANGE_BPS,
  allVaultReserves = vaultsReserves,
  preservedReserves = new Set(),
  forcedZeroReserves = new Set(),
}: MaxYieldDrippingStrategyRequest): Promise<AllocationWithAPYAndIxs> {
  // Extract common vault context
  const vaultContext = await getVaultContext(
    kaminoManager,
    kaminoVault,
    vaultsReserves,
    currentSlot,
    allVaultReserves,
    preservedReserves,
    forcedZeroReserves
  );

  // All dripping math must live on a single weight scale: the healthy reserve
  // universe. vaultContext.totalAllocationsWeights sums every configured
  // reserve, including blacklisted ones whose weight is force-zeroed outside
  // this strategy - using it as the grid budget or gate would mix scales and
  // distort the effective drip rate.
  const currentWeights = getReserveAllocationsForUniverse(vaultContext.vaultState, vaultsReserves);
  const healthyTotalWeight = calculateTotalWeight(currentWeights);

  // Dripping redistributes an existing allocation; it does not bootstrap an
  // unallocated vault (see README). This also covers a blacklisted reserve
  // holding all the weight: the healthy total is 0, and dripping from zero
  // would jump instead of drip. Bail out before the grid search — with a
  // zero weight total the APY computation would divide by zero.
  if (healthyTotalWeight.lte(0)) {
    logger.info(
      `[allocation-rebalance-loop] Dripping vault ${kaminoVault.address.toString()}: healthy allocation weight total is 0 (unallocated vault or all weight on blacklisted reserves) - nothing to drip`
    );
    return {
      ixns: [],
      bestAllocation: {
        reservesWithAllocation: currentWeights,
        apy: new Decimal(0),
      },
    };
  }

  const farmsClient = new Farms(kaminoManager.getRpc());

  // Market-impact cap (optional, off by default; enable per-vault with enforceUtilizationCap=true):
  // reject any grid candidate that would move a reserve's utilization by more than
  // maxUtilizationChangeBps (defaults to MAX_UTILIZATION_CHANGE_BPS), or that would hit a chain-side
  // deposit/withdrawal cap. This bounds how hard a single step leans on any reserve's liquidity
  // (adapting to depth: a big move in a deep reserve barely shifts utilization and is allowed; the
  // same move in a thin reserve is rejected). It stacks with the drip rate below — the grid target is
  // util-bounded, then we still only move drippingRatePercent of the way toward it, so the emitted
  // step is well within the cap. When disabled the grid search runs unfiltered, i.e. straight toward
  // the raw MAX_YIELD target.
  let utilizationFilter:
    | ((allocation: Decimal[], reservesWithAllocations: ReserveWithAllocation[]) => boolean)
    | undefined;
  if (enforceUtilizationCap) {
    const maxUtilChange = new Decimal(maxUtilizationChangeBps).div(FULL_BPS);
    const baseConstraintsByReserve = new Map<Address, Omit<ReserveConstraints, 'targetWeight'>>();
    for (const [reserveAddress, weight] of currentWeights) {
      const reserve = vaultsReserves.get(reserveAddress);
      if (!reserve) {
        continue;
      }
      const investedTokens = vaultContext.investedInReservesTokensMap.get(reserveAddress) ?? new Decimal(0);
      baseConstraintsByReserve.set(
        reserveAddress,
        buildReserveConstraintsBase(reserveAddress, reserve, weight, investedTokens, currentSlot, currentUnixTimestamp)
      );
    }
    utilizationFilter = (allocation: Decimal[], reservesWithAllocations: ReserveWithAllocation[]): boolean => {
      let allocWeightsSum = new Decimal(0);
      for (const w of allocation) {
        allocWeightsSum = allocWeightsSum.add(w);
      }
      if (allocWeightsSum.eq(0)) {
        return false;
      }
      const proposedWeights = new Map<Address, Decimal>();
      for (let i = 0; i < reservesWithAllocations.length; i++) {
        proposedWeights.set(
          reservesWithAllocations[i].reserve.address,
          allocation[i].div(allocWeightsSum).mul(healthyTotalWeight)
        );
      }
      const targetAllocation = computeVaultTargetAllocation(proposedWeights, vaultContext.allocationProjectionContext);
      for (let i = 0; i < reservesWithAllocations.length; i++) {
        const reserve = reservesWithAllocations[i].reserve;
        const reserveAddr = reserve.address;
        const currentTokens = vaultContext.investedInReservesTokensMap.get(reserveAddr) ?? new Decimal(0);
        const newTokens = targetAllocation.targetReservesAllocation.get(reserveAddr) ?? new Decimal(0);
        const tokenDelta = newTokens.sub(currentTokens);
        if (tokenDelta.eq(0)) {
          continue;
        }
        // (b) chain-side reserve deposit/withdrawal cap
        const baseConstraints = baseConstraintsByReserve.get(reserveAddr);
        if (baseConstraints && getTargetTokenConstraintType(baseConstraints, newTokens) !== 'none') {
          return false;
        }
        // (a) per-reserve utilization-change cap
        const currentUtil = new Decimal(reserve.calculateUtilizationRatio());
        const decimals = reserve.state.liquidity.mintDecimals.toNumber();
        const tokenDeltaLamports = tokenDelta.abs().mul(new Decimal(10).pow(decimals));
        const action = tokenDelta.gt(0) ? 'deposit' : 'withdraw';
        const simulatedUtil = new Decimal(
          reserve.calcSimulatedUtilizationRatio(tokenDeltaLamports, action, currentSlot, 0)
        );
        if (simulatedUtil.sub(currentUtil).abs().gt(maxUtilChange)) {
          return false;
        }
      }
      return true;
    };
  }

  // Compute the MAX_YIELD target within the utilization cap
  const maxYieldAllocation = await gridSearchAllocationForMaxApyCoarseToFine(
    kaminoManager,
    vaultContext.vaultState,
    vaultsReserves,
    healthyTotalWeight,
    gridSearchResolution,
    currentSlot,
    vaultContext.vaultAUMTokens,
    vaultContext.investedInReservesTokensMap,
    shouldIncludeFarmRewards,
    farmsClient,
    undefined, // mediumResolution - use default
    undefined, // fineResolution - use default
    compoundingPeriods,
    [], // reservesWithMinAllocation - fixed reserves are not supported for dripping
    new Decimal(0), // minTotalAllocationForSpecifiedReservesBPS
    undefined, // radius multiplier - use default
    farmsToFarmStateMap,
    pricesMap,
    verbose,
    utilizationFilter,
    vaultContext.allocationProjectionContext,
    vaultContext.allInvestedInReservesTokensMap
  );

  // Drip: move each reserve's weight only drippingRatePercent of the way
  // from its current weight toward the MAX_YIELD target, so large reallocations
  // are spread over multiple iterations (smoother APY shifts)
  const drippedWeights = computeDrippedWeights(
    currentWeights,
    maxYieldAllocation.reservesWithAllocation,
    drippingRatePercent
  );

  // Stay put once the MAX_YIELD target is within one fine-grid step of the
  // current weights - the grid search cannot resolve finer than that, so a
  // smaller gap is optimizer noise, not signal. Gating on the target gap
  // (not the dripped move, which is only dripRate of the gap) keeps the
  // steady state within one grid step of the optimum. Sized from this
  // vault's invested-reserve count (same count the grid search uses) and
  // the healthy weight total, so blacklisted weight cannot inflate the gate.
  const { fineResolution } = estimateResolutionsFromReservesCountAndCoarseResolution(
    vaultContext.investedInReservesTokensMap.size,
    gridSearchResolution
  );
  // Floor the gate at the smallest gap a drip can act on: below
  // 0.5 / dripRate weight units the dripped move rounds to zero integer
  // units, so the strategy could never close the gap and would rerun the
  // search and constraint pass every iteration without converging.
  const minActionableGap = new Decimal(0.5).mul(100).div(drippingRatePercent);
  const stayPutGate = Decimal.max(healthyTotalWeight.mul(fineResolution), minActionableGap);
  let maxTargetGap = new Decimal(0);
  for (const [reserve, targetWeight] of maxYieldAllocation.reservesWithAllocation) {
    maxTargetGap = Decimal.max(maxTargetGap, targetWeight.sub(currentWeights.get(reserve) ?? 0).abs());
  }
  const shouldStayPut = maxTargetGap.lte(stayPutGate);
  if (shouldStayPut) {
    logger.info(
      `[allocation-rebalance-loop] Dripping vault ${kaminoVault.address.toString()}: max target gap ${maxTargetGap} <= stay-put gate ${stayPutGate} (fineResolution=${fineResolution}) - staying put`
    );
  }

  const reservesWithAllocation = shouldStayPut ? currentWeights : drippedWeights;

  // Report the APY with the same farms-aware computation the grid search
  // uses to score candidates, so farm rewards are included when enabled
  const reservesWithCurrentAllocations: ReserveWithAllocation[] = [];
  for (const [reserveAddress, allocation] of kaminoManager.getVaultAllocations(vaultContext.vaultState)) {
    const reserve = vaultsReserves.get(reserveAddress);
    if (!reserve) {
      continue; // outside the healthy reserve universe
    }
    reservesWithCurrentAllocations.push({
      reserve,
      allocation: allocation.targetWeight,
    });
  }
  let chosenTotalWeight = new Decimal(0);
  for (const weight of reservesWithAllocation.values()) {
    chosenTotalWeight = chosenTotalWeight.add(weight);
  }
  // healthyTotalWeight > 0 guarantees a positive chosen total (both stay-put and
  // dripped weights preserve it); guard anyway so a broken invariant surfaces as
  // an explicit stay-put instead of NaN weights from the division below.
  if (chosenTotalWeight.lte(0)) {
    logger.error(
      `[allocation-rebalance-loop] Dripping vault ${kaminoVault.address.toString()}: chosen allocation weight total is ${chosenTotalWeight} despite healthy total ${healthyTotalWeight}. Staying put.`
    );
    return {
      ixns: [],
      bestAllocation: {
        reservesWithAllocation: currentWeights,
        apy: new Decimal(0),
      },
    };
  }
  const normalizedAllocation = reservesWithCurrentAllocations.map(({ reserve }) =>
    (reservesWithAllocation.get(reserve.address) ?? new Decimal(0)).div(chosenTotalWeight)
  );

  let chosenApy: Decimal;
  try {
    chosenApy = await computeOverallVaultApy(
      normalizedAllocation,
      reservesWithCurrentAllocations,
      chosenTotalWeight,
      vaultContext.vaultAUMTokens,
      vaultContext.allInvestedInReservesTokensMap,
      currentSlot,
      compoundingPeriods,
      shouldIncludeFarmRewards,
      farmsClient,
      farmsToFarmStateMap,
      pricesMap,
      verbose,
      vaultContext.allocationProjectionContext
    );
  } catch (error) {
    logger.error(
      `[allocation-rebalance-loop] Failed to compute the final APY for dripping vault ${kaminoVault.address.toString()}: ${error}. Staying put.`
    );
    return {
      ixns: [],
      bestAllocation: {
        reservesWithAllocation: currentWeights,
        apy: new Decimal(0),
      },
    };
  }

  const bestAllocation: AllocationWithAPY = {
    reservesWithAllocation,
    apy: chosenApy,
  };

  let dripLogMsg = `[allocation-rebalance-loop] Dripping vault ${kaminoVault.address.toString()}; strategy: MAX_YIELD_DRIPPING; rate: ${drippingRatePercent}% of the way toward the MAX_YIELD target per iteration; apy: ${bestAllocation.apy.toString()}; Allocations: `;
  for (const [reserve, weight] of bestAllocation.reservesWithAllocation) {
    const currentWeight = currentWeights.get(reserve) ?? new Decimal(0);
    const maxYieldWeight = maxYieldAllocation.reservesWithAllocation.get(reserve) ?? new Decimal(0);
    dripLogMsg += `Reserve ${reserve.toString()}: current=${currentWeight.toString()} maxYieldTarget=${maxYieldWeight.toString()} dripped=${weight.toString()}; `;
  }
  logger.info(dripLogMsg);

  // Staying put must emit no instructions: the constraint pass below can
  // still adjust weights (and emit updates) when invested amounts deviate
  // from pro-rata, which would defeat the anti-churn gate.
  if (shouldStayPut) {
    return {
      ixns: [],
      bestAllocation,
    };
  }

  // Build rebalance instructions (deposit/withdrawal constraints applied inside)
  const allocationRebalanceIxs = await buildAllocationRebalanceInstructions(
    kaminoManager,
    kaminoVault,
    vaultContext.vaultState,
    vaultsReserves,
    bestAllocation,
    signer,
    currentSlot,
    currentUnixTimestamp,
    allVaultReserves,
    preservedReserves,
    forcedZeroReserves
  );

  return {
    ixns: allocationRebalanceIxs,
    bestAllocation,
  };
}
