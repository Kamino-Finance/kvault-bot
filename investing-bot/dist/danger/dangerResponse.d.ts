import { KaminoManager, KaminoVault, KaminoReserve } from '@kamino-finance/klend-sdk';
import { Address, KeyPairSigner } from '@solana/kit';
import { ConnectionPool } from 'kvaults-investing-bot-tx/ConnectionPool';
import { sendAndConfirmTransactionV0 } from 'kvaults-investing-bot-tx/instruction';
/**
 * Injectable side-effecting dependencies, so the safety-critical control flow can be unit-tested
 * without real on-chain sends. Defaults to the real implementation.
 */
export interface DangerResponseDeps {
    sendTx?: typeof sendAndConfirmTransactionV0;
    delay?: (milliseconds: number) => Promise<void>;
}
/**
 * Execute emergency deinvestment for a vault: zero the allocation weight while
 * preserving the configured cap for all dangerous reserves, then trigger invest.
 */
export declare function executeDangerResponse(dangerousReserveAddresses: Set<string>, kaminoManager: KaminoManager, kaminoVault: KaminoVault, vaultsReservesMap: Map<Address, KaminoReserve>, allocationAdmin: KeyPairSigner, c: ConnectionPool, deps?: DangerResponseDeps): Promise<void>;
//# sourceMappingURL=dangerResponse.d.ts.map