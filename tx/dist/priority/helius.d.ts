import type { Address } from '@solana/kit';
import { Rpc } from '@solana/kit';
/**
 * Gets a priority fee estimate using Helius' custom RPC method.
 *
 * Note: Helius does *not* support arbitrary percentile numbers [1-100]. The input percentile will be mapped into one of
 * the coarse-grained {@link PriorityLevel}s.
 */
export declare function getPriorityFeeEstimate(heliusRpc: Rpc<GetPriorityFeeEstimateApi>, addresses: Address[], percentile: number): Promise<number>;
export type GetPriorityFeeEstimateApi = {
    getPriorityFeeEstimate(params: GetPriorityFeeEstimateRequest): GetPriorityFeeEstimateResponse;
};
declare enum PriorityLevel {
    MIN = "Min",
    LOW = "Low",
    MEDIUM = "Medium",
    HIGH = "High",
    VERY_HIGH = "VeryHigh",
    UNSAFE_MAX = "UnsafeMax"
}
interface GetPriorityFeeEstimateOptions {
    priorityLevel?: PriorityLevel;
}
interface GetPriorityFeeEstimateRequest {
    accountKeys: string[];
    options: GetPriorityFeeEstimateOptions;
}
type GetPriorityFeeEstimateResponse = {
    priorityFeeEstimate: number | bigint;
};
export {};
//# sourceMappingURL=helius.d.ts.map