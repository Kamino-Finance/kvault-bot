import { Decimal } from 'decimal.js';
import { lamportsToDecimal } from '@kamino-finance/klend-sdk';
import { DEFAULT_PUBLIC_KEY } from 'kvaults-investing-bot-tx/instruction';
import type { StrategyContext } from '../strategyRegistry.js';
import { AllocationWithAPY, getYieldSimulation } from './maxYieldOptimizers.js';
import { computeVaultTargetAllocation, simulateReserveYield } from './allocationHelper.js';

/**
 * Builds a log message with the overview of the reserves in the vault, current invested amount in them and the new
 * invested amount after rebalancing to `allocation`.
 */
export async function buildReservesAllocationLog(ctx: StrategyContext, allocation: AllocationWithAPY): Promise<string> {
  const { allVaultReserves, currentLedgerInstant } = ctx;
  const { vaultState } = ctx.vaultContext;
  const investedInReservesTokens = ctx.vaultContext.allInvestedInReservesTokensMap;
  const sim = getYieldSimulation(ctx);
  let logMsg = 'Reserves overview: ';
  const targetAllocation = computeVaultTargetAllocation(
    allocation.reservesWithAllocation,
    ctx.vaultContext.allocationProjectionContext
  );
  for (const reserveAlloc of vaultState.vaultAllocationStrategy) {
    if (reserveAlloc.reserve === DEFAULT_PUBLIC_KEY) {
      continue;
    }
    const kReserve = allVaultReserves.get(reserveAlloc.reserve);
    if (!kReserve) {
      continue;
    }

    const toInvestInReserveTokens =
      targetAllocation.targetReservesAllocation.get(reserveAlloc.reserve) ?? new Decimal(0);

    const reserveCollExchangeRate = kReserve.getEstimatedCollateralExchangeRate(currentLedgerInstant, 0);
    const reserveAllocationLiquidityAmountLamports = new Decimal(reserveAlloc.ctokenAllocation.toString()).div(
      reserveCollExchangeRate
    );
    const reserveAllocationLiquidityAmountTokens = lamportsToDecimal(
      reserveAllocationLiquidityAmountLamports,
      vaultState.tokenMintDecimals.toNumber()
    );

    const totalSupplyTokens = lamportsToDecimal(
      kReserve.getEstimatedTotalSupply(currentLedgerInstant, 0),
      vaultState.tokenMintDecimals.toNumber()
    );

    const { lendingYield: simulatedReserveSupplyApy, farmYield: simulatedReserveSupplyFarmAPY } =
      await simulateReserveYield(
        kReserve,
        toInvestInReserveTokens,
        investedInReservesTokens.get(kReserve.address)!,
        sim
      );
    const totalSimulatedApy = simulatedReserveSupplyApy.add(simulatedReserveSupplyFarmAPY);

    const reserveLogMsg = `${kReserve.address.toString()}; total_supplied_tokens: ${totalSupplyTokens.toString()}; total_borrowed_tokens: ${kReserve.getBorrowTvl()}; current_apy: ${kReserve.totalSupplyAPY(currentLedgerInstant)}; simulated_supply_apy_with_new_allocation: ${simulatedReserveSupplyApy.toString()}; simulated_farm_apy_with_new_allocation: ${simulatedReserveSupplyFarmAPY.toString()}; total_simulated_apy_with_new_allocation: ${totalSimulatedApy.toString()}; to_supply_in_reserve: ${toInvestInReserveTokens} currently_supplied_in_vault: ${reserveAllocationLiquidityAmountTokens};`;
    logMsg += reserveLogMsg;
  }
  return logMsg;
}
