import { Decimal } from 'decimal.js';
import { Rpc } from '@solana/kit';
import type { Address } from '@solana/addresses';
import type { MicroLamports, Slot } from '@solana/rpc-types';
import { logger } from 'kvaults-investing-bot-logger';

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
  getRecentPrioritizationFees(
    addresses?: Address[],
    percentile?: PercentileConfig
  ): GetRecentPrioritizationFeesPercentileApiResponse;
};

/**
 * Supports the [Triton improved recent priority fee api](https://docs.triton.one/chains/solana/improved-priority-fees-api) which adds a percentile parameter to the getRecentPrioritizationFees rpc call.
 * @param rpc
 * @param addresses
 * @param percentile
 */
export async function getRpcRecentFeesOfPercentile(
  rpc: Rpc<GetRecentPrioritizationFeesPercentileApi>,
  addresses?: Address[],
  percentile?: PercentileConfig
): Promise<RpcPriorityFees> {
  const percentileStr = `${percentile ? ` P[${percentile.percentile / 100}]` : ''}`;
  const accStr = addresses?.length || 'all global';
  logger.info(`Fetching recent${percentileStr} priority fees from Triton for ${accStr} accounts`);
  const res = await rpc.getRecentPrioritizationFees(addresses, percentile).send();
  let filteredZeros = 0;
  let total = 0n;
  // The RPC cache is block-count based. Use the complete cache instead of converting a time window to slots.
  const recentFees = res
    .filter((f) => {
      if (f.prioritizationFee <= 0) {
        filteredZeros++;
        return false;
      }
      total = total + f.prioritizationFee;
      return true;
    })
    .sort((a, b) => Number(a.prioritizationFee - b.prioritizationFee));
  if (recentFees.length === 0) {
    logger.info(
      `No non-zero recent${percentileStr} priority fees returned from RPC for ${accStr} accounts, using 1 uLamports/CU. Filtered ${filteredZeros} zero fees`
    );
    return {
      min: new Decimal('1'),
      max: new Decimal('1'),
      average: new Decimal('1'),
      median: new Decimal('1'),
    };
  }
  if (recentFees.length === 1) {
    logger.info(
      `Fetched 1 non-zero recent${percentileStr} priority fee from Triton for ${accStr} accounts, fee: ${recentFees[0].prioritizationFee} uLamports/CU. Filtered ${filteredZeros} zero fees`
    );
    return {
      min: new Decimal(recentFees[0].prioritizationFee.toString()),
      max: new Decimal(recentFees[0].prioritizationFee.toString()),
      average: new Decimal(recentFees[0].prioritizationFee.toString()),
      median: new Decimal(recentFees[0].prioritizationFee.toString()),
    };
  }
  const min = new Decimal(recentFees[0].prioritizationFee.toString());
  const max = new Decimal(recentFees[recentFees.length - 1].prioritizationFee.toString());
  const average = new Decimal((total / BigInt(recentFees.length)).toString());
  const median = new Decimal(recentFees[Math.floor(recentFees.length / 2)].prioritizationFee.toString());
  logger.info(
    `Fetched ${recentFees.length} non-zero recent${percentileStr} priority fees from Triton for ${accStr} accounts, median: ${median} uLamports/CU, average: ${average} uLamports/CU, min: ${min} uLamports/CU, max: ${max} uLamports/CU. Filtered ${filteredZeros} zero fees`
  );
  return {
    min,
    max,
    average,
    median,
  };
}
