import { Decimal } from 'decimal.js';
import { AccountRole, Address, IInstruction } from '@solana/kit';
import { logger } from 'kvaults-investing-bot-logger';
import { ConnectionPool } from '../ConnectionPool.js';

export async function getPriorityFeeForIxs(c: ConnectionPool, ixs: IInstruction[]): Promise<Decimal | undefined> {
  const accs = uniqueWriteAccounts(ixs);
  const { feePerCu, source } = await c.getPriorityFeeProvider().getPriorityFeeForAccounts(accs);
  logger.info(`Using ${source} priority fee: ${feePerCu.microLamports()} uLamports/CU`);
  return feePerCu.microLamports();
}

export function uniqueWriteAccounts(ixs: IInstruction[]): Address[] {
  const uniqueAccounts: Array<Address> = ixs
    .filter((ix) => ix.accounts)
    .map((ix) => ix.accounts!.filter((k) => k.role === AccountRole.WRITABLE).map((k) => k.address))
    .flat();
  return [...new Set(uniqueAccounts)];
}
