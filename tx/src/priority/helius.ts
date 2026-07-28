import type { Address } from '@solana/kit';
import { Rpc } from '@solana/kit';
import { logger } from 'kvaults-investing-bot-logger';

/**
 * Gets a priority fee estimate using Helius' custom RPC method.
 *
 * Note: Helius does *not* support arbitrary percentile numbers [1-100]. The input percentile will be mapped into one of
 * the coarse-grained {@link PriorityLevel}s.
 */
export async function getPriorityFeeEstimate(
  heliusRpc: Rpc<GetPriorityFeeEstimateApi>,
  addresses: Address[],
  percentile: number
): Promise<number> {
  const priorityLevel = resolvePriorityLevel(percentile);
  logger.info(`Fetching ${priorityLevel} priority fee from RPC for ${addresses.length || 'all global'} accounts`);
  const response = await heliusRpc
    .getPriorityFeeEstimate({
      accountKeys: addresses.map((address) => address.toString()),
      options: { priorityLevel },
    })
    .send();
  return Number(response.priorityFeeEstimate);
}

/**
 * Resolves a coarse-grained priority level for the given percentile.
 *
 * Follows the mapping at https://docs.helius.dev/solana-apis/priority-fee-api#how-priority-fee-api-works.
 */
function resolvePriorityLevel(percentile: number) {
  if (percentile == 100) {
    return PriorityLevel.UNSAFE_MAX;
  }
  if (percentile >= 95) {
    return PriorityLevel.VERY_HIGH;
  }
  if (percentile >= 75) {
    return PriorityLevel.HIGH;
  }
  if (percentile >= 50) {
    return PriorityLevel.MEDIUM;
  }
  if (percentile >= 25) {
    return PriorityLevel.LOW;
  }
  if (percentile >= 0) {
    return PriorityLevel.MIN;
  }
  throw new Error(`Invalid percentile: ${percentile}`);
}

// Below: a relevant excerpt from the custom method's schema, copied from Helius:

export type GetPriorityFeeEstimateApi = {
  getPriorityFeeEstimate(params: GetPriorityFeeEstimateRequest): GetPriorityFeeEstimateResponse;
};

enum PriorityLevel {
  MIN = 'Min',
  LOW = 'Low',
  MEDIUM = 'Medium',
  HIGH = 'High',
  VERY_HIGH = 'VeryHigh',
  UNSAFE_MAX = 'UnsafeMax',
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
