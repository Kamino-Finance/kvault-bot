import { Decimal } from 'decimal.js';
import { KaminoReserve, LedgerInstant, ReserveAllocationOverview, VaultAllocationResult, VaultState } from '@kamino-finance/klend-sdk';
import { Address } from '@solana/kit';
import { FarmAndKey, FarmIncentives, Farms, FarmState } from '@kamino-finance/farms-sdk';
import { StabilizationFactorAndAPY } from './maxYieldOptimizers.js';
export declare const FULL_BPS = 10000;
export interface VaultAllocationProjectionContext {
    vaultState: VaultState;
    vaultAUMTokens: Decimal;
    currentVaultAllocations: Map<Address, ReserveAllocationOverview>;
    allVaultReserves: Map<Address, KaminoReserve>;
    currentLedgerInstant: LedgerInstant;
    forcedZeroReserves?: ReadonlySet<string>;
}
/**
 * Project proposed weights into the exact token targets used by kvault's
 * `refresh_target_allocations`, via the pinned klend SDK implementation.
 */
export declare function computeVaultTargetAllocation(proposedWeights: ReadonlyMap<Address, Decimal>, context: VaultAllocationProjectionContext): VaultAllocationResult;
export declare function evaluateReserveSupplyYieldWithNewAllocation(reserve: KaminoReserve, newVaultAllocTokens: Decimal, prevVaultAllocTokens: Decimal, currentLedgerInstant: LedgerInstant, compoundPeriods: number): Decimal;
export declare function evaluateReserveSupplyFarmRewardsYieldWithNewAllocation(farmsClient: Farms, farmWithKey: FarmAndKey, newVaultAllocTokens: Decimal, prevVaultAllocTokens: Decimal, stakedTokenPrice: Decimal, // cToken price
tokenDecimals: number, pricesMap: Map<Address, Decimal>): Promise<FarmIncentives>;
export declare function getSimulatedReserveSupplyFarmAPY(newReserveAllocTokens: Decimal, prevReserveAllocTokens: Decimal, reserve: KaminoReserve, farmsClient: Farms, farmsToFarmStateMap: Map<Address, FarmState>, pricesMap: Map<Address, Decimal>): Promise<Decimal>;
export declare function computeOverallVaultApy(normalizedAllocation: Decimal[], reservesWithCurrentAllocations: ReserveWithAllocation[], allocationWeightsSum: Decimal, vaultAUMTokens: Decimal, investedInReservesTokens: Map<Address, Decimal>, currentLedgerInstant: LedgerInstant, compoundingPeriods: number, shouldIncludeFarmRewards: boolean, farmsClient: Farms, farmsToFarmStateMap?: Map<Address, FarmState>, // if shouldIncludeFarmRewards is true, this is required
pricesMap?: Map<Address, Decimal>, // if shouldIncludeFarmRewards is true, this is required
verbose?: boolean, projectionContext?: VaultAllocationProjectionContext): Promise<Decimal>;
export declare function computeOverallVaultAPYFromReservesMap(reservesWithAllocations: Map<Address, Decimal>, previousVaultAllocations: Map<Address, Decimal>, vaultAUMTokens: Decimal, investedInReservesTokens: Map<Address, Decimal>, vaultsReserves: Map<Address, KaminoReserve>, currentLedgerInstant: LedgerInstant, compoundingPeriods: number, verbose?: boolean, projectionContext?: VaultAllocationProjectionContext): Decimal;
export declare function computeStabilizationFactorForVault(normalizedAllocation: Decimal[], reservesWithCurrentAllocations: ReserveWithAllocation[], allocationWeightsSum: Decimal, vaultAUMTokens: Decimal, investedInReservesTokens: Map<Address, Decimal>, currentLedgerInstant: LedgerInstant, compoundingPeriods: number, shouldIncludeFarmRewards: boolean, farmsClient: Farms, farmsToFarmStateMap?: Map<Address, FarmState>, // if shouldIncludeFarmRewards is true, this is required
pricesMap?: Map<Address, Decimal>, // if shouldIncludeFarmRewards is true, this is required
verbose?: boolean, projectionContext?: VaultAllocationProjectionContext): Promise<StabilizationFactorAndAPY>;
export type ReserveWithAllocation = {
    reserve: KaminoReserve;
    allocation: Decimal;
};
export declare function getVaultTotalAllocationsWeights(kaminoVault: VaultState): Decimal;
//# sourceMappingURL=allocationHelper.d.ts.map