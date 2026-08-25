import { Decimal } from 'decimal.js';
import { KaminoManager, KaminoReserve, KaminoVault, lamportsToDecimal, LedgerInstant } from '@kamino-finance/klend-sdk';
import { Address } from '@solana/kit';
import { DEFAULT_PUBLIC_KEY } from 'kvaults-investing-bot-tx/instruction';
import { Farms, FarmState } from '@kamino-finance/farms-sdk';
import { AllocationWithAPY } from './maxYieldOptimizers.js';
import {
  computeVaultTargetAllocation,
  evaluateReserveSupplyYieldWithNewAllocation,
  getSimulatedReserveSupplyFarmAPY,
} from './allocationHelper.js';

/**
 * Builds a log message with the overview of the reserves in the vault, current invested amount in them and the new invested amount after rebalancing
 * @param kaminoManager
 * @param kaminoVault
 * @param vaultsReserves map from Address to the KaminoReserve state for all the reserves in the vault
 * @param allocation the new allocation
 * @param currentLedgerInstant
 */
export async function buildReservesAllocationLog(
  kaminoManager: KaminoManager,
  kaminoVault: KaminoVault,
  vaultsReserves: Map<Address, KaminoReserve>,
  allocation: AllocationWithAPY,
  currentLedgerInstant: LedgerInstant,
  shouldIncludeFarmRewards: boolean,
  farmsClient: Farms,
  farmsToFarmStateMap?: Map<Address, FarmState>,
  pricesMap?: Map<Address, Decimal>,
  allVaultReserves: Map<Address, KaminoReserve> = vaultsReserves,
  forcedZeroReserves: ReadonlySet<string> = new Set()
): Promise<string> {
  const vaultState = await kaminoVault.getState(); // the vault state should have been already loaded so this shouldn't make any RPC calls

  const vaultHoldings = await kaminoManager.getVaultHoldings(
    vaultState,
    currentLedgerInstant,
    allVaultReserves,
    currentLedgerInstant
  );
  const investedInReservesTokens = vaultHoldings.investedInReserves;
  let logMsg = 'Reserves overview: ';
  const aumWithoutFeesTokens = vaultHoldings.totalAUMIncludingFees.sub(vaultHoldings.pendingFees ?? 0);
  const targetAllocation = computeVaultTargetAllocation(allocation.reservesWithAllocation, {
    vaultState,
    vaultAUMTokens: aumWithoutFeesTokens,
    currentVaultAllocations: kaminoManager.getVaultAllocations(vaultState),
    allVaultReserves,
    currentLedgerInstant,
    forcedZeroReserves,
  });
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

    const simulatedReserveSupplyApy = evaluateReserveSupplyYieldWithNewAllocation(
      kReserve,
      toInvestInReserveTokens,
      investedInReservesTokens.get(kReserve.address)!,
      currentLedgerInstant,
      1
    );

    let simulatedReserveSupplyFarmAPY = new Decimal(0);
    if (shouldIncludeFarmRewards && kReserve.state.farmCollateral !== DEFAULT_PUBLIC_KEY) {
      simulatedReserveSupplyFarmAPY = await getSimulatedReserveSupplyFarmAPY(
        toInvestInReserveTokens,
        investedInReservesTokens.get(kReserve.address)!,
        kReserve,
        farmsClient,
        farmsToFarmStateMap!,
        pricesMap!
      );
    }
    const totalSimulatedApy = simulatedReserveSupplyApy.add(simulatedReserveSupplyFarmAPY);

    const reserveLogMsg = `${kReserve.address.toString()}; total_supplied_tokens: ${totalSupplyTokens.toString()}; total_borrowed_tokens: ${kReserve.getBorrowTvl()}; current_apy: ${kReserve.totalSupplyAPY(currentLedgerInstant)}; simulated_supply_apy_with_new_allocation: ${simulatedReserveSupplyApy.toString()}; simulated_farm_apy_with_new_allocation: ${simulatedReserveSupplyFarmAPY.toString()}; total_simulated_apy_with_new_allocation: ${totalSimulatedApy.toString()}; to_supply_in_reserve: ${toInvestInReserveTokens} currently_supplied_in_vault: ${reserveAllocationLiquidityAmountTokens};`;
    logMsg += reserveLogMsg;
  }
  return logMsg;
}
