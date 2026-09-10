import { Decimal } from 'decimal.js';
import { Rpc } from '@solana/kit';
import type { Address } from '@solana/addresses';
import type { MicroLamports, Slot } from '@solana/rpc-types';
export type RpcPriorityFees = {
    min: Decimal;
    max: Decimal;
    average: Decimal;
    median: Decimal;
};
export type PercentileConfig = {
    percentile: number;
};
/**
 * Response object
 */
export type RecentPrioritizationFeePercentile = Readonly<{
    /**
     * The per-compute-unit fee paid by at least one successfully
     * landed transaction, specified in increments of
     * micro-lamports (0.000001 lamports).
     */
    prioritizationFee: MicroLamports;
    /** Slot in which the fee was observed */
    slot: Slot;
}>;
type GetRecentPrioritizationFeesPercentileApiResponse = readonly RecentPrioritizationFeePercentile[];
export type GetRecentPrioritizationFeesPercentileApi = {
    /**
     * Returns the recent prioritization fees
     */
    getRecentPrioritizationFees(addresses?: Address[], percentile?: PercentileConfig): GetRecentPrioritizationFeesPercentileApiResponse;
};
/**
 * Supports the [Triton improved recent priority fee api](https://docs.triton.one/chains/solana/improved-priority-fees-api) which adds a percentile parameter to the getRecentPrioritizationFees rpc call.
 * @param rpc
 * @param addresses
 * @param percentile
 */
export declare function getRpcRecentFeesOfPercentile(rpc: Rpc<GetRecentPrioritizationFeesPercentileApi>, addresses?: Address[], percentile?: PercentileConfig): Promise<RpcPriorityFees>;
export {};
//# sourceMappingURL=triton.d.ts.map