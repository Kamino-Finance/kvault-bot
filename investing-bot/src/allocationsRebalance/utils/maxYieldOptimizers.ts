import { performance } from 'node:perf_hooks';
import { Decimal } from 'decimal.js';
// Coarse-to-fine grid search over the allocation of a vault's reserves

import { KaminoReserve, ReserveAllocationOverview } from '@kamino-finance/klend-sdk';
import { Address, IInstruction } from '@solana/kit';
import { logger } from 'kvaults-investing-bot-logger';
import { Farms } from '@kamino-finance/farms-sdk';
import { withTimeout } from '../../utils/timeout.js';
import { SETTINGS } from '../../config/settings.js';
import type { StrategyContext } from '../strategyRegistry.js';
import {
  computeStabilizationFactor,
  FULL_BPS,
  ReserveWithAllocation,
  simulateVaultYield,
  SimulatedVaultYield,
  VaultYieldSimulation,
} from './allocationHelper.js';

export const DEFAULT_GRID_SEARCH_RESOLUTION: number = SETTINGS.GRID_SEARCH_RESOLUTION.default;

/** The limits of one whole coarse-to-fine search, across all its phases. */
export interface GridSearchBudget {
  /** The maximum number of candidate allocations the search generates plus the number it evaluates. */
  maxCandidates: number;
  /** The maximum wall-clock time of the search, in milliseconds. */
  maxMs: number;
  /** The clock, in milliseconds. */
  now: () => number;
  /** Called while the search runs, at most once per second of `now()` time. */
  onProgress?: () => void;
}

export const DEFAULT_GRID_SEARCH_BUDGET: GridSearchBudget = {
  maxCandidates: SETTINGS.GRID_SEARCH_MAX_CANDIDATES.default,
  maxMs: SETTINGS.GRID_SEARCH_MAX_MS.default,
  now: () => performance.now(),
};

export type GridSearchPhase = 'coarse' | 'medium' | 'fine';

/**
 * A coarse-to-fine search stopped because it reached a `GridSearchBudget` limit: before its next generated or
 * evaluated candidate, during an evaluation, or after its last phase. `candidatesCounted` is the candidates generated
 * plus the candidates evaluated. `elapsedMs` is rounded to an integer.
 */
export class GridSearchBudgetExceededError extends Error {
  constructor(
    readonly reservesCount: number,
    readonly coarseResolution: number,
    readonly phase: GridSearchPhase,
    readonly candidatesCounted: number,
    readonly elapsedMs: number
  ) {
    super(
      `grid search budget exceeded: ${candidatesCounted} candidates in ${elapsedMs} ms (${reservesCount} reserves, resolution ${coarseResolution}, phase ${phase})`
    );
    this.name = 'GridSearchBudgetExceededError';
  }
}

/** Every grid-search candidate evaluation failed. */
export class GridSearchNoFeasibleAllocationError extends Error {
  constructor(searchName: string) {
    super(`${searchName} found no feasible allocation (every evaluation failed)`);
    this.name = 'GridSearchNoFeasibleAllocationError';
  }
}

/**
 * Generates allocation points where each allocation sums exactly to targetSum
 * @param reservesCount The number of reserves in the vault
 * @param resolution The resolution of the allocation grid
 * @param targetSum The target sum of the allocations
 * @param countPoint Called once for each generated point, before the point list is complete; it may throw to stop
 * @returns Array of allocation arrays that sum to targetSum
 */
export function generateAllocationPoints(
  reservesCount: number,
  resolution: number,
  targetSum: number = 1,
  countPoint: () => void = () => {}
): Decimal[][] {
  const R = Math.floor(targetSum / resolution);

  // Recursive function to generate combinations that sum exactly to 'rem'
  function rec(k: number, rem: number): number[][] {
    if (k === 1) {
      // Base case: only one allocation left, it must equal rem to sum to R
      countPoint();
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

export type AllocationWithAPY = {
  reservesWithAllocation: Map<Address, Decimal>;
  apy: Decimal;
};

export type AllocationWithAPYAndIxs = {
  bestAllocation: AllocationWithAPY;
  ixns: IInstruction[];
};

/**
 * Generates allocation points within a refinement region around a target allocation
 * @param targetAllocation The center allocation to refine around
 * @param radius The maximum distance from target for each component
 * @param resolution The resolution for the refinement grid
 * @param countPoint Called once for each generated point, before the point list is complete; it may throw to stop
 * @returns Array of allocation arrays that sum to 1.0 and are within radius of target
 */
export function generateRefinementRegionPoints(
  targetAllocation: Decimal[],
  radius: number,
  resolution: number,
  countPoint: () => void = () => {}
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
          countPoint();
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

/**
 * Grid search settings by reserve count. The first row whose `minReserves` the count reaches applies. A larger count
 * searches a coarser grid in a smaller radius, so the number of candidates stays bounded.
 */
const SEARCH_SETTINGS_BY_RESERVES_COUNT = [
  { minReserves: 10, minCoarse: 0.2, medium: 0.1, fine: 0.02, mediumRadius: 0.4, fineRadius: 0.3 },
  { minReserves: 8, minCoarse: 0.15, medium: 0.05, fine: 0.02, mediumRadius: 0.6, fineRadius: 0.5 },
  { minReserves: 6, minCoarse: 0.12, medium: 0.04, fine: 0.015, mediumRadius: 0.7, fineRadius: 0.6 },
  { minReserves: 4, minCoarse: 0.08, medium: 0.04, fine: 0.01, mediumRadius: 1, fineRadius: 1.1 },
  { minReserves: 2, minCoarse: 0.05, medium: 0.025, fine: 0.005, mediumRadius: 1.5, fineRadius: 2 },
];
const FALLBACK_SEARCH_SETTINGS = {
  minReserves: 0,
  minCoarse: 0.05,
  medium: 0.025,
  fine: 0.005,
  mediumRadius: 1,
  fineRadius: 1,
};

function getSearchSettings(reservesCount: number) {
  return SEARCH_SETTINGS_BY_RESERVES_COUNT.find((row) => reservesCount >= row.minReserves) ?? FALLBACK_SEARCH_SETTINGS;
}

function formatWeights(weights: Map<Address, Decimal>): string {
  return [...weights].map(([reserve, weight]) => `${reserve.toString()}: ${weight.toString()}`).join(', ');
}

export function estimateResolutionsFromReservesCountAndCoarseResolution(
  reservesCount: number,
  coarseResolution: number
): Resolutions {
  const settings = getSearchSettings(reservesCount);
  return {
    coarseResolution: Math.max(settings.minCoarse, coarseResolution),
    mediumResolution: settings.medium,
    fineResolution: settings.fine,
  };
}

export type RadiusMultipliers = {
  mediumRadiusMultiplier: number;
  fineRadiusMultiplier: number;
};

/** The medium and fine search radius multipliers for the number of reserves; a rough one-size-fits-all estimate. */
export function estimateRadiusMultiplierFromReservesCountAndResolution(reservesCount: number): RadiusMultipliers {
  const settings = getSearchSettings(reservesCount);
  return { mediumRadiusMultiplier: settings.mediumRadius, fineRadiusMultiplier: settings.fineRadius };
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
  budget: GridSearchBudget;
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
  budget,
}: CoarseToFineSearchConfig<T>): Promise<CoarseToFineSearchResult<T> | null> {
  const startMs = budget.now();
  let candidatesCounted = 0;
  let lastProgressElapsedMs = 0;
  function budgetExceeded(phase: GridSearchPhase, elapsedMs: number): GridSearchBudgetExceededError {
    return new GridSearchBudgetExceededError(
      candidatesCount,
      coarseResolution,
      phase,
      candidatesCounted,
      Math.round(elapsedMs)
    );
  }
  // The one counting point: every generated and every evaluated candidate of every phase goes through here, and a
  // limit stops the next one. Returns the elapsed time in milliseconds.
  function countCandidate(phase: GridSearchPhase): number {
    const elapsedMs = budget.now() - startMs;
    if (candidatesCounted >= budget.maxCandidates || elapsedMs >= budget.maxMs) {
      throw budgetExceeded(phase, elapsedMs);
    }
    candidatesCounted++;
    // Throttled: this runs thousands of times per second, and each progress call can be a worker message.
    if (budget.onProgress && elapsedMs - lastProgressElapsedMs >= 1_000) {
      lastProgressElapsedMs = elapsedMs;
      budget.onProgress();
    }
    return elapsedMs;
  }
  // An evaluation gets only the time left in the budget; a timeout there is a budget error for the current phase.
  async function evaluateWithinBudget(allocation: Decimal[], phase: GridSearchPhase): Promise<T | null> {
    const remainingMs = budget.maxMs - countCandidate(phase);
    // Settle the evaluation into a value, so that the only rejection of withTimeout is its own timeout.
    const outcome = await withTimeout(
      evaluate(allocation).then(
        (value) => ({ value }),
        (error: unknown) => ({ error })
      ),
      remainingMs,
      'grid search candidate evaluation'
    ).catch(() => {
      throw budgetExceeded(phase, budget.now() - startMs);
    });
    if ('error' in outcome) {
      throw outcome.error;
    }
    return outcome.value;
  }

  if (verbose) {
    logger.info(`[allocation-rebalance-loop] Phase 1: Coarse search with resolution ${coarseResolution}`);
  }

  const coarsePoints = generateAllocationPoints(candidatesCount, coarseResolution, 1, () => countCandidate('coarse'));
  let bestScore = initialScore;
  let secondBestScore = initialScore;
  let bestAllocation: Decimal[] = [];
  let secondBestAllocation: Decimal[] = [];
  let bestEvaluation: T | undefined;

  for (const allocation of coarsePoints) {
    const evaluation = await evaluateWithinBudget(allocation, 'coarse');
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
      .flatMap((candidate) =>
        generateRefinementRegionPoints(candidate, mediumRadius, mediumResolution, () => countCandidate('medium'))
      )
      .map((point) => point.map((value) => value.toString()).join(','))
  );
  const mediumPoints = Array.from(mediumPointKeys).map((key) => key.split(',').map((value) => new Decimal(value)));

  for (const allocation of mediumPoints) {
    const evaluation = await evaluateWithinBudget(allocation, 'medium');
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
  const finePoints = generateRefinementRegionPoints(bestAllocation, fineRadius, fineResolution, () =>
    countCandidate('fine')
  );
  for (const allocation of finePoints) {
    const evaluation = await evaluateWithinBudget(allocation, 'fine');
    if (evaluation !== null && isBetter(score(evaluation), bestScore)) {
      bestScore = score(evaluation);
      bestAllocation = allocation;
      selectedEvaluation = evaluation;
    }
  }
  logger.info(
    `[allocation-rebalance-loop] Fine search completed. Best ${describe(selectedEvaluation)}, evaluated ${finePoints.length} points`
  );

  // A search that ends past its deadline returns no result, so the vault does not rebalance on it.
  const elapsedMs = budget.now() - startMs;
  if (elapsedMs >= budget.maxMs) {
    throw budgetExceeded('fine', elapsedMs);
  }
  return { allocation: bestAllocation, evaluation: selectedEvaluation };
}

export type GridSearchObjective = 'MAX_APY' | 'MIN_STABILIZATION';

/** One scored candidate: its APY and its score by the search objective. */
interface CandidateEvaluation {
  apy: Decimal;
  score: Decimal;
}

interface ObjectiveSpec {
  searchName: string;
  scoreName: string;
  initialScore: Decimal;
  score: (simulated: SimulatedVaultYield) => Decimal;
  isBetter: (candidate: Decimal, currentBest: Decimal) => boolean;
  describe: (evaluation: CandidateEvaluation) => string;
}

const OBJECTIVES: Record<GridSearchObjective, ObjectiveSpec> = {
  MAX_APY: {
    searchName: 'Grid search',
    scoreName: 'yield',
    initialScore: new Decimal(-Infinity),
    score: (simulated) => simulated.apy,
    isBetter: (candidate, currentBest) => candidate.gt(currentBest),
    describe: ({ apy }) => `APY: ${apy.toString()}`,
  },
  MIN_STABILIZATION: {
    searchName: 'Stabilization search',
    scoreName: 'stabilization factor',
    initialScore: new Decimal(Infinity),
    score: (simulated) => computeStabilizationFactor(simulated.reserveYields),
    isBetter: (candidate, currentBest) => candidate.lt(currentBest),
    describe: ({ apy, score }) => `stabilization factor: ${score.toString()} and APY: ${apy.toString()}`,
  },
};

export interface GridSearchOptions {
  objective: GridSearchObjective;
  /** Reserves whose combined share of a candidate must reach `minTotalAllocationBPS`. */
  reservesWithMinAllocation?: Address[];
  minTotalAllocationBPS?: Decimal;
  /**
   * Rejects a candidate before it is scored, like a candidate under the minimum allocation (e.g. MAX_YIELD_DRIPPING's
   * utilization cap). It gets the candidate's weights on the vault's weight total.
   */
  allocationFilter?: (weights: Map<Address, Decimal>) => boolean;
}

export interface GridSearchResult extends AllocationWithAPY {
  /** The objective's score of the result. */
  score: Decimal;
  /** The fine resolution the search used. */
  fineResolution: number;
}

/** The yield simulation inputs of a strategy context, shared by the grid search and the reported APY. */
export function getYieldSimulation(ctx: StrategyContext): VaultYieldSimulation {
  return {
    investedInReservesTokens: ctx.vaultContext.allInvestedInReservesTokensMap,
    currentLedgerInstant: ctx.currentLedgerInstant,
    shouldIncludeFarmRewards: ctx.shouldIncludeFarmRewards,
    farmsClient: new Farms(ctx.kaminoManager.getRpc()),
    farmsToFarmStateMap: ctx.farmsToFarmStateMap,
    pricesMap: ctx.pricesMap,
    verbose: ctx.verbose,
    projectionContext: ctx.vaultContext.allocationProjectionContext,
  };
}

/**
 * Coarse-to-fine grid search over the healthy reserves for the best allocation by `options.objective`. A candidate sums
 * to 1. It is scored on the vault's weight total, because the projection compares its weights with the on-chain weights
 * of the reserves outside the search and with the vault's unallocated weight.
 */
export async function gridSearch(ctx: StrategyContext, options: GridSearchOptions): Promise<GridSearchResult> {
  const objective = OBJECTIVES[options.objective];
  const { vaultContext, verbose } = ctx;
  const weightTotal = vaultContext.totalAllocationsWeights;
  const minTotalAllocationBPS = options.minTotalAllocationBPS ?? new Decimal(0);
  const reservesCount = vaultContext.investedInReservesTokensMap.size;
  const { coarseResolution, mediumResolution, fineResolution } =
    estimateResolutionsFromReservesCountAndCoarseResolution(reservesCount, ctx.gridSearchResolution);
  const radiusMultipliers = estimateRadiusMultiplierFromReservesCountAndResolution(reservesCount);

  // Calculate adaptive radius based on coarse resolution
  const mediumRadius = coarseResolution * radiusMultipliers.mediumRadiusMultiplier;
  const fineRadius = mediumRadius * radiusMultipliers.fineRadiusMultiplier;

  if (verbose) {
    logger.info(
      `[allocation-rebalance-loop] Coarse-to-fine search: coarse=${coarseResolution}, medium=${mediumResolution}, fine=${fineResolution}`
    );
    logger.info(`[allocation-rebalance-loop] Search radius: medium=${mediumRadius}, fine=${fineRadius}`);
  }

  // Build the candidate reserves from the supplied universe and the aligned min-allocation indices.
  const { reservesWithCurrentAllocations, reservesWithMinAllocationIndices } = buildSearchCandidates(
    ctx.kaminoManager.getVaultAllocations(vaultContext.vaultState),
    ctx.healthyVaultsReserves,
    options.reservesWithMinAllocation ?? []
  );

  // With every candidate reserve outside the supplied universe there is nothing to optimize over.
  // Return an empty allocation; callers can still apply external enforcement instructions.
  if (reservesWithCurrentAllocations.length === 0) {
    logger.warn('[allocation-rebalance-loop] No healthy reserves to allocate across; returning empty allocation');
    return { reservesWithAllocation: new Map(), apy: new Decimal(0), score: new Decimal(0), fineResolution };
  }

  const sim = getYieldSimulation(ctx);
  function toWeights(allocation: Decimal[]): Map<Address, Decimal> {
    return new Map(
      allocation.map((share, index) => [reservesWithCurrentAllocations[index].reserve.address, share.mul(weightTotal)])
    );
  }

  // Helper function to evaluate allocation and check constraints
  async function evaluateAllocation(allocation: Decimal[]): Promise<CandidateEvaluation | null> {
    // Yield to prevent blocking
    await new Promise((resolve) => setImmediate(resolve));
    const weights = toWeights(allocation);

    // Reject candidates the caller's filter rejects (e.g. the dripping utilization cap) before scoring.
    if (options.allocationFilter && !options.allocationFilter(weights)) {
      return null;
    }

    // Check minimum allocation constraints
    if (reservesWithMinAllocationIndices.length > 0) {
      let totalAllocForSpecifiedReserves = new Decimal(0);
      for (const index of reservesWithMinAllocationIndices) {
        totalAllocForSpecifiedReserves = totalAllocForSpecifiedReserves.add(allocation[index]);
      }
      const totalAllocForSpecifiedReservesBPS = totalAllocForSpecifiedReserves.mul(FULL_BPS);
      if (totalAllocForSpecifiedReservesBPS.lt(minTotalAllocationBPS)) {
        return null;
      }
    }

    // Wrap the APY computation with timeout to prevent hanging
    try {
      const simulated = await withTimeout(
        simulateVaultYield(weights, sim),
        120000, // 120 second timeout
        'simulateVaultYield'
      );
      return { apy: simulated.apy, score: objective.score(simulated) };
    } catch (error) {
      logger.error(`[maxYieldOptimizers] Error in evaluateAllocation: ${error}`);
      return null;
    }
  }

  const searchResult = await runCoarseToFineSearch({
    candidatesCount: reservesWithCurrentAllocations.length,
    coarseResolution,
    mediumResolution,
    fineResolution,
    mediumRadius,
    fineRadius,
    initialScore: objective.initialScore,
    evaluate: evaluateAllocation,
    score: (evaluation) => evaluation.score,
    isBetter: objective.isBetter,
    describe: objective.describe,
    verbose,
    budget: ctx.gridSearchBudget,
  });
  if (!searchResult) {
    // The on-chain weights are not on the scale of the vault's weight total, so they cannot stand in for a target.
    throw new GridSearchNoFeasibleAllocationError(objective.searchName);
  }

  const bestAllocationWithReserves = toWeights(searchResult.allocation);
  logger.info(
    `[allocation-rebalance-loop] Coarse-to-fine best allocation: ${formatWeights(bestAllocationWithReserves)} with ${objective.scoreName}: ${searchResult.evaluation.score.toString()}`
  );

  return {
    reservesWithAllocation: bestAllocationWithReserves,
    apy: searchResult.evaluation.apy,
    score: searchResult.evaluation.score,
    fineResolution,
  };
}
