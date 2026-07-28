import { Lamports, Address } from '@solana/kit';
import { Decimal } from 'decimal.js';

export type WalletBalances = {
  liquidityBalances: TokenBalance[];
};

export type TokenBalance = {
  mint: Address;
  /**
   * The balance with decimals
   */
  balance: Decimal;
  balanceBase: Lamports;
  ata: Address;
};

export type TokenBalanceWithValue = TokenBalance & {
  value: Decimal;
  valueBaseSymbol: string;
};
