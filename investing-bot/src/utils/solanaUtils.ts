import { Rpc, SolanaRpcApi } from '@solana/kit';
import axios from 'axios';
import { Decimal } from 'decimal.js';
import { logger } from 'kvaults-investing-bot-logger';
import { DEFAULT_MEDIAN_SLOT_DURATION_IN_MS } from '../libs/utils/consts.js';
import { EXTERNAL_REQUEST_TIMEOUT_MS, withTimeout } from './timeout.js';

const MILLISECONDS_PER_SECOND = 1000;
const RPC_PERFORMANCE_SAMPLE_COUNT = 10;
const SLOT_DURATION_REFRESH_WORK_CYCLES = 5;
export const SLOT_DURATION_REFRESH_IDLE_INTERVAL_MS = 60 * 60 * MILLISECONDS_PER_SECOND;

export class SlotDurationRefreshScheduler {
  private workCyclesSinceRefresh = 0;
  private lastRefreshAtMilliseconds: number;

  constructor(private readonly nowMilliseconds: () => number = () => performance.now()) {
    this.lastRefreshAtMilliseconds = this.nowMilliseconds();
  }

  recordWorkCycle(): void {
    this.workCyclesSinceRefresh += 1;
  }

  millisecondsUntilRefresh(): number {
    const elapsedMilliseconds = this.nowMilliseconds() - this.lastRefreshAtMilliseconds;
    return Math.max(SLOT_DURATION_REFRESH_IDLE_INTERVAL_MS - elapsedMilliseconds, 0);
  }

  async refreshIfDue(refresh: () => Promise<void>): Promise<boolean> {
    if (this.workCyclesSinceRefresh < SLOT_DURATION_REFRESH_WORK_CYCLES && this.millisecondsUntilRefresh() > 0) {
      return false;
    }

    await refresh();
    this.workCyclesSinceRefresh = 0;
    this.lastRefreshAtMilliseconds = this.nowMilliseconds();
    return true;
  }
}

export function getMinimumSlotsForDurationSeconds(durationSeconds: number, slotDurationMilliseconds: number): Decimal {
  return new Decimal(durationSeconds).mul(MILLISECONDS_PER_SECOND).div(slotDurationMilliseconds).ceil();
}

export async function getMedianSlotDurationInMsFromLastEpochsOrDefault(
  rpc: Rpc<SolanaRpcApi>,
  fallbackSlotDurationMs: number = DEFAULT_MEDIAN_SLOT_DURATION_IN_MS,
  readApiSlotDuration: () => Promise<number> = readSlotDurationFromApi
) {
  try {
    return validateSlotDurationInMs(await readApiSlotDuration(), 'API');
  } catch (apiError) {
    logger.warn(`[slot-duration] API read failed: ${apiError}. Reading recent RPC performance samples.`);
  }

  try {
    const samples = await withTimeout(
      rpc.getRecentPerformanceSamples(RPC_PERFORMANCE_SAMPLE_COUNT).send(),
      EXTERNAL_REQUEST_TIMEOUT_MS,
      '[slot-duration] read RPC performance samples'
    );
    const slotDurationsMs = samples.flatMap((sample) => {
      if (
        sample.numSlots <= 0n ||
        sample.numSlots > BigInt(Number.MAX_SAFE_INTEGER) ||
        !Number.isFinite(sample.samplePeriodSecs) ||
        sample.samplePeriodSecs <= 0
      ) {
        return [];
      }
      return [(sample.samplePeriodSecs * MILLISECONDS_PER_SECOND) / Number(sample.numSlots)];
    });
    if (slotDurationsMs.length === 0) {
      throw new Error('RPC returned no valid performance samples');
    }

    return validateSlotDurationInMs(median(slotDurationsMs), 'RPC');
  } catch (rpcError) {
    logger.error(
      `[slot-duration] RPC read failed: ${rpcError}. Using the fallback slot duration: ${fallbackSlotDurationMs} ms.`
    );
    return validateSlotDurationInMs(fallbackSlotDurationMs, 'fallback');
  }
}

async function readSlotDurationFromApi(): Promise<number> {
  const response = await axios.get<{ recentSlotDurationInMs: number }>('https://api.kamino.finance/slots/duration', {
    timeout: EXTERNAL_REQUEST_TIMEOUT_MS,
  });
  return response.data.recentSlotDurationInMs;
}

function validateSlotDurationInMs(slotDurationMs: number, source: 'API' | 'RPC' | 'fallback'): number {
  if (!Number.isFinite(slotDurationMs) || slotDurationMs <= 0) {
    throw new Error(`${source} returned an invalid slot duration: ${slotDurationMs}`);
  }
  return slotDurationMs;
}

function median(values: number[]): number {
  const sortedValues = [...values].sort((left, right) => left - right);
  const middleIndex = Math.floor(sortedValues.length / 2);
  if (sortedValues.length % 2 === 1) {
    return sortedValues[middleIndex];
  }
  return (sortedValues[middleIndex - 1] + sortedValues[middleIndex]) / 2;
}
