import { Address, TransactionSigner } from '@solana/kit';
import { VaultState } from '@kamino-finance/klend-sdk';
import { ConnectionPool } from 'kvaults-investing-bot-tx/ConnectionPool';
import { batchFetchAllMaybeToken, getAssociatedTokenAddress } from '../tokenOperations.js';

export type MintWithDecimalsAndTokenProgram = {
  mint: Address;
  decimals: number;
  tokenProgram: Address;
};

/** The distinct token mints of the vaults, in first-seen order. */
export function getVaultTokenMints(vaultStates: VaultState[]): MintWithDecimalsAndTokenProgram[] {
  const mints = new Map<Address, MintWithDecimalsAndTokenProgram>();
  for (const vaultState of vaultStates) {
    if (!mints.has(vaultState.tokenMint)) {
      mints.set(vaultState.tokenMint, {
        mint: vaultState.tokenMint,
        decimals: vaultState.tokenMintDecimals.toNumber(),
        tokenProgram: vaultState.tokenProgram,
      });
    }
  }
  return Array.from(mints.values());
}

/** The wallet's balance of each mint in base units, from its associated token accounts; 0 without an account. */
export async function getWalletBalances(
  c: ConnectionPool,
  mints: Array<MintWithDecimalsAndTokenProgram>,
  wallet: TransactionSigner
): Promise<Map<Address, bigint>> {
  const tokenAccountAddresses = await Promise.all(
    mints.map(({ mint, tokenProgram }) => getAssociatedTokenAddress(mint, wallet.address, tokenProgram))
  );
  const tokenAccounts = await batchFetchAllMaybeToken(c.getRpc(), tokenAccountAddresses);
  return new Map(mints.map(({ mint }, i) => [mint, tokenAccounts[i].exists ? tokenAccounts[i].data.amount : 0n]));
}
