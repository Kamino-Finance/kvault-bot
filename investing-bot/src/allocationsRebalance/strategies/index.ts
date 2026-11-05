import { registerStrategy } from '../strategyRegistry.js';
import { computeEqualTarget, computeFixedWeightsTarget, computeRandomTarget, computeUnchangedTarget } from './basic.js';
import {
  computeMaxYieldStableTarget,
  computeMaxYieldTarget,
  computeMaxYieldWithFixedReservesTarget,
} from './maxYield.js';
import {
  computeMaxYieldDrippingTarget,
  getMaxYieldDrippingAllocationFilter,
  applyMaxYieldDrippingDrift,
  MAX_YIELD_DRIPPING_CONFIG_FIELDS,
  MAX_YIELD_DRIPPING_DRIFT_RATE,
} from './maxYieldDripping.js';

/** The names of the built-in strategies. The config loader accepts any registered name. */
export enum RebalanceStrategy {
  EQUAL = 'EQUAL',
  MAX_YIELD = 'MAX_YIELD',
  RANDOM = 'RANDOM',
  MAX_YIELD_WITH_FIXED_RESERVES = 'MAX_YIELD_WITH_FIXED_RESERVES',
  UNCHANGED = 'UNCHANGED',
  MAX_YIELD_STABLE = 'MAX_YIELD_STABLE', // achieve aggressive yield but with secondary goal of stabilizing the yields of the reserves
  FIXED_WEIGHTS = 'FIXED_WEIGHTS',
  MAX_YIELD_DRIPPING = 'MAX_YIELD_DRIPPING', // achieve aggressive yield but prevent sharp changes in reserve allocation(smoother APY shifts)
}

// Registration order is the order of the README strategies table.
registerStrategy({
  name: RebalanceStrategy.EQUAL,
  description: 'Equal weight to every reserve.',
  configFields: [],
  behaviours: {
    preservedAccounting: false,
    fixedReserveFloors: false,
    fixedReserveWeights: false,
    supportsDrift: true,
  },
  computeTarget: computeEqualTarget,
});
registerStrategy({
  name: RebalanceStrategy.MAX_YIELD,
  description:
    'Coarse-to-fine grid search over the full allocation space to maximize vault APY; applies the optimum immediately.',
  configFields: [],
  behaviours: { preservedAccounting: true, fixedReserveFloors: false, fixedReserveWeights: false, supportsDrift: true },
  computeTarget: computeMaxYieldTarget,
});
registerStrategy({
  name: RebalanceStrategy.MAX_YIELD_STABLE,
  description:
    'Minimizes the spread between simulated reserve yields. APY is reported, but is not currently a tie-breaker in the optimizer.',
  configFields: [],
  behaviours: { preservedAccounting: true, fixedReserveFloors: true, fixedReserveWeights: false, supportsDrift: true },
  computeTarget: computeMaxYieldStableTarget,
});
registerStrategy({
  name: RebalanceStrategy.MAX_YIELD_WITH_FIXED_RESERVES,
  description:
    '`MAX_YIELD` with a minimum combined search allocation (`reservesAllocationPercentageBPS`) across a named set of reserves (`fixedReserves`); emitted weights remain subject to runtime deposit and withdrawal constraints.',
  configFields: [],
  behaviours: { preservedAccounting: true, fixedReserveFloors: true, fixedReserveWeights: false, supportsDrift: true },
  computeTarget: computeMaxYieldWithFixedReservesTarget,
});
registerStrategy({
  name: RebalanceStrategy.MAX_YIELD_DRIPPING,
  description:
    'Computes the `MAX_YIELD` target — optionally utilization-bounded (opt-in, see `enforceUtilizationCap`) — and moves a configurable fraction of the current-to-target gap per iteration (`drippingRatePercent`, default 20%) before applying runtime constraints. See the exact behavior below.',
  configFields: MAX_YIELD_DRIPPING_CONFIG_FIELDS,
  behaviours: { preservedAccounting: true, fixedReserveFloors: false, fixedReserveWeights: false, supportsDrift: true },
  computeTarget: computeMaxYieldDrippingTarget,
  getAllocationFilter: getMaxYieldDrippingAllocationFilter,
  applyDrift: applyMaxYieldDrippingDrift,
  ownDriftRate: MAX_YIELD_DRIPPING_DRIFT_RATE,
});
registerStrategy({
  name: RebalanceStrategy.FIXED_WEIGHTS,
  description:
    "Explicit per-reserve weights from config (`fixedReserves` given as `{ reserve, weight }` objects), read as shares: the bot writes them on the vault's current weight total, so the share the vault leaves unallocated stays. `fixedReserves` must list every healthy reserve of the vault. When one is missing, the bot logs an error and keeps the vault's current weights; it still zeroes blacklisted reserves.",
  configFields: [],
  behaviours: { preservedAccounting: false, fixedReserveFloors: false, fixedReserveWeights: true, supportsDrift: true },
  computeTarget: computeFixedWeightsTarget,
});
registerStrategy({
  name: RebalanceStrategy.RANDOM,
  description: 'Random weights — testing/experimentation only.',
  configFields: [],
  behaviours: {
    preservedAccounting: false,
    fixedReserveFloors: false,
    fixedReserveWeights: false,
    supportsDrift: true,
  },
  computeTarget: computeRandomTarget,
});
registerStrategy({
  name: RebalanceStrategy.UNCHANGED,
  description: 'No-op; recomputes the current APY without changing the allocation.',
  configFields: [],
  behaviours: {
    preservedAccounting: true,
    fixedReserveFloors: false,
    fixedReserveWeights: false,
    supportsDrift: false,
  },
  computeTarget: computeUnchangedTarget,
});

// A fork adds its own strategies here, after the built-ins, with one call per strategy:
//
//   registerStrategy({
//     name: 'MY_STRATEGY',
//     description: 'What it does, for the README strategies table.',
//     configFields: [],
//     behaviours: { preservedAccounting: true, fixedReserveFloors: false, fixedReserveWeights: false, supportsDrift: true },
//     computeTarget: async (ctx) => ({ weights: myTargetWeights(ctx) }),
//   });
//
// Then run `yarn config:generate` so the README tables list it.
