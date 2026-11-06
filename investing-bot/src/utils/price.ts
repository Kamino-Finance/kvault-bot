import { Address } from '@solana/kit';
import { Decimal } from 'decimal.js';
import { logger } from 'kvaults-investing-bot-logger';
import { chunks } from '../libs/utils/batch.js';
import { readString, readUrl } from '../config/schema.js';
import { SETTINGS } from '../config/settings.js';
import { EXTERNAL_REQUEST_TIMEOUT_MS } from './timeout.js';

/** kswap rejects `batch-token-prices` requests with more than this many mints (HTTP 400). */
export const KSWAP_BATCH_PRICE_MAX_TOKENS = 100;

/*
Response is in format:
{
  "success": true,
  "data": {
    "tokenAddress1": {
      "value": 25.17,
      "updateUnixTime": 1665234567,
      "updateHumanTime": "2025-07-14T10:35:37",
      "priceInNative": 0.12,
      "priceChange24h": 3.33
    },
    "tokenAddress2": null
  }
}
**/

interface TokenPriceData {
  value: number;
  updateUnixTime: number;
  updateHumanTime: string;
  priceInNative: number;
  priceChange24h: number;
}

interface BatchPriceResponse {
  success: boolean;
  data: { [key: string]: TokenPriceData | null };
}

export const DEFAULT_MARKET_PRICE_MAX_AGE_SECONDS: number = SETTINGS.MARKET_PRICE_MAX_AGE_SECONDS.default;

export interface PriceFetchOptions {
  /** Throw unless every requested token has a finite, positive price. */
  requireAll?: boolean;
  /** A price older than this many seconds is invalid: strict mode throws, lenient mode prices that mint at 0. */
  maxAgeSeconds?: number;
  /** Injectable wall clock for deterministic tests. */
  nowUnixTime?: number;
}

type ResolvedPriceFetchOptions = Required<Pick<PriceFetchOptions, 'requireAll' | 'nowUnixTime'>> &
  Pick<PriceFetchOptions, 'maxAgeSeconds'>;

/**
 * Fetch USD prices for the given mints from kswap. Each request contains at most
 * KSWAP_BATCH_PRICE_MAX_TOKENS mints. Chunks are fetched sequentially so a strict failure stops at the first
 * failed chunk and the requests do not compete for the per-key kswap rate limit.
 * Strict mode (requireAll) rejects the whole call on a failed chunk or on a missing or invalid price.
 * Lenient mode prices every mint of a failed chunk at 0, so farms on the affected reserves contribute 0 APY.
 * When every chunk fails, lenient mode throws as well: kswap is down and the caller must not allocate on
 * all-zero prices.
 */
export async function getTokensBatchPrice(
  tokens: Address[],
  options: PriceFetchOptions = {}
): Promise<Map<Address, Decimal>> {
  const { requireAll = false, maxAgeSeconds, nowUnixTime = Math.floor(Date.now() / 1000) } = options;
  const prices = new Map<Address, Decimal>();
  const tokenChunks = chunks(tokens, KSWAP_BATCH_PRICE_MAX_TOKENS);
  let failedChunks = 0;
  let lastChunkError: unknown;
  for (const chunk of tokenChunks) {
    let chunkPriceMap: Map<Address, Decimal>;
    try {
      chunkPriceMap = await fetchTokensBatchPriceChunk(chunk, { requireAll, maxAgeSeconds, nowUnixTime });
    } catch (error) {
      if (requireAll) {
        throw error;
      }
      failedChunks += 1;
      lastChunkError = error;
      logger.error(`Setting prices for ${chunk.length} mints to 0 USD:`, error);
      chunkPriceMap = zeroTokenPrices(chunk);
    }
    for (const [token, price] of chunkPriceMap) {
      prices.set(token, price);
    }
  }
  if (tokenChunks.length > 0 && failedChunks === tokenChunks.length) {
    throw new Error(`Failed to fetch tokens batch price for all ${failedChunks} chunk(s)`, { cause: lastChunkError });
  }
  return prices;
}

async function fetchTokensBatchPriceChunk(
  tokens: Address[],
  { requireAll, maxAgeSeconds, nowUnixTime }: ResolvedPriceFetchOptions
): Promise<Map<Address, Decimal>> {
  const tokensParams = tokens.map((token) => `tokens=${encodeURIComponent(token)}`).join('&');
  const kswapBaseApi = readUrl(SETTINGS.KSWAP_API_BASE_URL);
  const kswapApiKey = readString(SETTINGS.KSWAP_API_KEY);
  const url = `${kswapBaseApi}/batch-token-prices?${tokensParams}`;
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), EXTERNAL_REQUEST_TIMEOUT_MS);
  let data: BatchPriceResponse;
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(kswapApiKey ? { 'x-api-key': kswapApiKey } : {}),
      },
      signal: abortController.signal,
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch tokens batch price: ${response.status} ${response.statusText}`);
    }
    data = (await response.json()) as BatchPriceResponse;
    if (!data || typeof data !== 'object' || !data.success || !data.data || typeof data.data !== 'object') {
      throw new Error('Tokens batch price API returned an unsuccessful or malformed response');
    }
  } finally {
    clearTimeout(timeout);
  }

  const prices = new Map<Address, Decimal>();
  for (const token of tokens) {
    const tokenData = data.data[token];
    if (tokenData && tokenData.value !== null && tokenData.value !== undefined) {
      try {
        const price = new Decimal(tokenData.value);
        if (!price.isFinite() || price.lte(0)) {
          throw new Error(`non-positive or non-finite price ${tokenData.value}`);
        }
        if (maxAgeSeconds !== undefined) {
          if (!Number.isFinite(tokenData.updateUnixTime) || tokenData.updateUnixTime <= 0) {
            throw new Error(`invalid updateUnixTime ${tokenData.updateUnixTime}`);
          }
          const ageSeconds = nowUnixTime - tokenData.updateUnixTime;
          if (ageSeconds < -60) {
            throw new Error(`price timestamp is ${-ageSeconds}s in the future`);
          }
          if (ageSeconds > maxAgeSeconds) {
            throw new Error(`price is stale by ${ageSeconds}s (maximum ${maxAgeSeconds}s)`);
          }
        }
        prices.set(token, price);
      } catch (error) {
        if (requireAll) {
          throw new Error(`Invalid price data for token ${token}: ${error}`, { cause: error });
        }
        logger.error(`Failed to parse price for token, setting to 0: ${token}: ${error}`);
        prices.set(token, new Decimal(0));
      }
    } else {
      if (requireAll) {
        throw new Error(`No price data available for token ${token}`);
      }
      logger.warn(`No price data available for token ${token}, setting to 0`);
      prices.set(token, new Decimal(0));
    }
  }
  return prices;
}

function zeroTokenPrices(tokens: Address[]): Map<Address, Decimal> {
  return new Map(tokens.map((token) => [token, new Decimal(0)]));
}
