import { findAssociatedTokenPda, getSyncNativeInstruction, fetchAllMaybeToken, getCreateAssociatedTokenIdempotentInstruction, } from '@solana-program/token-2022';
import { getTransferSolInstruction } from '@solana-program/system';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { WRAPPED_SOL_MINT } from 'kvaults-investing-bot-tx/instruction';
import { batchFetch } from './utils/batch.js';
export function getDepositWsolIxns(owner, ata, amountLamports) {
    const ixns = [];
    ixns.push(getTransferSolInstruction({
        amount: BigInt(amountLamports.toString()),
        source: owner,
        destination: ata,
    }));
    ixns.push(getCreateAssociatedTokenIdempotentInstruction({
        owner: owner.address,
        payer: owner,
        ata: ata,
        mint: WRAPPED_SOL_MINT,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
    }));
    ixns.push(getSyncNativeInstruction({ account: ata }, { programAddress: TOKEN_PROGRAM_ADDRESS }));
    return ixns;
}
export async function getAssociatedTokenAddress(mint, owner, tokenProgram = TOKEN_PROGRAM_ADDRESS) {
    const [ata] = await findAssociatedTokenPda({
        mint,
        owner,
        tokenProgram,
    });
    return ata;
}
export function batchFetchAllMaybeToken(rpc, addresses) {
    return batchFetch(addresses, (chunk) => fetchAllMaybeToken(rpc, chunk));
}
//# sourceMappingURL=tokenOperations.js.map