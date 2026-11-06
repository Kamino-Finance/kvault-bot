import { Decimal } from 'decimal.js';

import { Address } from '@solana/kit';
import { logger } from 'kvaults-investing-bot-logger';
import { gridSearch } from '../utils/maxYieldOptimizers.js';
import { computeVaultTargetAllocation, FULL_BPS } from '../utils/allocationHelper.js';
import {
  calculateTotalWeight,
  getTargetTokenConstraintType,
  ReserveConstraints,
} from '../utils/allocationConstraints.js';
import {
  DEFAULT_DRIPPING_RATE_PERCENT,
  DEFAULT_ENFORCE_UTILIZATION_CAP,
  MAX_UTILIZATION_CHANGE_BPS,
} from '../consts.js';
import type { ConfigFieldSpec } from '../../config/schema.js';
import {
  StrategyAllocationFilter,
  StrategyConfig,
  StrategyContext,
  StrategyTarget,
  validateRatePercent,
} from '../strategyRegistry.js';
import { applyDrift, applyHoldingsDrift, DriftResult } from '../drift.js';
import { isUtilizationChangeAllowed } from '../../utils/utilizationCap.js';
import { buildReserveConstraintsBase, FinalAllocationConstraintError } from './common.js';

/** Validates `enforceUtilizationCap`; fails config loading rather than silently disabling the cap. */
function validateEnforceUtilizationCap(value: unknown): void {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new Error(
      `[allocation-rebalance-loop] Invalid enforceUtilizationCap "${value}" in allocation config. ` +
        `Must be true or false.`
    );
  }
}

/** Validates `maxUtilizationChangeBps`; fails config loading rather than silently freezing the vault. */
function validateMaxUtilizationChangeBps(value: unknown): void {
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > FULL_BPS)) {
    throw new Error(
      `[allocation-rebalance-loop] Invalid maxUtilizationChangeBps "${value}" in allocation config. ` +
        `Must be a number in (0, ${FULL_BPS}]. To disable the utilization cap, set enforceUtilizationCap to false.`
    );
  }
}

export const MAX_YIELD_DRIPPING_CONFIG_FIELDS: readonly ConfigFieldSpec[] = [
  {
    name: 'drippingRatePercent',
    level: 'both',
    required: false,
    type: 'number',
    default: `\`${DEFAULT_DRIPPING_RATE_PERCENT}\``,
    description:
      'Percent of the current→target gap closed per iteration. With the utilization cap enabled, movement starts from actual token holdings. Otherwise it starts from configured weights. Must be in `(0, 100]`.',
    validate: validateRatePercent,
  },
  {
    name: 'enforceUtilizationCap',
    level: 'both',
    required: false,
    type: 'boolean',
    default: `\`${DEFAULT_ENFORCE_UTILIZATION_CAP}\``,
    description:
      'Whether to bound the target by the per-reserve utilization cap. Set `true` to opt into utilization-bounded targets.',
    validate: validateEnforceUtilizationCap,
  },
  {
    name: 'maxUtilizationChangeBps',
    level: 'both',
    required: false,
    type: 'number',
    default: `\`${MAX_UTILIZATION_CHANGE_BPS}\` (1%)`,
    description:
      'The per-iteration utilization-change cap in basis points when enforced. Must be in `(0, 10000]`; to disable the cap use `enforceUtilizationCap: false`, not `0`.',
    validate: validateMaxUtilizationChangeBps,
  },
];

/** MAX_YIELD_DRIPPING drifts at its own `drippingRatePercent`, defaulting to DEFAULT_DRIPPING_RATE_PERCENT. */
export const MAX_YIELD_DRIPPING_DRIFT_RATE = {
  field: 'drippingRatePercent',
  defaultPercent: DEFAULT_DRIPPING_RATE_PERCENT,
} as const;

/** The utilization-cap settings for one vault, with their defaults applied. */
export function resolveUtilizationCap(config: StrategyConfig): {
  enforceUtilizationCap: boolean;
  maxUtilizationChangeBps: number;
} {
  return {
    enforceUtilizationCap: (config.enforceUtilizationCap as boolean | undefined) ?? DEFAULT_ENFORCE_UTILIZATION_CAP,
    maxUtilizationChangeBps: (config.maxUtilizationChangeBps as number | undefined) ?? MAX_UTILIZATION_CHANGE_BPS,
  };
}

/** The utilization and capacity checks shared by the search and every final allocation path. */
export function getMaxYieldDrippingAllocationFilter(ctx: StrategyContext): StrategyAllocationFilter | undefined {
  const { healthyVaultsReserves, currentLedgerInstant, vaultContext } = ctx;
  const { enforceUtilizationCap, maxUtilizationChangeBps } = resolveUtilizationCap(ctx.config);
  // Market-impact cap (optional, off by default; enable per-vault with enforceUtilizationCap=true):
  // reject any grid candidate that would move a reserve's utilization by more than
  // maxUtilizationChangeBps (defaults to MAX_UTILIZATION_CHANGE_BPS), or that would hit a chain-side
  // deposit/withdrawal cap. This bounds how hard a single step leans on any reserve's liquidity
  // (adapting to depth: a big move in a deep reserve barely shifts utilization and is allowed; the
  // same move in a thin reserve is rejected). The builder checks the final weights again after drift
  // and capacity adjustments: configured weights can differ from actual holdings.
  let utilizationFilter: ((weights: Map<Address, Decimal>) => boolean) | undefined;
  if (enforceUtilizationCap) {
    const baseConstraintsByReserve = new Map<Address, Omit<ReserveConstraints, 'targetWeight'>>();
    for (const [reserveAddress, weight] of vaultContext.healthyWeights) {
      const reserve = healthyVaultsReserves.get(reserveAddress);
      if (!reserve) {
        continue;
      }
      const investedTokens = vaultContext.investedInReservesTokensMap.get(reserveAddress) ?? new Decimal(0);
      baseConstraintsByReserve.set(
        reserveAddress,
        buildReserveConstraintsBase(reserveAddress, reserve, weight, investedTokens, currentLedgerInstant)
      );
    }
    utilizationFilter = (weights: Map<Address, Decimal>): boolean => {
      const targetAllocation = computeVaultTargetAllocation(weights, vaultContext.allocationProjectionContext);
      for (const reserveAddr of weights.keys()) {
        const reserve = healthyVaultsReserves.get(reserveAddr);
        if (!reserve) {
          continue;
        }
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
        if (
          !isUtilizationChangeAllowed(reserve, currentTokens, newTokens, currentLedgerInstant, maxUtilizationChangeBps)
        ) {
          return false;
        }
      }
      return true;
    };
  }

  return utilizationFilter;
}

/**
 * The MAX_YIELD target over the healthy weight total, optionally bounded by the utilization cap. The pipeline then
 * drips toward it at `drippingRatePercent`.
 */
export async function computeMaxYieldDrippingTarget(ctx: StrategyContext): Promise<StrategyTarget> {
  const { kaminoVault, vaultContext } = ctx;
  if (ctx.fixedReservesConfig.fixedReserves.length > 0) {
    logger.warn(
      `[allocation-rebalance-loop] Fixed reserves are not supported for MAX_YIELD_DRIPPING; ignoring them for vault ${kaminoVault.address.toString()}`
    );
  }
  // The drift gate lives on the healthy weight scale, raised by vaultContext.weightScale like the drift step. The grid
  // search and its utilization filter project candidates on vaultContext.totalAllocationsWeights, the weight total the
  // pipeline writes, so their token targets match the vault after the update.
  const healthyTotalWeight = calculateTotalWeight(vaultContext.healthyWeights);

  // Dripping redistributes an existing allocation; it does not bootstrap an
  // unallocated vault (see README). The drift step stays put on a zero healthy
  // total, so the grid search would be wasted work.
  if (healthyTotalWeight.lte(0)) {
    return { weights: new Map(vaultContext.healthyWeights), apy: new Decimal(0) };
  }

  const utilizationFilter = getMaxYieldDrippingAllocationFilter(ctx);

  // Compute the MAX_YIELD target within the utilization cap. Fixed reserves are not supported for dripping.
  const maxYieldAllocation = await gridSearch(ctx, { objective: 'MAX_APY', allocationFilter: utilizationFilter });

  // The grid search cannot resolve finer than one fine-grid step, so a smaller
  // target gap is optimizer noise, not signal. Sized from the search's fine
  // resolution and the healthy weight total on the drift scale, so blacklisted
  // weight cannot inflate the gate.
  return {
    weights: maxYieldAllocation.reservesWithAllocation,
    apy: maxYieldAllocation.apy,
    noiseFloorWeight: healthyTotalWeight.mul(vaultContext.weightScale).mul(maxYieldAllocation.fineResolution),
  };
}

/** With a market-impact cap, token movement starts from actual holdings, including unfinished investments. */
export async function applyMaxYieldDrippingDrift(
  ctx: StrategyContext,
  target: StrategyTarget,
  ratePercent: number
): Promise<DriftResult> {
  if (!resolveUtilizationCap(ctx.config).enforceUtilizationCap) {
    return applyDrift('MAX_YIELD_DRIPPING', ctx, target, ratePercent);
  }
  try {
    return await applyHoldingsDrift(ctx, target, ratePercent, getMaxYieldDrippingAllocationFilter(ctx)!);
  } catch (cause) {
    if (cause instanceof FinalAllocationConstraintError) throw cause;
    throw new FinalAllocationConstraintError(ctx.kaminoVault.address, { cause });
  }
}
