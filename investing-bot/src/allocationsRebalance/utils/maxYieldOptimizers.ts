import { Decimal } from 'decimal.js';
// Grid Search Allocation for APY (Exhaustive) for a Given Number of Markets

import {
  KaminoManager,
  KaminoReserve,
  LedgerInstant,
  ReserveAllocationOverview,
  VaultState,
} from '@kamino-finance/klend-sdk';
import { Address, IInstruction } from '@solana/kit';
import { logger } from 'kvaults-investing-bot-logger';
import { Farms, FarmState } from '@kamino-finance/farms-sdk';
import { withTimeout } from '../../utils/timeout.js';
import {
  computeOverallVaultApy,
  computeStabilizationFactorForVault,
  FULL_BPS,
  ReserveWithAllocation,
  VaultAllocationProjectionContext,
} from './allocationHelper.js';

export const DEFAULT_GRID_SEARCH_RESOLUTION = 0.01;

/**
 * Generates allocation points where each allocation sums exactly to targetSum
 * @param reservesCount The number of reserves in the vault
 * @param resolution The resolution of the allocation grid
 * @param targetSum The target sum of the allocations
 * @returns Array of allocation arrays that sum to targetSum
 */
export function generateAllocationPoints(
  reservesCount: number,
  resolution: number,
  targetSum: number = 1
): Decimal[][] {
  const R = Math.floor(targetSum / resolution);

  // Recursive function to generate combinations that sum exactly to 'rem'
  function rec(k: number, rem: number): number[][] {
    if (k === 1) {
      // Base case: only one allocation left, it must equal rem to sum to R
      return [[rem]];
    } else {
      const result: number[][] = [];

      // Try all possible values for the current allocation
      for (let i = 0; i <= rem; i++) {
        // Generate all ways to distribute remaining value among k-1 allocations
        const tails = rec(k - 1, rem - i);

        // Add current allocation to each tail
        for (const tail of tails) {
          result.push([i, ...tail]);
        }
      }

      return result;
    }
  }

  // Generate all combinations that sum exactly to R, then normalize
  const points: Decimal[][] = [];
  const solutions = rec(reservesCount, R);

  for (const sol of solutions) {
    // Since we're only generating combinations that sum to R,
    // after normalization they will sum to exactly 1
    points.push(sol.map((val) => new Decimal(val).div(R).mul(targetSum)));
  }

  return points;
}

export type StabilizationFactorAndAPY = {
  stabilizationFactor: Decimal;
  apy: Decimal;
};

export type AllocationWithAPY = {
  reservesWithAllocation: Map<Address, Decimal>;
  apy: Decimal;
};

export type AllocationWithStabilizationFactorAndAPY = {
  reservesWithAllocation: Map<Address, Decimal>;
  apy: Decimal;
  stabilizationFactor: Decimal;
};

export type AllocationWithAPYAndIxs = {
  bestAllocation: AllocationWithAPY;
  ixns: IInstruction[];
};

export type AllocationWithStabilizationFactorAndAPYAndIxs = {
  bestAllocation: AllocationWithStabilizationFactorAndAPY;
  ixns: IInstruction[];
};

/**
 * Generates allocation points within a refinement region around a target allocation
 * @param targetAllocation The center allocation to refine around
 * @param radius The maximum distance from target for each component
 * @param resolution The resolution for the refinement grid
 * @returns Array of allocation arrays that sum to 1.0 and are within radius of target
 */
export function generateRefinementRegionPoints(
  targetAllocation: Decimal[],
  radius: number,
  resolution: number
): Decimal[][] {
  const reservesCount = targetAllocation.length;
  const radiusDecimal = new Decimal(radius);
  const points: Decimal[][] = [];

  // Generate bounds for each component
  const bounds: { min: Decimal; max: Decimal }[] = [];
  for (let i = 0; i < reservesCount; i++) {
    const min = Decimal.max(new Decimal(0), targetAllocation[i].sub(radiusDecimal));
    const max = Decimal.min(new Decimal(1), targetAllocation[i].add(radiusDecimal));
    bounds.push({ min, max });
  }

  // Generate grid points within bounds
  const steps = Math.floor(1 / resolution);

  function generateCombinations(index: number, currentAllocation: Decimal[], remainingSum: Decimal): void {
    if (index === reservesCount - 1) {
      // Last component must equal remaining sum
      const lastValue = remainingSum;
      if (lastValue.gte(bounds[index].min) && lastValue.lte(bounds[index].max)) {
        const finalAllocation = [...currentAllocation, lastValue];

        // Check if allocation is within radius of target
        let withinRadius = true;
        for (let i = 0; i < reservesCount; i++) {
          if (finalAllocation[i].sub(targetAllocation[i]).abs().gt(radiusDecimal)) {
            withinRadius = false;
            break;
          }
        }

        if (withinRadius) {
          points.push(finalAllocation);
        }
      }
      return;
    }

    // Try values within bounds for current component
    const minSteps = Math.max(0, Math.floor(bounds[index].min.toNumber() / resolution));
    const maxSteps = Math.min(steps, Math.ceil(bounds[index].max.toNumber() / resolution));

    for (let step = minSteps; step <= maxSteps; step++) {
      const value = new Decimal(step).mul(resolution);
      if (value.lte(remainingSum) && value.gte(bounds[index].min) && value.lte(bounds[index].max)) {
        generateCombinations(index + 1, [...currentAllocation, value], remainingSum.sub(value));
      }
    }
  }

  generateCombinations(0, [], new Decimal(1));
  return points;
}

export type Resolutions = {
  coarseResolution: number;
  mediumResolution: number;
  fineResolution: number;
};

export function estimateResolutionsFromReservesCountAndCoarseResolution(
  reservesCount: number,
  coarseResolution: number
): Resolutions {
  const resolutions: Resolutions = {
    coarseResolution: coarseResolution,
    mediumResolution: 0,
    fineResolution: 0,
  };

  let minCoarseResolution = 0.01; // 1%
  if (reservesCount >= 10) {
    minCoarseResolution = 0.2; // 20%
    resolutions.mediumResolution = 0.1; // 10%
    resolutions.fineResolution = 0.02; // 2%
  } else if (reservesCount >= 8) {
    minCoarseResolution = 0.15; // 15%
    resolutions.mediumResolution = 0.05; // 5%
    resolutions.fineResolution = 0.02; // 2%
  } else if (reservesCount >= 6) {
    minCoarseResolution = 0.12; // 12%
    resolutions.mediumResolution = 0.04; // 4%
    resolutions.fineResolution = 0.015; // 1.5%
  } else if (reservesCount >= 4) {
    minCoarseResolution = 0.08; // 8%
    resolutions.mediumResolution = 0.04; // 4%
    resolutions.fineResolution = 0.01; // 1%
  } else {
    minCoarseResolution = 0.05; // 5%
    resolutions.mediumResolution = 0.025; // 2.5%
    resolutions.fineResolution = 0.005; // 0.5%
  }

  resolutions.coarseResolution = Math.max(minCoarseResolution, coarseResolution);

  return resolutions;
}

export type RadiusMultipliers = {
  mediumRadiusMultiplier: number;
  fineRadiusMultiplier: number;
};

/**
 * Try to estimate the medium and fine radius depending on the the number of reserves and the coarse resolution; it is a rough estimate that tries a one size fits all approach, may need fine tuning
 */
export function estimateRadiusMultiplierFromReservesCountAndResolution(reservesCount: number): RadiusMultipliers {
  const radiusMultipliers = {
    mediumRadiusMultiplier: 1,
    fineRadiusMultiplier: 1,
  };

  logger.info(`[allocation-rebalance-loop] reservesCount: ${reservesCount}`);
  if (reservesCount >= 10) {
    radiusMultipliers.mediumRadiusMultiplier = 0.4;
    radiusMultipliers.fineRadiusMultiplier = 0.3;
  } else if (reservesCount >= 8) {
    radiusMultipliers.mediumRadiusMultiplier = 0.6;
    radiusMultipliers.fineRadiusMultiplier = 0.5;
  } else if (reservesCount >= 6) {
    radiusMultipliers.mediumRadiusMultiplier = 0.7;
    radiusMultipliers.fineRadiusMultiplier = 0.6;
  } else if (reservesCount >= 4) {
    radiusMultipliers.mediumRadiusMultiplier = 1;
    radiusMultipliers.fineRadiusMultiplier = 1.1;
  } else if (reservesCount >= 2) {
    radiusMultipliers.mediumRadiusMultiplier = 1.5;
    radiusMultipliers.fineRadiusMultiplier = 2;
  }

  return radiusMultipliers;
}

/**
 * Build the index-aligned inputs for a coarse-to-fine grid search:
 *  - `reservesWithCurrentAllocations`: the candidate reserves the optimizer distributes weight across
 *    (the i-th entry corresponds to position i in every generated allocation vector); and
 *  - `reservesWithMinAllocationIndices`: positions within that vector of the fixed/min-allocation
 *    reserves, so the min-allocation constraint reads the right weights.
 *
 * The `reserves` map is the canonical strategy universe supplied by the caller. Any reserve outside
 * that universe is excluded from the optimizer, so reserve filtering policy stays outside this helper.
 * A reserve that is both outside the universe and a min-allocation/fixed reserve is excluded: the
 * caller's universe boundary overrides the allocation floor.
 *
 * The min-allocation indices are derived from the post-exclusion candidate list, keeping them aligned
 * with the allocation vectors produced by `generateAllocationPoints` even after exclusion.
 */
export function buildSearchCandidates(
  currentReservesAllocations: Map<Address, ReserveAllocationOverview>,
  reserves: Map<Address, KaminoReserve>,
  reservesWithMinAllocation: Address[]
): { reservesWithCurrentAllocations: ReserveWithAllocation[]; reservesWithMinAllocationIndices: number[] } {
  const reservesWithCurrentAllocations: ReserveWithAllocation[] = [];
  for (const [reserveAddress, allocation] of currentReservesAllocations.entries()) {
    const reserve = reserves.get(reserveAddress);
    if (!reserve) {
      continue;
    }
    reservesWithCurrentAllocations.push({
      reserve,
      allocation: allocation.targetWeight,
    });
  }

  const reservesWithMinAllocationIndices: number[] = [];
  reservesWithCurrentAllocations.forEach((reserveWithAllocation, index) => {
    if (reservesWithMinAllocation.includes(reserveWithAllocation.reserve.address)) {
      reservesWithMinAllocationIndices.push(index);
    }
  });

  return { reservesWithCurrentAllocations, reservesWithMinAllocationIndices };
}

interface CoarseToFineSearchConfig<T> {
  candidatesCount: number;
  coarseResolution: number;
  mediumResolution: number;
  fineResolution: number;
  mediumRadius: number;
  fineRadius: number;
  initialScore: Decimal;
  evaluate: (allocation: Decimal[]) => Promise<T | null>;
  score: (result: T) => Decimal;
  isBetter: (candidate: Decimal, currentBest: Decimal) => boolean;
  describe: (result: T) => string;
  verbose: boolean;
}

interface CoarseToFineSearchResult<T> {
  allocation: Decimal[];
  evaluation: T;
}

/**
 * Runs the shared coarse -> medium -> fine search mechanics. Metric computation and
 * comparison direction stay with the caller, so APY maximization and stabilization
 * minimization cannot drift in their candidate generation or empty-result handling.
 */
async function runCoarseToFineSearch<T>({
  candidatesCount,
  coarseResolution,
  mediumResolution,
  fineResolution,
  mediumRadius,
  fineRadius,
  initialScore,
  evaluate,
  score,
  isBetter,
  describe,
  verbose,
}: CoarseToFineSearchConfig<T>): Promise<CoarseToFineSearchResult<T> | null> {
  if (verbose) {
    logger.info(`[allocation-rebalance-loop] Phase 1: Coarse search with resolution ${coarseResolution}`);
  }

  const coarsePoints = generateAllocationPoints(candidatesCount, coarseResolution);
  let bestScore = initialScore;
  let secondBestScore = initialScore;
  let bestAllocation: Decimal[] = [];
  let secondBestAllocation: Decimal[] = [];
  let bestEvaluation: T | undefined;

  for (const allocation of coarsePoints) {
    const evaluation = await evaluate(allocation);
    if (evaluation === null) {
      continue;
    }
    const candidateScore = score(evaluation);
    if (isBetter(candidateScore, bestScore)) {
      secondBestScore = bestScore;
      secondBestAllocation = bestAllocation;
      bestScore = candidateScore;
      bestAllocation = allocation;
      bestEvaluation = evaluation;
    } else if (isBetter(candidateScore, secondBestScore)) {
      secondBestScore = candidateScore;
      secondBestAllocation = allocation;
    }
  }

  logger.info(
    `[allocation-rebalance-loop] Coarse search completed. Best ${bestEvaluation ? describe(bestEvaluation) : 'result: none'}, evaluated ${coarsePoints.length} points`
  );
  if (!bestEvaluation || bestAllocation.length === 0 || !bestScore.isFinite()) {
    return null;
  }
  let selectedEvaluation: T = bestEvaluation;

  logger.info(
    `[allocation-rebalance-loop] Phase 2: Medium search with resolution ${mediumResolution}, radius ${mediumRadius}`
  );
  const mediumCandidates = secondBestAllocation.length > 0 ? [bestAllocation, secondBestAllocation] : [bestAllocation];
  const mediumPointKeys = new Set(
    mediumCandidates
      .flatMap((candidate) => generateRefinementRegionPoints(candidate, mediumRadius, mediumResolution))
      .map((point) => point.map((value) => value.toString()).join(','))
  );
  const mediumPoints = Array.from(mediumPointKeys).map((key) => key.split(',').map((value) => new Decimal(value)));

  for (const allocation of mediumPoints) {
    const evaluation = await evaluate(allocation);
    if (evaluation !== null && isBetter(score(evaluation), bestScore)) {
      bestScore = score(evaluation);
      bestAllocation = allocation;
      selectedEvaluation = evaluation;
    }
  }
  logger.info(
    `[allocation-rebalance-loop] Medium search completed. Best ${describe(selectedEvaluation)}, evaluated ${mediumPoints.length} points`
  );

  logger.info(
    `[allocation-rebalance-loop] Phase 3: Fine search with resolution ${fineResolution}, radius ${fineRadius}`
  );
  const finePoints = generateRefinementRegionPoints(bestAllocation, fineRadius, fineResolution);
  for (const allocation of finePoints) {
    const evaluation = await evaluate(allocation);
    if (evaluation !== null && isBetter(score(evaluation), bestScore)) {
      bestScore = score(evaluation);
      bestAllocation = allocation;
      selectedEvaluation = evaluation;
    }
  }
  logger.info(
    `[allocation-rebalance-loop] Fine search completed. Best ${describe(selectedEvaluation)}, evaluated ${finePoints.length} points`
  );

  return { allocation: bestAllocation, evaluation: selectedEvaluation };
}

export async function gridSearchAllocationForMaxApyCoarseToFine(
  manager: KaminoManager,
  vault: VaultState,
  reserves: Map<Address, KaminoReserve>,
  allocationWeightsSum: Decimal,
  requestedCoarseResolution: number,
  currentLedgerInstant: LedgerInstant,
  vaultAUMTokens: Decimal,
  investedInReservesTokens: Map<Address, Decimal>,
  shouldIncludeFarmRewards: boolean,
  farmsClient?: Farms,
  mediumResolution?: number,
  fineResolution?: number,
  compoundingPeriods: number = 1,
  reservesWithMinAllocation: Address[] = [],
  minTotalAllocationForSpecifiedReservesBPS: Decimal = new Decimal(0),
  radiusMultiplier?: number, // recommended: 2x coarse resolution for better coverage
  farmsToFarmStateMap?: Map<Address, FarmState>,
  pricesMap?: Map<Address, Decimal>,
  verbose: boolean = false,
  // Optional hard filter over candidate allocations: return false to reject a candidate before it is
  // scored (e.g. MAX_YIELD_DRIPPING's per-reserve utilization cap). Rejected candidates are treated
  // as infeasible, exactly like a candidate that fails the min-allocation or APY-timeout checks.
  allocationFilter?: (allocation: Decimal[], reservesWithAllocations: ReserveWithAllocation[]) => boolean,
  projectionContext?: VaultAllocationProjectionContext,
  allInvestedInReservesTokens: Map<Address, Decimal> = investedInReservesTokens
): Promise<AllocationWithAPY> {
  // Set default resolutions
  const resolutions = estimateResolutionsFromReservesCountAndCoarseResolution(
    investedInReservesTokens.size,
    requestedCoarseResolution
  );
  const coarseResolution = resolutions.coarseResolution;
  const mediumRes = mediumResolution || resolutions.mediumResolution;
  const fineRes = fineResolution || resolutions.fineResolution;

  // if no farms client is provided, create a new one
  const localFarmsClient = farmsClient || new Farms(manager.getRpc());

  const radiusMultipliers = estimateRadiusMultiplierFromReservesCountAndResolution(investedInReservesTokens.size);
  const mediumRadiusMultiplier = radiusMultiplier || radiusMultipliers.mediumRadiusMultiplier;
  const fineRadiusMultiplier = radiusMultiplier || radiusMultipliers.fineRadiusMultiplier;

  // Calculate adaptive radius based on coarse resolution
  const mediumRadius = coarseResolution * mediumRadiusMultiplier;
  const fineRadius = mediumRadius * fineRadiusMultiplier;

  if (verbose) {
    logger.info(
      `[allocation-rebalance-loop] Coarse-to-fine search: coarse=${coarseResolution}, medium=${mediumRes}, fine=${fineRes}`
    );
    logger.info(
      `[allocation-rebalance-loop] Search radius: medium=${mediumRadius}, fine=${fineRadius} (multiplier=${radiusMultiplier})`
    );
  }

  // Build the candidate reserves from the supplied universe and the aligned min-allocation indices.
  const { reservesWithCurrentAllocations, reservesWithMinAllocationIndices } = buildSearchCandidates(
    manager.getVaultAllocations(vault),
    reserves,
    reservesWithMinAllocation
  );
  const countReservesInAllocation = reservesWithCurrentAllocations.length;

  // With every candidate reserve outside the supplied universe there is nothing to optimize over.
  // Return an empty allocation; callers can still apply external enforcement instructions.
  if (countReservesInAllocation === 0) {
    logger.warn('[allocation-rebalance-loop] No healthy reserves to allocate across; returning empty allocation');
    return { reservesWithAllocation: new Map(), apy: new Decimal(0) };
  }

  // Helper function to evaluate allocation and check constraints
  async function evaluateAllocation(allocation: Decimal[]): Promise<Decimal | null> {
    // Yield to prevent blocking
    await new Promise((resolve) => setImmediate(resolve));

    // Reject candidates the caller's filter rejects (e.g. the dripping utilization cap) before scoring.
    if (allocationFilter && !allocationFilter(allocation, reservesWithCurrentAllocations)) {
      return null;
    }

    // Check minimum allocation constraints
    if (reservesWithMinAllocationIndices.length > 0) {
      let totalAllocForSpecifiedReserves = new Decimal(0);
      for (const index of reservesWithMinAllocationIndices) {
        totalAllocForSpecifiedReserves = totalAllocForSpecifiedReserves.add(allocation[index]);
      }
      const totalAllocForSpecifiedReservesBPS = totalAllocForSpecifiedReserves.mul(FULL_BPS);
      if (totalAllocForSpecifiedReservesBPS.lt(minTotalAllocationForSpecifiedReservesBPS)) {
        return null;
      }
    }

    // Calculate allocation weights sum
    let allocationWeightsSum = new Decimal(0);
    allocation.forEach((weight) => {
      allocationWeightsSum = allocationWeightsSum.add(weight);
    });

    // Wrap the APY computation with timeout to prevent hanging
    try {
      return await withTimeout(
        computeOverallVaultApy(
          allocation,
          reservesWithCurrentAllocations,
          allocationWeightsSum,
          vaultAUMTokens,
          allInvestedInReservesTokens,
          currentLedgerInstant,
          compoundingPeriods,
          shouldIncludeFarmRewards,
          localFarmsClient,
          farmsToFarmStateMap,
          pricesMap,
          verbose,
          projectionContext
        ),
        120000, // 120 second timeout
        'computeOverallVaultApy'
      );
    } catch (error) {
      logger.error(`[maxYieldOptimizers] Error in evaluateAllocation: ${error}`);
      return null;
    }
  }

  const searchResult = await runCoarseToFineSearch({
    candidatesCount: countReservesInAllocation,
    coarseResolution,
    mediumResolution: mediumRes,
    fineResolution: fineRes,
    mediumRadius,
    fineRadius,
    initialScore: new Decimal(-Infinity),
    evaluate: evaluateAllocation,
    score: (apy) => apy,
    isBetter: (candidate, currentBest) => candidate.gt(currentBest),
    describe: (apy) => `APY: ${apy.toString()}`,
    verbose,
  });
  if (!searchResult) {
    logger.warn(
      `[allocation-rebalance-loop] Grid search found no feasible allocation (every evaluation failed). Falling back to current weights.`
    );
    const current = new Map<Address, Decimal>();
    reservesWithCurrentAllocations.forEach((r) => current.set(r.reserve.address, r.allocation));
    return { reservesWithAllocation: current, apy: new Decimal(0) };
  }

  // Denormalize allocations and prepare result
  const finalAllocation = searchResult.allocation.map((val) => val.mul(allocationWeightsSum));
  const bestAllocationWithReserves = new Map<Address, Decimal>();
  for (let index = 0; index < reservesWithCurrentAllocations.length; index++) {
    bestAllocationWithReserves.set(reservesWithCurrentAllocations[index].reserve.address, finalAllocation[index]);
  }

  logger.info(
    `[allocation-rebalance-loop] Coarse-to-fine best allocation: ${bestAllocationWithReserves.toString()} with yield: ${searchResult.evaluation.toString()}`
  );

  return {
    reservesWithAllocation: bestAllocationWithReserves,
    apy: searchResult.evaluation,
  };
}

/**
 * Coarse-to-fine grid search for minimum stabilization factor allocation
 * Uses multiple resolution levels to efficiently search the allocation space
 */
export async function gridSearchAllocationForMinStabilizationFactorCoarseToFine(
  manager: KaminoManager,
  vault: VaultState,
  reserves: Map<Address, KaminoReserve>,
  allocationWeightsSum: Decimal,
  requestedCoarseResolution: number,
  currentLedgerInstant: LedgerInstant,
  vaultAUMTokens: Decimal,
  investedInReservesTokens: Map<Address, Decimal>,
  shouldIncludeFarmRewards: boolean,
  farmsClient?: Farms,
  mediumResolution?: number,
  fineResolution?: number,
  compoundingPeriods: number = 1,
  reservesWithMinAllocation: Address[] = [],
  minTotalAllocationForSpecifiedReservesBPS: Decimal = new Decimal(0),
  radiusMultiplier?: number, // recommended: 2x coarse resolution for better coverage
  farmsToFarmStateMap?: Map<Address, FarmState>,
  pricesMap?: Map<Address, Decimal>,
  verbose: boolean = false,
  projectionContext?: VaultAllocationProjectionContext,
  allInvestedInReservesTokens: Map<Address, Decimal> = investedInReservesTokens
): Promise<AllocationWithStabilizationFactorAndAPY> {
  // Set default resolutions
  const resolutions = estimateResolutionsFromReservesCountAndCoarseResolution(
    investedInReservesTokens.size,
    requestedCoarseResolution
  );
  const coarseResolution = resolutions.coarseResolution;
  const mediumRes = mediumResolution || resolutions.mediumResolution;
  const fineRes = fineResolution || resolutions.fineResolution;

  // if no farms client is provided, create a new one
  const localFarmsClient = farmsClient || new Farms(manager.getRpc());

  const radiusMultipliers = estimateRadiusMultiplierFromReservesCountAndResolution(investedInReservesTokens.size);
  const mediumRadiusMultiplier = radiusMultiplier || radiusMultipliers.mediumRadiusMultiplier;
  const fineRadiusMultiplier = radiusMultiplier || radiusMultipliers.fineRadiusMultiplier;

  // Calculate adaptive radius based on coarse resolution
  const mediumRadius = coarseResolution * mediumRadiusMultiplier;
  const fineRadius = mediumRadius * fineRadiusMultiplier;

  if (verbose) {
    logger.info(
      `[allocation-rebalance-loop] Coarse-to-fine search: coarse=${coarseResolution}, medium=${mediumRes}, fine=${fineRes}`
    );
    logger.info(
      `[allocation-rebalance-loop] Search radius: medium=${mediumRadius}, fine=${fineRadius} (multiplier=${radiusMultiplier})`
    );
  }

  // Build the candidate reserves from the supplied universe and the aligned min-allocation indices.
  const { reservesWithCurrentAllocations, reservesWithMinAllocationIndices } = buildSearchCandidates(
    manager.getVaultAllocations(vault),
    reserves,
    reservesWithMinAllocation
  );
  const countReservesInAllocation = reservesWithCurrentAllocations.length;

  // With every candidate reserve outside the supplied universe there is nothing to optimize over.
  // Return an empty allocation; callers can still apply external enforcement instructions.
  if (countReservesInAllocation === 0) {
    logger.warn('[allocation-rebalance-loop] No healthy reserves to allocate across; returning empty allocation');
    return { reservesWithAllocation: new Map(), apy: new Decimal(0), stabilizationFactor: new Decimal(0) };
  }

  // Helper function to evaluate allocation and check constraints; returns the stabilization factor
  async function evaluateAllocation(allocation: Decimal[]): Promise<StabilizationFactorAndAPY | null> {
    // Yield to prevent blocking
    await new Promise((resolve) => setImmediate(resolve));

    // Check minimum allocation constraints
    if (reservesWithMinAllocationIndices.length > 0) {
      let totalAllocForSpecifiedReserves = new Decimal(0);
      for (const index of reservesWithMinAllocationIndices) {
        totalAllocForSpecifiedReserves = totalAllocForSpecifiedReserves.add(allocation[index]);
      }
      const totalAllocForSpecifiedReservesBPS = totalAllocForSpecifiedReserves.mul(FULL_BPS);
      if (totalAllocForSpecifiedReservesBPS.lt(minTotalAllocationForSpecifiedReservesBPS)) {
        return null;
      }
    }

    // Calculate allocation weights sum
    let allocationWeightsSum = new Decimal(0);
    allocation.forEach((weight) => {
      allocationWeightsSum = allocationWeightsSum.add(weight);
    });

    // Wrap the APY computation with timeout to prevent hanging
    try {
      return await withTimeout(
        computeStabilizationFactorForVault(
          allocation,
          reservesWithCurrentAllocations,
          allocationWeightsSum,
          vaultAUMTokens,
          allInvestedInReservesTokens,
          currentLedgerInstant,
          compoundingPeriods,
          shouldIncludeFarmRewards,
          localFarmsClient,
          farmsToFarmStateMap,
          pricesMap,
          verbose,
          projectionContext
        ),
        120000, // 120 second timeout
        'computeStabilizationFactorForVault'
      );
    } catch (error) {
      logger.error(`[maxYieldOptimizers] Error in evaluateAllocation: ${error}`);
      return null;
    }
  }

  const searchResult = await runCoarseToFineSearch({
    candidatesCount: countReservesInAllocation,
    coarseResolution,
    mediumResolution: mediumRes,
    fineResolution: fineRes,
    mediumRadius,
    fineRadius,
    initialScore: new Decimal(Infinity),
    evaluate: evaluateAllocation,
    score: (result) => result.stabilizationFactor,
    isBetter: (candidate, currentBest) => candidate.lt(currentBest),
    describe: (result) =>
      `stabilization factor: ${result.stabilizationFactor.toString()} and APY: ${result.apy.toString()}`,
    verbose,
  });
  if (!searchResult) {
    logger.warn(
      `[allocation-rebalance-loop] Stabilization search found no feasible allocation (every evaluation failed). Falling back to current weights.`
    );
    const current = new Map<Address, Decimal>();
    reservesWithCurrentAllocations.forEach((reserve) => current.set(reserve.reserve.address, reserve.allocation));
    return {
      reservesWithAllocation: current,
      apy: new Decimal(0),
      stabilizationFactor: new Decimal(Infinity),
    };
  }

  // Denormalize allocations and prepare result
  const finalAllocation = searchResult.allocation.map((val) => val.mul(allocationWeightsSum));
  const bestAllocationWithReserves = new Map<Address, Decimal>();
  for (let index = 0; index < reservesWithCurrentAllocations.length; index++) {
    bestAllocationWithReserves.set(reservesWithCurrentAllocations[index].reserve.address, finalAllocation[index]);
  }

  logger.info(
    `[allocation-rebalance-loop] Coarse-to-fine best allocation: ${bestAllocationWithReserves.toString()} with stabilization factor: ${searchResult.evaluation.stabilizationFactor.toString()}`
  );

  return {
    reservesWithAllocation: bestAllocationWithReserves,
    stabilizationFactor: searchResult.evaluation.stabilizationFactor,
    apy: searchResult.evaluation.apy,
  };
}
