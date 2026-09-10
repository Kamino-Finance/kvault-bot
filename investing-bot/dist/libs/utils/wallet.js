import { Decimal } from 'decimal.js';
import { lamports } from '@solana/kit';
import { WRAPPED_SOL_MINT } from 'kvaults-investing-bot-tx/instruction';
import { batchFetchAllMaybeToken, getAssociatedTokenAddress } from '../tokenOperations.js';
import { fromLamports } from './math.js';
export async function getWalletBalances(c, mintsWithDecimalsAndTokenProgram, wallet) {
    const liquidityMints = [];
    for (const { mint, decimals, tokenProgram } of mintsWithDecimalsAndTokenProgram) {
        liquidityMints.push({
            mint,
            decimals,
            tokenProgram,
        });
    }
    const allMints = liquidityMints;
    const allTokenAccKeys = await Promise.all(allMints.map(async ({ mint, tokenProgram }) => getAssociatedTokenAddress(mint, wallet.address, tokenProgram)));
    const allTokenAccs = await batchFetchAllMaybeToken(c.getRpc(), allTokenAccKeys);
    const liquidityTokenAccs = [];
    allTokenAccs.forEach((acc, i) => {
        liquidityTokenAccs.push({
            ...allMints[i],
            ata: allTokenAccKeys[i],
            tokenAccount: acc.exists ? acc : undefined,
        });
    });
    const liquidityBalances = getBalances(liquidityTokenAccs);
    const solBalance = await c.getRpc().getBalance(wallet.address).send();
    liquidityBalances.push({
        mint: WRAPPED_SOL_MINT,
        balance: new Decimal(fromLamports(solBalance.value, 9)),
        balanceBase: solBalance.value,
        ata: wallet.address,
    });
    return {
        liquidityBalances,
    };
}
function getBalances(liquidityTokenAccs) {
    const liquidityBalances = [];
    for (const { mint, decimals, ata, tokenAccount } of liquidityTokenAccs) {
        const tokenBalance = getTokenBalance(mint, ata, decimals, tokenAccount);
        liquidityBalances.push(tokenBalance);
    }
    return liquidityBalances;
}
function getTokenBalance(mintAddress, ata, decimals, tokenAccount) {
    if (!tokenAccount) {
        return {
            mint: mintAddress,
            balance: new Decimal('0'),
            balanceBase: lamports(0n),
            ata,
        };
    }
    return {
        mint: mintAddress,
        balance: new Decimal(fromLamports(tokenAccount.data.amount, decimals)),
        balanceBase: lamports(tokenAccount.data.amount),
        ata,
    };
}
//# sourceMappingURL=wallet.js.map