import { Decimal } from 'decimal.js';
import { Address } from '@solana/kit';
import { gridSearch } from '../utils/maxYieldOptimizers.js';
import { StrategyContext, StrategyTarget } from '../strategyRegistry.js';
import { logAllocationResult } from './common.js';

async function computeMaxYieldTargetWithFloors(
  ctx: StrategyContext,
  strategyName: string,
  reservesWithMinAllocation: Address[],
  minTotalAllocationForSpecifiedReservesBPS: Decimal
): Promise<StrategyTarget> {
  const bestAllocation = await gridSearch(ctx, {
    objective: 'MAX_APY',
    reservesWithMinAllocation,
    minTotalAllocationBPS: minTotalAllocationForSpecifiedReservesBPS,
  });
  logAllocationResult(ctx.kaminoVault, strategyName, bestAllocation);
  return { weights: bestAllocation.reservesWithAllocation, apy: bestAllocation.apy };
}

export async function computeMaxYieldTarget(ctx: StrategyContext): Promise<StrategyTarget> {
  return computeMaxYieldTargetWithFloors(ctx, 'MAX_YIELD', [], new Decimal(0));
}

/** MAX_YIELD with a minimum combined search allocation across the vault's `fixedReserves`. */
export async function computeMaxYieldWithFixedReservesTarget(ctx: StrategyContext): Promise<StrategyTarget> {
  return computeMaxYieldTargetWithFloors(
    ctx,
    'MAX_YIELD_WITH_FIXED_RESERVES',
    ctx.fixedReservesConfig.fixedReserves,
    new Decimal(ctx.fixedReservesConfig.reservesAllocationPercentageBPS)
  );
}

export async function computeMaxYieldStableTarget(ctx: StrategyContext): Promise<StrategyTarget> {
  const { fixedReservesConfig } = ctx;
  const bestAllocation = await gridSearch(ctx, {
    objective: 'MIN_STABILIZATION',
    reservesWithMinAllocation: fixedReservesConfig.fixedReserves,
    minTotalAllocationBPS: new Decimal(fixedReservesConfig.reservesAllocationPercentageBPS),
  });
  logAllocationResult(ctx.kaminoVault, 'MAX_YIELD_STABLE', bestAllocation, bestAllocation.score);
  return { weights: bestAllocation.reservesWithAllocation, apy: bestAllocation.apy };
}
