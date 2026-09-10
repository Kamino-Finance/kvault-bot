import { Decimal } from 'decimal.js';
import { KaminoManager, KaminoReserve, LedgerInstant, ReserveAllocationOverview, VaultState } from '@kamino-finance/klend-sdk';
import { Address, IInstruction } from '@solana/kit';
import { Farms, FarmState } from '@kamino-finance/farms-sdk';
import { ReserveWithAllocation, VaultAllocationProjectionContext } from './allocationHelper.js';
export declare const DEFAULT_GRID_SEARCH_RESOLUTION = 0.01;
/**
 * Generates allocation points where each allocation sums exactly to targetSum
 * @param reservesCount The number of reserves in the vault
 * @param resolution The resolution of the allocation grid
 * @param targetSum The target sum of the allocations
 * @returns Array of allocation arrays that sum to targetSum
 */
export declare function generateAllocationPoints(reservesCount: number, resolution: number, targetSum?: number): Decimal[][];
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
export declare function generateRefinementRegionPoints(targetAllocation: Decimal[], radius: number, resolution: number): Decimal[][];
export type Resolutions = {
    coarseResolution: number;
    mediumResolution: number;
    fineResolution: number;
};
export declare function estimateResolutionsFromReservesCountAndCoarseResolution(reservesCount: number, coarseResolution: number): Resolutions;
export type RadiusMultipliers = {
    mediumRadiusMultiplier: number;
    fineRadiusMultiplier: number;
};
/**
 * Try to estimate the medium and fine radius depending on the the number of reserves and the coarse resolution; it is a rough estimate that tries a one size fits all approach, may need fine tuning
 */
export declare function estimateRadiusMultiplierFromReservesCountAndResolution(reservesCount: number): RadiusMultipliers;
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
export declare function buildSearchCandidates(currentReservesAllocations: Map<Address, ReserveAllocationOverview>, reserves: Map<Address, KaminoReserve>, reservesWithMinAllocation: Address[]): {
    reservesWithCurrentAllocations: ReserveWithAllocation[];
    reservesWithMinAllocationIndices: number[];
};
export declare function gridSearchAllocationForMaxApyCoarseToFine(manager: KaminoManager, vault: VaultState, reserves: Map<Address, KaminoReserve>, allocationWeightsSum: Decimal, requestedCoarseResolution: number, currentLedgerInstant: LedgerInstant, vaultAUMTokens: Decimal, investedInReservesTokens: Map<Address, Decimal>, shouldIncludeFarmRewards: boolean, farmsClient?: Farms, mediumResolution?: number, fineResolution?: number, compoundingPeriods?: number, reservesWithMinAllocation?: Address[], minTotalAllocationForSpecifiedReservesBPS?: Decimal, radiusMultiplier?: number, // recommended: 2x coarse resolution for better coverage
farmsToFarmStateMap?: Map<Address, FarmState>, pricesMap?: Map<Address, Decimal>, verbose?: boolean, allocationFilter?: (allocation: Decimal[], reservesWithAllocations: ReserveWithAllocation[]) => boolean, projectionContext?: VaultAllocationProjectionContext, allInvestedInReservesTokens?: Map<Address, Decimal>): Promise<AllocationWithAPY>;
/**
 * Coarse-to-fine grid search for minimum stabilization factor allocation
 * Uses multiple resolution levels to efficiently search the allocation space
 */
export declare function gridSearchAllocationForMinStabilizationFactorCoarseToFine(manager: KaminoManager, vault: VaultState, reserves: Map<Address, KaminoReserve>, allocationWeightsSum: Decimal, requestedCoarseResolution: number, currentLedgerInstant: LedgerInstant, vaultAUMTokens: Decimal, investedInReservesTokens: Map<Address, Decimal>, shouldIncludeFarmRewards: boolean, farmsClient?: Farms, mediumResolution?: number, fineResolution?: number, compoundingPeriods?: number, reservesWithMinAllocation?: Address[], minTotalAllocationForSpecifiedReservesBPS?: Decimal, radiusMultiplier?: number, // recommended: 2x coarse resolution for better coverage
farmsToFarmStateMap?: Map<Address, FarmState>, pricesMap?: Map<Address, Decimal>, verbose?: boolean, projectionContext?: VaultAllocationProjectionContext, allInvestedInReservesTokens?: Map<Address, Decimal>): Promise<AllocationWithStabilizationFactorAndAPY>;
//# sourceMappingURL=maxYieldOptimizers.d.ts.map