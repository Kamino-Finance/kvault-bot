import type { KaminoManager, KaminoReserve, VaultState } from '@kamino-finance/klend-sdk';
import type { Address } from '@solana/kit';
export declare const VAULT_RESERVES_MAX_UNIQUE_RESERVES_PER_BATCH: number;
export declare function loadVaultsReservesInBatches(kaminoManager: KaminoManager, vaultStates: VaultState[], label: string, heartbeat?: () => void | Promise<void>, maxUniqueReservesPerBatch?: number): Promise<Map<Address, KaminoReserve>>;
//# sourceMappingURL=vaultReserves.d.ts.map