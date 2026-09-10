import { Decimal } from 'decimal.js';
import { ReserveAllocationConfig, VaultAllocation, VaultState } from '@kamino-finance/klend-sdk';
import { Address } from '@solana/kit';
export declare function getReserveAllocationsMap(vaultState: VaultState): Map<Address, Decimal>;
export declare function getVaultAllocationForReserve(vaultState: VaultState, reserve: Address): VaultAllocation | undefined;
export declare function getAllocationCapInTokensOrDefault(vaultState: VaultState, reserve: Address, defaultCapInLamports?: Decimal): Decimal;
export declare function shouldUpdateAllocation(vaultState: VaultState, reserveAllocConfig: ReserveAllocationConfig): boolean;
//# sourceMappingURL=vaultUtils.d.ts.map