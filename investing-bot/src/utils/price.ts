import { Address } from '@solana/kit';
import { Decimal } from 'decimal.js';
import { logger } from 'kvaults-investing-bot-logger';
import { getEnv, getEnvOrDefault } from '../libs/utils/env.js';
import { EXTERNAL_REQUEST_TIMEOUT_MS } from './timeout.js';

export const KSWAP_BASE_API = 'https://api.kamino.finance/kswap';

/*
Response is in format:
{
  "success": true,
  "data": {
    "tokenAddress1": {
      "isScaledUiToken": false,
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
  isScaledUiToken: boolean;
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

export const DEFAULT_MARKET_PRICE_MAX_AGE_SECONDS = 300;

export interface PriceFetchOptions {
  /** Throw unless every requested token has a finite, positive price. */
  requireAll?: boolean;
  /** Throw when a price is older than this many seconds. Only applied in strict requireAll mode. */
  maxAgeSeconds?: number;
  /** Injectable wall clock for deterministic tests. */
  nowUnixTime?: number;
}

export async function getTokensBatchPrice(
  tokens: Address[],
  options: PriceFetchOptions = {}
): Promise<Map<Address, Decimal>> {
  const { requireAll = false, maxAgeSeconds, nowUnixTime = Math.floor(Date.now() / 1000) } = options;
  const tokensParams = tokens.map((token) => `tokens=${encodeURIComponent(token)}`).join('&');
  const kswapBaseApi = getEnvOrDefault('KSWAP_API_BASE_URL', KSWAP_BASE_API);
  const kswapApiKey = getEnv('KSWAP_API_KEY');
  const url = `${kswapBaseApi}/batch-token-prices?${tokensParams}`;
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), EXTERNAL_REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(kswapApiKey ? { 'x-api-key': kswapApiKey } : {}),
      },
      signal: abortController.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const message = `Failed to fetch tokens batch price: ${response.status} ${response.statusText}`;
    if (requireAll) {
      throw new Error(message);
    }
    logger.error(message);
    return new Map<Address, Decimal>();
  }
  const data = (await response.json()) as BatchPriceResponse;

  // Check if response has success field and it's true
  if (!data.success || !data.data || typeof data.data !== 'object') {
    if (requireAll) {
      throw new Error('Tokens batch price API returned an unsuccessful or malformed response');
    }
    logger.error('API response indicates failure:', data);
    return new Map<Address, Decimal>();
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
        if (requireAll && maxAgeSeconds !== undefined) {
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
