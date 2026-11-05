import { Address, isAddress } from '@solana/kit';
import { logger } from 'kvaults-investing-bot-logger';
import { readUrl } from '../config/schema.js';
import { SETTINGS } from '../config/settings.js';
import { EXTERNAL_REQUEST_TIMEOUT_MS } from './timeout.js';

export const KAMINO_TOKEN_FLAGS_URL = SETTINGS.KAMINO_TOKEN_FLAGS_URL.default;

const STABLECOIN_TAG = 'stablecoin';
const LST_TAG = 'lst';

/*
Response is in format:
[
  {
    "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "symbol": "USDC",
    "tags": ["verified", "stablecoin"]
  }
]
**/

interface TokenFlagsResponseEntry {
  mint: string;
  symbol: string;
  tags: string[];
}

/**
 * What Kamino's token feed says a token is. This is the authoritative answer to "is this a
 * stablecoin" — the bot must not infer it from symbols or prices of its own accord.
 */
export interface TokenFlags {
  readonly symbol: string;
  readonly isStablecoin: boolean;
  readonly isLst: boolean;
}

/**
 * Fetch the Kamino token flags feed and reduce it to the tags the danger triggers act on.
 *
 * Fails closed: a transport error, a malformed body, or a body that yields zero usable entries all
 * throw rather than returning an empty map, because an empty map is indistinguishable from "nothing
 * is a stablecoin" and would silently disable every peg check.
 */
export async function fetchTokenFlags(
  timeoutMs: number = EXTERNAL_REQUEST_TIMEOUT_MS
): Promise<Map<Address, TokenFlags>> {
  const url = readUrl(SETTINGS.KAMINO_TOKEN_FLAGS_URL);
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  let body: unknown;
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: abortController.signal,
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch token flags: ${response.status} ${response.statusText}`);
    }
    // The deadline covers the body too: a feed that sends its headers and then stalls must still abort.
    body = await response.json();
  } finally {
    clearTimeout(timeout);
  }
  if (!Array.isArray(body)) {
    throw new Error('Token flags API returned a malformed response: expected an array');
  }

  const flags = new Map<Address, TokenFlags>();
  let skipped = 0;
  for (const entry of body as TokenFlagsResponseEntry[]) {
    // A mint that is not a valid address can never match a reserve; keeping it would let an all-invalid
    // feed pass the usable-entries check below and silently disable every peg check.
    if (!entry || typeof entry.mint !== 'string' || !isAddress(entry.mint) || !Array.isArray(entry.tags)) {
      skipped++;
      continue;
    }
    flags.set(entry.mint, {
      symbol: typeof entry.symbol === 'string' ? entry.symbol : '',
      isStablecoin: entry.tags.includes(STABLECOIN_TAG),
      isLst: entry.tags.includes(LST_TAG),
    });
  }
  if (skipped > 0) {
    logger.warn(`[token-flags] skipped ${skipped} malformed entr${skipped === 1 ? 'y' : 'ies'} from ${url}`);
  }
  if (flags.size === 0) {
    throw new Error(`Token flags API returned no usable entries from ${url}`);
  }
  return flags;
}
