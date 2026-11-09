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
  /** Injectable wall clock for deterministic tests. Default: the clock when each response arrives. */
  nowUnixTime?: number;
  /**
   * The wait in milliseconds before each retry; one retry per entry. A retry requests again only the mints without a
   * valid price, whatever the reason: a failed request, or a missing, stale or invalid price. Default: no retry.
   */
  retryDelaysMs?: readonly number[];
}

type ChunkFetchOptions = Pick<PriceFetchOptions, 'maxAgeSeconds' | 'nowUnixTime'>;

/** A valid price and the time kswap last updated it. */
type PriceQuote = { price: Decimal; updateUnixTime: number };

/**
 * Fetch USD prices for the given mints from kswap. Each request contains at most
 * KSWAP_BATCH_PRICE_MAX_TOKENS mints. Chunks are fetched sequentially so the requests do not compete for the per-key
 * kswap rate limit. With `retryDelaysMs`, the mints without a valid price are requested again after each wait. After
 * each attempt, the prices accepted so far are checked against `maxAgeSeconds` again: one past the limit has no valid
 * price.
 * After the last attempt, strict mode (requireAll) rejects the whole call on a failed chunk or on a missing or invalid
 * price, and stops at the first failed chunk. Lenient mode prices every such mint at 0, so farms on the affected
 * reserves contribute 0 APY. When every chunk of every attempt fails, lenient mode throws as well: kswap is down and
 * the caller must not allocate on all-zero prices.
 */
export async function getTokensBatchPrice(
  tokens: Address[],
  options: PriceFetchOptions = {}
): Promise<Map<Address, Decimal>> {
  const { requireAll = false, maxAgeSeconds, nowUnixTime, retryDelaysMs = [] } = options;
  const prices = new Map<Address, Decimal>();
  /** The kswap update time of each price in `prices` that was fetched, not zeroed. */
  const updateUnixTimes = new Map<Address, number>();
  let pendingTokens = tokens;
  let anyChunkLoaded = false;
  for (let attempt = 0; ; attempt += 1) {
    const isLastAttempt = attempt === retryDelaysMs.length;
    const tokenChunks = chunks(pendingTokens, KSWAP_BATCH_PRICE_MAX_TOKENS);
    /** Why each mint of this attempt has no valid price: its chunk's error, or its own. */
    const failures = new Map<Address, unknown>();
    let failedChunks = 0;
    let lastChunkError: unknown;
    for (const chunk of tokenChunks) {
      try {
        for (const [token, quoteOrError] of await fetchTokensBatchPriceChunk(chunk, { maxAgeSeconds, nowUnixTime })) {
          if (quoteOrError instanceof Error) {
            failures.set(token, quoteOrError);
          } else {
            prices.set(token, quoteOrError.price);
            updateUnixTimes.set(token, quoteOrError.updateUnixTime);
          }
        }
        anyChunkLoaded = true;
      } catch (error) {
        failedChunks += 1;
        lastChunkError = error;
        for (const token of chunk) failures.set(token, error);
      }
      const firstFailure = chunk.find((token) => failures.has(token));
      if (requireAll && isLastAttempt && firstFailure !== undefined) {
        throw failures.get(firstFailure);
      }
    }
    if (maxAgeSeconds !== undefined) {
      // The requests and waits took time: a price accepted earlier may be past the limit now.
      const checkUnixTime = nowUnixTime ?? Math.floor(Date.now() / 1000);
      for (const [token, updateUnixTime] of updateUnixTimes) {
        const ageSeconds = checkUnixTime - updateUnixTime;
        if (ageSeconds > maxAgeSeconds) {
          prices.delete(token);
          updateUnixTimes.delete(token);
          failures.set(token, invalidPriceError(token, stalePriceError(ageSeconds, maxAgeSeconds)));
        }
      }
    }
    if (failures.size === 0) break;
    if (isLastAttempt) {
      // Only a price that went stale after its chunk was checked is left to reject here.
      if (requireAll) throw failures.values().next().value;
      if (!anyChunkLoaded && tokenChunks.length > 0 && failedChunks === tokenChunks.length) {
        throw new Error(`Failed to fetch tokens batch price for all ${failedChunks} chunk(s)`, {
          cause: lastChunkError,
        });
      }
      const zeroed = `Setting the price of ${failures.size} token(s) to 0 USD: ${Array.from(failures, ([token, failure]) => `${token} (${failure})`).join('; ')}`;
      if (failedChunks > 0) {
        logger.error(zeroed);
      } else {
        logger.warn(zeroed);
      }
      for (const token of failures.keys()) prices.set(token, new Decimal(0));
      break;
    }
    const delayMs = retryDelaysMs[attempt];
    logger.warn(
      `No valid price for ${failures.size} of ${tokens.length} token(s); retrying them in ${delayMs} ms (attempt ${attempt + 2} of ${retryDelaysMs.length + 1}): ${failures.values().next().value}`
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    pendingTokens = Array.from(failures.keys());
  }
  return new Map(tokens.map((token) => [token, prices.get(token)!]));
}

/**
 * Requests the prices of one chunk. Returns each mint's price, or the error that makes it unusable. Throws when the
 * request fails or the response is malformed.
 */
async function fetchTokensBatchPriceChunk(
  tokens: Address[],
  { maxAgeSeconds, nowUnixTime: injectedNowUnixTime }: ChunkFetchOptions
): Promise<Map<Address, PriceQuote | Error>> {
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

  // Read after the response arrives: earlier timeouts and retry waits must not make a fresh price look future-dated.
  const nowUnixTime = injectedNowUnixTime ?? Math.floor(Date.now() / 1000);
  const prices = new Map<Address, PriceQuote | Error>();
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
            throw stalePriceError(ageSeconds, maxAgeSeconds);
          }
        }
        prices.set(token, { price, updateUnixTime: tokenData.updateUnixTime });
      } catch (error) {
        prices.set(token, invalidPriceError(token, error));
      }
    } else {
      prices.set(token, new Error(`No price data available for token ${token}`));
    }
  }
  return prices;
}

function stalePriceError(ageSeconds: number, maxAgeSeconds: number): Error {
  return new Error(`price is stale by ${ageSeconds}s (maximum ${maxAgeSeconds}s)`);
}

function invalidPriceError(token: Address, cause: unknown): Error {
  return new Error(`Invalid price data for token ${token}: ${cause}`, { cause });
}
