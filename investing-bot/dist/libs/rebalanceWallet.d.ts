import { Decimal } from 'decimal.js';
import { Address, TransactionSigner } from '@solana/kit';
import { ConnectionPool } from 'kvaults-investing-bot-tx/ConnectionPool';
export declare function wrapSol(c: ConnectionPool, owner: TransactionSigner, wsolDestinationAta: Address, decimalAmount: Decimal): Promise<string>;
//# sourceMappingURL=rebalanceWallet.d.ts.map