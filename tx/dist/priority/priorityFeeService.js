import { AccountRole } from '@solana/kit';
import { logger } from 'kvaults-investing-bot-logger';
export async function getPriorityFeeForIxs(c, ixs) {
    const accs = uniqueWriteAccounts(ixs);
    const { feePerCu, source } = await c.getPriorityFeeProvider().getPriorityFeeForAccounts(accs);
    logger.info(`Using ${source} priority fee: ${feePerCu.microLamports()} uLamports/CU`);
    return feePerCu.microLamports();
}
export function uniqueWriteAccounts(ixs) {
    const uniqueAccounts = ixs
        .filter((ix) => ix.accounts)
        .map((ix) => ix.accounts.filter((k) => k.role === AccountRole.WRITABLE).map((k) => k.address))
        .flat();
    return [...new Set(uniqueAccounts)];
}
//# sourceMappingURL=priorityFeeService.js.map