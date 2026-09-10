import { Decimal } from 'decimal.js';
import { KaminoManager, KaminoReserve, KaminoVault, LedgerInstant } from '@kamino-finance/klend-sdk';
import { FarmState } from '@kamino-finance/farms-sdk';
import { Address, TransactionSigner } from '@solana/kit';
import { AllocationWithAPYAndIxs, AllocationWithStabilizationFactorAndAPYAndIxs } from '../utils/maxYieldOptimizers.js';
interface MaxYieldStrategyRequest {
    kaminoManager: KaminoManager;
    kaminoVault: KaminoVault;
    vaultsReserves: Map<Address, KaminoReserve>;
    signer: TransactionSigner;
    currentLedgerInstant: LedgerInstant;
    gridSearchResolution: number;
    shouldIncludeFarmRewards: boolean;
    compoundingPeriods?: number;
    reservesWithMinAllocation?: Address[];
    minTotalAllocationForSpecifiedReservesBPS?: Decimal;
    farmsToFarmStateMap?: Map<Address, FarmState>;
    pricesMap?: Map<Address, Decimal>;
    verbose?: boolean;
    allVaultReserves?: Map<Address, KaminoReserve>;
    preservedReserves?: ReadonlySet<string>;
    forcedZeroReserves?: ReadonlySet<string>;
}
export declare function getMaxYieldAllocationRebalanceIxs({ kaminoManager, kaminoVault, vaultsReserves, signer, currentLedgerInstant, gridSearchResolution, shouldIncludeFarmRewards, compoundingPeriods, reservesWithMinAllocation, minTotalAllocationForSpecifiedReservesBPS, farmsToFarmStateMap, pricesMap, verbose, allVaultReserves, preservedReserves, forcedZeroReserves, }: MaxYieldStrategyRequest): Promise<AllocationWithAPYAndIxs>;
export declare function getMaxYieldStabilizationAllocationRebalanceIxs({ kaminoManager, kaminoVault, vaultsReserves, signer, currentLedgerInstant, gridSearchResolution, shouldIncludeFarmRewards, compoundingPeriods, reservesWithMinAllocation, minTotalAllocationForSpecifiedReservesBPS, farmsToFarmStateMap, pricesMap, verbose, allVaultReserves, preservedReserves, forcedZeroReserves, }: MaxYieldStrategyRequest): Promise<AllocationWithStabilizationFactorAndAPYAndIxs>;
export {};
//# sourceMappingURL=maxYield.d.ts.map