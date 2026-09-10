import { Decimal } from 'decimal.js';
import { KaminoManager, VaultState } from '@kamino-finance/klend-sdk';
import { Address } from '@solana/kit';
export declare function vaultHasExposureToReserves(kaminoManager: KaminoManager, vaultState: VaultState, investedInReservesTokens: Map<Address, Decimal>, reserveAddresses: ReadonlySet<string>): boolean;
export declare function shouldBlockVaultInvestmentForDanger(kaminoManager: KaminoManager, vaultState: VaultState, investedInReservesTokens: Map<Address, Decimal>, blacklistedReserves: ReadonlySet<string>, pendingEvacuations: ReadonlySet<string>): boolean;
//# sourceMappingURL=vaultExposure.d.ts.map