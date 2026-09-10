import { Decimal } from 'decimal.js';
import { Address, IInstruction } from '@solana/kit';
import { ConnectionPool } from '../ConnectionPool.js';
export declare function getPriorityFeeForIxs(c: ConnectionPool, ixs: IInstruction[]): Promise<Decimal | undefined>;
export declare function uniqueWriteAccounts(ixs: IInstruction[]): Address[];
//# sourceMappingURL=priorityFeeService.d.ts.map