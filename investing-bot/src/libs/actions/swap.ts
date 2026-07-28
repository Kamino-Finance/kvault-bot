import { Address, TransactionSigner, Lamports, Instruction, Account } from '@solana/kit';
import { Decimal } from 'decimal.js';
import { lamportsToDecimal } from '@kamino-finance/klend-sdk';
import { WRAPPED_SOL_MINT } from 'kvaults-investing-bot-tx/instruction';
import { ConnectionPool } from 'kvaults-investing-bot-tx/ConnectionPool';
import { AddressLookupTable } from '@solana-program/address-lookup-table';
import { getAssociatedTokenAddress } from '../tokenOperations.js';
import { wrapSol } from '../rebalanceWallet.js';
import { KSwapConfig, KSwapWrapper } from '../../services/kSwapWrapper.js';

export enum SwapMode {
  ExactIn = 'exactIn',
  ExactOut = 'exactOut',
}

export type SwapConfig = BaseSwapConfig & KSwapConfig;

/**
 * Common swap config
 */
export type BaseSwapConfig = {
  txAccounts?: Set<Address>;
  txAccountsBuffer?: number;
  onlyDirectRoutes?: boolean;
  wrapAndUnwrapSol?: boolean;
  slippageBps: number;
  destinationTokenAccount?: Address;
  feePerCUMicroLamports?: Decimal;
  swapMode?: SwapMode;
  useTokenLedger?: boolean;
};

export type LocalQuoteResponse = {
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
};

export type SwapQuoteResponse = LocalQuoteResponse;

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
  swapTxs: SwapTxs;
  swapLookupTableAccounts: Account<AddressLookupTable>[];
  swapResponse: SwapResponse;
};

export type SwapTxs = {
  computeBudgetIxs: Instruction[];
  tokenLedgerIxs: Instruction[];
  setupIxs: Instruction[];
  swapIxs: Instruction[];
  cleanupIxs: Instruction[];
};

/**
 * If the swap is between SOL and SOL wrap
 */
export async function wrapOrSwap(
  c: ConnectionPool,
  swapper: KSwapWrapper,
  payer: TransactionSigner,
  fromToken: Address,
  toToken: Address,
  amountLamports: Lamports,
  swapConfig: KSwapConfig,
  userLuts: Account<AddressLookupTable>[],
  description: string = 'SOL wrap/unwrap'
): Promise<string> {
  if (fromToken === WRAPPED_SOL_MINT && toToken === WRAPPED_SOL_MINT) {
    const wsolAta = await getAssociatedTokenAddress(WRAPPED_SOL_MINT, payer.address);
    return await wrapSol(c, payer, wsolAta, lamportsToDecimal(new Decimal(amountLamports.toString()), 9));
  } else {
    return (await swapper.swap(c, fromToken, toToken, amountLamports, swapConfig, userLuts, description)).tx;
  }
}
