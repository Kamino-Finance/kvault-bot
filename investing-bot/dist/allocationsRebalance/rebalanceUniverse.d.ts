import { Decimal } from 'decimal.js';
import { KaminoManager, KaminoReserve, KaminoVault, VaultState } from '@kamino-finance/klend-sdk';
import { Address, IInstruction, TransactionSigner } from '@solana/kit';
export interface RebalanceUniverse {
    healthyVaultReserves: Map<Address, KaminoReserve>;
    blacklistedVaultReserves: Set<string>;
    cooldownVaultReserves: Set<string>;
    forcedZeroIxs: IInstruction[];
}
export declare function getVaultReserveAddressesInUniverse(kaminoManager: KaminoManager, vaultState: VaultState, vaultsReserves: Map<Address, KaminoReserve>): Address[];
export declare function getReserveAllocationsForUniverse(vaultState: VaultState, vaultsReserves: Map<Address, KaminoReserve>): Map<Address, Decimal>;
export declare function getInvestedReservesForUniverse(investedInReservesTokens: Map<Address, Decimal>, vaultsReserves: Map<Address, KaminoReserve>): Map<Address, Decimal>;
/**
 * Build the canonical reserve universe once, before any strategy logic runs.
 */
export declare function buildRebalanceUniverse(kaminoManager: KaminoManager, kaminoVault: KaminoVault, vaultsReserves: Map<Address, KaminoReserve>, signer: TransactionSigner, blacklistedReserves: ReadonlySet<string>, cooldownReserves?: ReadonlySet<string>): Promise<RebalanceUniverse>;
export declare function buildBlacklistEnforcementIxs(kaminoManager: KaminoManager, kaminoVault: KaminoVault, vaultsReserves: Map<Address, KaminoReserve>, signer: TransactionSigner, blacklistedReserves: ReadonlySet<string>, cooldownReserves: ReadonlySet<string>): Promise<IInstruction[]>;
//# sourceMappingURL=rebalanceUniverse.d.ts.map