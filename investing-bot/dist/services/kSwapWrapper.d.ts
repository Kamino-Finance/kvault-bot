import { Account, Address, Instruction, Lamports, TransactionSigner } from '@solana/kit';
import { KswapSdk, RouteOutput, RouterType } from '@kamino-finance/kswap-sdk';
import { ConnectionPool } from 'kvaults-investing-bot-tx/ConnectionPool';
import { Decimal } from 'decimal.js';
import { AddressLookupTable } from '@solana-program/address-lookup-table';
import { BaseSwapConfig, SwapConfig, SwapMode, SwapResponse, SwapTxResponse } from '../libs/actions/swap.js';
export type KSwapResponse = SwapResponse;
export type KSwapConfig = BaseSwapConfig & {
    withSimulation?: boolean;
    composableRoutersOnly?: boolean;
    filterFailedSimulations?: boolean;
    priceGuard?: SwapPriceGuard;
    balanceGuard?: {
        inputTokenProgramOwner: Address;
        outputTokenProgramOwner: Address;
    };
};
export interface SwapPriceGuard {
    inputTokenPriceUsd: Decimal;
    outputTokenPriceUsd: Decimal;
    inputTokenDecimals: number;
    outputTokenDecimals: number;
    maxSlippageBps: number;
}
export type AssertSwapBalancesTokenInfoParam = {
    mint: Address;
    tokenProgramOwner?: Address;
    ata?: Address;
};
export declare class KSwapWrapper {
    payer: TransactionSigner;
    kswapSdk: KswapSdk;
    routers: RouterType[];
    composableRouters: RouterType[];
    constructor(payer: TransactionSigner, c: ConnectionPool, kswapApiBaseUrl: string, kswapApiKey: string | undefined, excludeRouters: RouterType[]);
    swap(c: ConnectionPool, inputToken: Address, outputToken: Address, inputAmountLamports: Lamports, swapConfig: KSwapConfig, userLuts: Account<AddressLookupTable>[], description?: string): Promise<{
        tx: string;
        response: KSwapResponse;
    }>;
    swapTxFindSuitableRoutes(inputMint: Address, outputMint: Address, amountLamports: Lamports, swapConfig: KSwapConfig, description: string): Promise<SwapTxResponse[]>;
    getAssertSwapBalancesIxs(swapAmountInLamports: Decimal, minSwapAmountOutLamports: Decimal, inputToken: AssertSwapBalancesTokenInfoParam, outputToken: AssertSwapBalancesTokenInfoParam, destinationTokenAccount?: Address): Promise<{
        preAssertBalancesIxs: Instruction[];
        postAssertBalancesIxs: Instruction[];
    }>;
    getRouters(composableRoutersOnly: boolean | undefined): RouterType[] | undefined;
}
export declare class NoSwapRoutesFoundError extends Error {
    constructor();
}
export declare function swapTxFromRoute(route: RouteOutput, swapConfig: SwapConfig): SwapTxResponse;
/**
 * Compare a route's guaranteed amounts against an independently-fetched reference price. This
 * rejects a bad quote before signing; the ledger instructions then enforce the accepted amounts
 * on-chain against the executor's actual token-account deltas.
 */
export declare function assertSwapPriceWithinTolerance(response: KSwapResponse, swapMode: SwapMode | undefined, guard: SwapPriceGuard): void;
//# sourceMappingURL=kSwapWrapper.d.ts.map