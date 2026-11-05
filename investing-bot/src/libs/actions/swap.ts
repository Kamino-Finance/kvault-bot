import { Account, Instruction } from '@solana/kit';
import { Decimal } from 'decimal.js';
import { AddressLookupTable } from '@solana-program/address-lookup-table';

export enum SwapMode {
  ExactIn = 'exactIn',
  ExactOut = 'exactOut',
}

export type SwapResponse = {
  swapInAmountLamports: Decimal;
  /** Maximum input-token base units the route may debit (includes ExactOut slippage). */
  swapMaxInAmountLamports: Decimal;
  swapOutAmountLamports: Decimal;
  swapMinOutAmountLamports: Decimal;
  slippageBps: number;
};

export type SwapTxResponse = {
  router: string;
  swapIxs: Instruction[];
  swapLookupTableAccounts: Account<AddressLookupTable>[];
  swapResponse: SwapResponse;
};
