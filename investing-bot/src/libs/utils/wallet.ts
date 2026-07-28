import { Decimal } from 'decimal.js';
import { Account, Address, lamports, TransactionSigner } from '@solana/kit';
import { Token as TokenAccount } from '@solana-program/token-2022';
import { ConnectionPool } from 'kvaults-investing-bot-tx/ConnectionPool';
import { WRAPPED_SOL_MINT } from 'kvaults-investing-bot-tx/instruction';
import { batchFetchAllMaybeToken, getAssociatedTokenAddress } from '../tokenOperations.js';
import { TokenBalance, WalletBalances } from '../../models/WalletBalance.js';
import { fromLamports } from './math.js';

type BalanceInfo = {
  mint: Address;
  decimals: number;
  tokenProgram: Address;
};

type BalanceInfoAndAcc = BalanceInfo & {
  ata: Address;
  tokenAccount?: Account<TokenAccount>;
};

export type MintWithDecimalsAndTokenProgram = {
  mint: Address;
  decimals: number;
  tokenProgram: Address;
};

export async function getWalletBalances(
  c: ConnectionPool,
  mintsWithDecimalsAndTokenProgram: Array<MintWithDecimalsAndTokenProgram>,
  wallet: TransactionSigner
): Promise<WalletBalances> {
  const liquidityMints: Array<BalanceInfo> = [];
  for (const { mint, decimals, tokenProgram } of mintsWithDecimalsAndTokenProgram) {
    liquidityMints.push({
      mint,
      decimals,
      tokenProgram,
    });
  }

  const allMints = liquidityMints;
  const allTokenAccKeys = await Promise.all(
    allMints.map(async ({ mint, tokenProgram }) => getAssociatedTokenAddress(mint, wallet.address, tokenProgram))
  );
  const allTokenAccs = await batchFetchAllMaybeToken(c.getRpc(), allTokenAccKeys);

  const liquidityTokenAccs: Array<BalanceInfoAndAcc> = [];
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

function getBalances(liquidityTokenAccs: Array<BalanceInfoAndAcc>): TokenBalance[] {
  const liquidityBalances: TokenBalance[] = [];
  for (const { mint, decimals, ata, tokenAccount } of liquidityTokenAccs) {
    const tokenBalance = getTokenBalance(mint, ata, decimals, tokenAccount);
    liquidityBalances.push(tokenBalance);
  }
  return liquidityBalances;
}

function getTokenBalance(
  mintAddress: Address,
  ata: Address,
  decimals: number,
  tokenAccount?: Account<TokenAccount>
): TokenBalance {
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
