import { Decimal } from 'decimal.js';
import { KaminoManager, KaminoReserve, KaminoVault, LedgerInstant } from '@kamino-finance/klend-sdk';
import { Address } from '@solana/kit';
import { Farms, FarmState } from '@kamino-finance/farms-sdk';
import { AllocationWithAPY } from './maxYieldOptimizers.js';
/**
 * Builds a log message with the overview of the reserves in the vault, current invested amount in them and the new invested amount after rebalancing
 * @param kaminoManager
 * @param kaminoVault
 * @param vaultsReserves map from Address to the KaminoReserve state for all the reserves in the vault
 * @param allocation the new allocation
 * @param currentLedgerInstant
 */
export declare function buildReservesAllocationLog(kaminoManager: KaminoManager, kaminoVault: KaminoVault, vaultsReserves: Map<Address, KaminoReserve>, allocation: AllocationWithAPY, currentLedgerInstant: LedgerInstant, shouldIncludeFarmRewards: boolean, farmsClient: Farms, farmsToFarmStateMap?: Map<Address, FarmState>, pricesMap?: Map<Address, Decimal>, allVaultReserves?: Map<Address, KaminoReserve>, forcedZeroReserves?: ReadonlySet<string>): Promise<string>;
//# sourceMappingURL=logging.d.ts.map