import { Address, TransactionSigner } from '@solana/kit';
import { ConnectionPool } from 'kvaults-investing-bot-tx/ConnectionPool';
import { WalletBalances } from '../../models/WalletBalance.js';
export type MintWithDecimalsAndTokenProgram = {
    mint: Address;
    decimals: number;
    tokenProgram: Address;
};
export declare function getWalletBalances(c: ConnectionPool, mintsWithDecimalsAndTokenProgram: Array<MintWithDecimalsAndTokenProgram>, wallet: TransactionSigner): Promise<WalletBalances>;
//# sourceMappingURL=wallet.d.ts.map