import { Decimal } from 'decimal.js';
import { KaminoManager, KaminoReserve, KaminoVault, LedgerInstant } from '@kamino-finance/klend-sdk';
import { Address, IInstruction, TransactionSigner } from '@solana/kit';
import { FarmState } from '@kamino-finance/farms-sdk';
import { FixedReservesWithConfig, ReserveWeight } from './rebalanceConfig.js';
export { getEqualAllocationRebalanceIxs, getFixedWeightsAllocationRebalanceIxs, getRandomAllocationRebalanceIxs, getUnchangedAllocationRebalanceIxs, } from './strategies/basic.js';
export { getMaxYieldAllocationRebalanceIxs, getMaxYieldStabilizationAllocationRebalanceIxs, } from './strategies/maxYield.js';
export declare enum RebalanceStrategy {
    EQUAL = "EQUAL",
    MAX_YIELD = "MAX_YIELD",
    RANDOM = "RANDOM",
    MAX_YIELD_WITH_FIXED_RESERVES = "MAX_YIELD_WITH_FIXED_RESERVES",
    UNCHANGED = "UNCHANGED",// only useful as the strategy for strategies with fixed reserves
    MAX_YIELD_STABLE = "MAX_YIELD_STABLE",// achieve aggressive yield but with secondary goal of stabilizing the yields of the reserves
    FIXED_WEIGHTS = "FIXED_WEIGHTS",
    MAX_YIELD_DRIPPING = "MAX_YIELD_DRIPPING"
}
export interface RebalanceAllocationRequest {
    kaminoManager: KaminoManager;
    kaminoVault: KaminoVault;
    vaultsReserves: Map<Address, KaminoReserve>;
    strategy: RebalanceStrategy;
    signer: TransactionSigner;
    currentLedgerInstant: LedgerInstant;
    gridSearchResolution: number;
    shouldIncludeFarmRewards: boolean;
    fixedReservesConfig?: FixedReservesWithConfig;
    fixedReservesWeights?: ReserveWeight[];
    drippingRatePercent?: number;
    farmsToFarmStateMap?: Map<Address, FarmState>;
    pricesMap?: Map<Address, Decimal>;
    verbose?: boolean;
    blacklistedReserves?: ReadonlySet<string>;
    cooldownReserves?: ReadonlySet<string>;
    enforceUtilizationCap?: boolean;
    maxUtilizationChangeBps?: number;
}
export declare function rebalanceAllocation({ kaminoManager, kaminoVault, vaultsReserves, strategy, signer, currentLedgerInstant, gridSearchResolution, shouldIncludeFarmRewards, fixedReservesConfig, fixedReservesWeights, drippingRatePercent, farmsToFarmStateMap, pricesMap, verbose, blacklistedReserves, cooldownReserves, enforceUtilizationCap, maxUtilizationChangeBps, }: RebalanceAllocationRequest): Promise<IInstruction[]>;
//# sourceMappingURL=rebalanceTypes.d.ts.map