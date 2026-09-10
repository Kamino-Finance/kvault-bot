import { Address, TransactionSigner, Lamports, Instruction, Account } from '@solana/kit';
import { Decimal } from 'decimal.js';
import { ConnectionPool } from 'kvaults-investing-bot-tx/ConnectionPool';
import { AddressLookupTable } from '@solana-program/address-lookup-table';
import { KSwapConfig, KSwapWrapper } from '../../services/kSwapWrapper.js';
export declare enum SwapMode {
    ExactIn = "exactIn",
    ExactOut = "exactOut"
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
export declare function wrapOrSwap(c: ConnectionPool, swapper: KSwapWrapper, payer: TransactionSigner, fromToken: Address, toToken: Address, amountLamports: Lamports, swapConfig: KSwapConfig, userLuts: Account<AddressLookupTable>[], description?: string): Promise<string>;
//# sourceMappingURL=swap.d.ts.map