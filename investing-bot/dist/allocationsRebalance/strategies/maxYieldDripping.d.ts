import { Decimal } from 'decimal.js';
import { KaminoManager, KaminoReserve, KaminoVault, LedgerInstant } from '@kamino-finance/klend-sdk';
import { Address, TransactionSigner } from '@solana/kit';
import { FarmState } from '@kamino-finance/farms-sdk';
import { AllocationWithAPYAndIxs } from '../utils/maxYieldOptimizers.js';
/**
 * Interpolates each reserve's weight `dripRatePercent`% of the way from its
 * current weight toward its target weight, then rounds the allocation vector
 * to integer weights while preserving the current total:
 * drippedWeight = currentWeight + dripRate * (targetWeight - currentWeight)
 *
 * A reserve present in the target but absent from the current weights drips
 * from a current weight of 0.
 */
export declare function computeDrippedWeights(currentWeights: Map<Address, Decimal>, targetWeights: Map<Address, Decimal>, dripRatePercent: number): Map<Address, Decimal>;
export interface MaxYieldDrippingStrategyRequest {
    kaminoManager: KaminoManager;
    kaminoVault: KaminoVault;
    vaultsReserves: Map<Address, KaminoReserve>;
    signer: TransactionSigner;
    currentLedgerInstant: LedgerInstant;
    gridSearchResolution: number;
    shouldIncludeFarmRewards: boolean;
    drippingRatePercent?: number;
    compoundingPeriods?: number;
    farmsToFarmStateMap?: Map<Address, FarmState>;
    pricesMap?: Map<Address, Decimal>;
    verbose?: boolean;
    enforceUtilizationCap?: boolean;
    maxUtilizationChangeBps?: number;
    allVaultReserves?: Map<Address, KaminoReserve>;
    preservedReserves?: ReadonlySet<string>;
    forcedZeroReserves?: ReadonlySet<string>;
}
export declare function getMaxYieldDrippingAllocationRebalanceIxs({ kaminoManager, kaminoVault, vaultsReserves, signer, currentLedgerInstant, gridSearchResolution, shouldIncludeFarmRewards, drippingRatePercent, compoundingPeriods, farmsToFarmStateMap, pricesMap, verbose, enforceUtilizationCap, maxUtilizationChangeBps, allVaultReserves, preservedReserves, forcedZeroReserves, }: MaxYieldDrippingStrategyRequest): Promise<AllocationWithAPYAndIxs>;
//# sourceMappingURL=maxYieldDripping.d.ts.map