import { Decimal } from 'decimal.js';
import { gridSearchAllocationForMaxApyCoarseToFine, gridSearchAllocationForMinStabilizationFactorCoarseToFine, } from '../utils/maxYieldOptimizers.js';
import { buildAllocationRebalanceInstructions, getVaultContext, logAllocationResult } from './common.js';
export async function getMaxYieldAllocationRebalanceIxs({ kaminoManager, kaminoVault, vaultsReserves, signer, currentLedgerInstant, gridSearchResolution, shouldIncludeFarmRewards, compoundingPeriods = 1, reservesWithMinAllocation = [], minTotalAllocationForSpecifiedReservesBPS = new Decimal(0), farmsToFarmStateMap, pricesMap, verbose = false, allVaultReserves = vaultsReserves, preservedReserves = new Set(), forcedZeroReserves = new Set(), }) {
    const vaultContext = await getVaultContext(kaminoManager, kaminoVault, vaultsReserves, currentLedgerInstant, allVaultReserves, preservedReserves, forcedZeroReserves);
    const bestAllocation = await gridSearchAllocationForMaxApyCoarseToFine(kaminoManager, vaultContext.vaultState, vaultsReserves, vaultContext.totalAllocationsWeights, gridSearchResolution, currentLedgerInstant, vaultContext.vaultAUMTokens, vaultContext.investedInReservesTokensMap, shouldIncludeFarmRewards, undefined, undefined, undefined, compoundingPeriods, reservesWithMinAllocation, minTotalAllocationForSpecifiedReservesBPS, undefined, farmsToFarmStateMap, pricesMap, verbose, undefined, vaultContext.allocationProjectionContext, vaultContext.allInvestedInReservesTokensMap);
    logAllocationResult(kaminoVault, 'MAX_YIELD', bestAllocation, reservesWithMinAllocation);
    return {
        ixns: await buildAllocationRebalanceInstructions(kaminoManager, kaminoVault, vaultContext.vaultState, vaultsReserves, bestAllocation, signer, currentLedgerInstant, allVaultReserves, preservedReserves, forcedZeroReserves),
        bestAllocation,
    };
}
export async function getMaxYieldStabilizationAllocationRebalanceIxs({ kaminoManager, kaminoVault, vaultsReserves, signer, currentLedgerInstant, gridSearchResolution, shouldIncludeFarmRewards, compoundingPeriods = 1, reservesWithMinAllocation = [], minTotalAllocationForSpecifiedReservesBPS = new Decimal(0), farmsToFarmStateMap, pricesMap, verbose = false, allVaultReserves = vaultsReserves, preservedReserves = new Set(), forcedZeroReserves = new Set(), }) {
    const vaultContext = await getVaultContext(kaminoManager, kaminoVault, vaultsReserves, currentLedgerInstant, allVaultReserves, preservedReserves, forcedZeroReserves);
    const bestAllocation = await gridSearchAllocationForMinStabilizationFactorCoarseToFine(kaminoManager, vaultContext.vaultState, vaultsReserves, vaultContext.totalAllocationsWeights, gridSearchResolution, currentLedgerInstant, vaultContext.vaultAUMTokens, vaultContext.investedInReservesTokensMap, shouldIncludeFarmRewards, undefined, undefined, undefined, compoundingPeriods, reservesWithMinAllocation, minTotalAllocationForSpecifiedReservesBPS, undefined, farmsToFarmStateMap, pricesMap, verbose, vaultContext.allocationProjectionContext, vaultContext.allInvestedInReservesTokensMap);
    logAllocationResult(kaminoVault, 'MAX_YIELD_STABLE', bestAllocation, reservesWithMinAllocation, bestAllocation.stabilizationFactor);
    return {
        ixns: await buildAllocationRebalanceInstructions(kaminoManager, kaminoVault, vaultContext.vaultState, vaultsReserves, bestAllocation, signer, currentLedgerInstant, allVaultReserves, preservedReserves, forcedZeroReserves),
        bestAllocation,
    };
}
//# sourceMappingURL=maxYield.js.map