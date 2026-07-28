import { logger } from 'kvaults-investing-bot-logger';

const SOLANA_COMPASS_API_URL = 'https://solanacompass.com/api';

export type Fetcher = typeof fetch;

export enum RecentPeriod {
  ONE_MINUTE = 1,
  FIVE_MINUTES = 5,
  FIFTEEN_MINUTES = 15,
}

export async function getAverageFeesPerCUForPeriodLamports(fetcher: Fetcher, period: RecentPeriod): Promise<number> {
  const averageFees = await getAverageFees(fetcher);
  // I can't work out how to get the average CU per tx per block, so we assume it's the default 200,000 CU
  // -5000 because the base fee is included
  return Math.max(averageFees[period].avg - 5000, 0) / 200_000;
}

export async function getAverageFees(fetcher: Fetcher): Promise<SolanaCompassFeesByPeriod> {
  logger.info(`Fetching global average fees from Solana Compass`);
  const res = await fetcher(`${SOLANA_COMPASS_API_URL}/fees`);
  const fees = (await res.json()) as SolanaCompassFeesByPeriod;
  logger.info(`Fetched ${JSON.stringify(fees)} average fees from Solana Compass`);
  return fees;
}

export type SolanaCompassFeesByPeriod = {
  1: SolanaCompassFees;
  5: SolanaCompassFees;
  15: SolanaCompassFees;
};

export type SolanaCompassFees = {
  min: number;
  max: number;
  avg: number;
  priorityTx: number;
  nonVotes: number;
  priorityRatio: number;
  avgCuPerBlock: number;
  blockspaceUsageRatio: number;
};
