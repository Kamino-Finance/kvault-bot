import { Decimal } from 'decimal.js';
import { Address } from '@solana/kit';
import { logger } from 'kvaults-investing-bot-logger';
import { AllocationWithAPY } from '../utils/maxYieldOptimizers.js';
import { calculateTotalWeight } from '../utils/allocationConstraints.js';
import { DEFAULT_ALLOCATION_WEIGHT } from '../consts.js';
import { StrategyContext, StrategyTarget } from '../strategyRegistry.js';
import { computeWeightsApy } from './common.js';

/**
 * The APY of `weights`, scored like the drift step scores its weights. The APY only feeds the allocation log, so a
 * scoring failure logs a warning and reports 0 instead of failing the pass.
 */
export async function scoreWeights(ctx: StrategyContext, weights: Map<Address, Decimal>): Promise<Decimal> {
  if (calculateTotalWeight(weights).lte(0)) {
    return new Decimal(0);
  }
  try {
    return await computeWeightsApy(ctx, weights);
  } catch (error) {
    logger.warn(
      `[allocation-rebalance-loop] Failed to compute the APY for vault ${ctx.kaminoVault.address.toString()}: ${error}`
    );
    return new Decimal(0);
  }
}

/** The current allocation of the healthy reserves and its APY. The pipeline logs it for an 'unchanged' target. */
export async function getUnchangedAllocation(ctx: StrategyContext): Promise<AllocationWithAPY> {
  const currentReservesAllocations = new Map(ctx.vaultContext.healthyWeights);
  return {
    reservesWithAllocation: currentReservesAllocations,
    apy: await scoreWeights(ctx, currentReservesAllocations),
  };
}

export async function computeUnchangedTarget(): Promise<'unchanged'> {
  return 'unchanged';
}

/**
 * The configured weight of every healthy reserve. `fixedReserves` must list each one: when one is missing, the vault keeps
 * its current weights and the pipeline still zeroes its blacklisted reserves.
 */
export async function computeFixedWeightsTarget(ctx: StrategyContext): Promise<StrategyTarget | 'unchanged'> {
  const { kaminoVault, fixedReservesWeights } = ctx;
  if (!fixedReservesWeights) {
    throw new Error(
      `Fixed reserve weights are required for FIXED_WEIGHTS strategy on vault ${kaminoVault.address.toString()}`
    );
  }
  const weights = new Map<Address, Decimal>();
  const missingReserves: Address[] = [];
  for (const reserve of ctx.vaultContext.healthyWeights.keys()) {
    const fixedReserveWeight = fixedReservesWeights.find(
      ({ reserve: configuredReserve }) => configuredReserve === reserve
    );
    if (fixedReserveWeight) {
      weights.set(reserve, new Decimal(fixedReserveWeight.weight));
    } else {
      missingReserves.push(reserve);
    }
  }
  if (missingReserves.length > 0) {
    logger.error(
      `[allocation-rebalance-loop] FIXED_WEIGHTS vault ${kaminoVault.address.toString()} has no configured weight for healthy reserve(s) ${missingReserves.join(', ')}; keeping its current weights. Add every healthy reserve to fixedReserves.`
    );
    return 'unchanged';
  }
  return { weights };
}

/**
 * A target that gives each healthy reserve, in vault order, the weight `nextWeight` returns for it. The pipeline logs
 * the weights it writes.
 */
async function computePerReserveTarget(ctx: StrategyContext, nextWeight: () => number): Promise<StrategyTarget> {
  const weights = new Map<Address, Decimal>();
  for (const reserve of ctx.vaultContext.healthyWeights.keys()) {
    weights.set(reserve, new Decimal(nextWeight()));
  }
  return { weights };
}

export async function computeEqualTarget(ctx: StrategyContext): Promise<StrategyTarget> {
  return computePerReserveTarget(ctx, () => DEFAULT_ALLOCATION_WEIGHT);
}

export async function computeRandomTarget(ctx: StrategyContext): Promise<StrategyTarget> {
  return computePerReserveTarget(ctx, () => Math.floor(Math.random() * 100_000) + 100);
}
