import {
  AllOracleAccounts,
  cacheOrGetScopePrice,
  getAllOracleAccounts,
  getCurrentLedgerInstant,
  isNotNullPubkey,
  KaminoReserve,
  Reserve,
} from '@kamino-finance/klend-sdk';
import { Scope } from '@kamino-finance/scope-sdk';
import { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import { Decimal } from 'decimal.js';
import { RPC_REQUEST_TIMEOUT_MS, withTimeout } from '../utils/timeout.js';

const UNUSED_SCOPE_CHAIN_INDEX = 65_535;

/**
 * Scope prices below this fraction of market price count as zero. Klend can return near-zero prices for failed chains.
 */
export const NEAR_ZERO_PRICE_RATIO = new Decimal('1e-6');

export type ScopeOracleObservation =
  | {
      readonly kind: 'healthy' | 'zero';
      /** The publish time of the oldest price in the chains, in Unix seconds. */
      readonly timestamp: bigint;
      /** Seconds from that publish time to the observation. */
      readonly ageSeconds: bigint;
      /** A price is at least as old as the reserve's own limit, so the lending program treats it as stale. */
      readonly stale: boolean;
    }
  | { readonly kind: 'notConfigured' }
  | { readonly kind: 'unavailable'; readonly reason: string };

export interface ScopeOracleSnapshot {
  readonly observedAtUnixSeconds: bigint;
  readonly observations: ReadonlyMap<Address, ScopeOracleObservation>;
}

/** Raw Scope readings, before the SDK selects an alternate feed or substitutes a cached price. */
export function readScopeOracleObservation(
  reserve: Reserve,
  accounts: AllOracleAccounts,
  nowUnixSeconds: bigint,
  /** The token's market price in USD, which a near-zero price is measured against. Without it, only 0 is zero. */
  marketPriceUsd?: Decimal
): ScopeOracleObservation {
  const tokenInfo = reserve.config.tokenInfo;
  const scope = tokenInfo.scopeConfiguration;
  // Like the SDK, a reserve prices from Scope only when its price chain is valid.
  if (!isNotNullPubkey(scope.priceFeed) || !Scope.isScopeChainValid(scope.priceChain)) return { kind: 'notConfigured' };
  try {
    const scopeCache: Parameters<typeof cacheOrGetScopePrice>[1] = new Map();
    let oldestTimestamp: bigint | undefined;
    let stale = false;
    const read = (chain: number[], maxAgeSeconds: bigint) => {
      let foundUnusedIndex = false;
      for (const index of chain) {
        if (index === UNUSED_SCOPE_CHAIN_INDEX) {
          foundUnusedIndex = true;
        } else if (foundUnusedIndex) {
          throw new Error('Scope chain has an active price after an unused index');
        }
      }
      const candidate = cacheOrGetScopePrice(scope.priceFeed, scopeCache, accounts, chain);
      if (!candidate || !candidate.valid || !candidate.price.isFinite() || candidate.price.lt(0)) {
        throw new Error('Scope chain has no valid price');
      }
      for (const index of chain) {
        if (index === UNUSED_SCOPE_CHAIN_INDEX) continue;
        const component = scopeCache.get(scope.priceFeed)?.prices[index];
        if (!component) throw new Error('Scope chain has no valid price');
        const timestamp = BigInt(component.unixTimestamp.toString());
        if (timestamp <= 0n || timestamp > nowUnixSeconds) {
          throw new Error('Scope chain timestamp is uninitialized or in the future');
        }
        stale ||= nowUnixSeconds - timestamp >= maxAgeSeconds;
        oldestTimestamp = oldestTimestamp === undefined || timestamp < oldestTimestamp ? timestamp : oldestTimestamp;
      }
      return candidate;
    };
    const spot = read(scope.priceChain, BigInt(tokenInfo.maxAgePriceSeconds.toString()));
    // The SDK skips an unused TWAP chain.
    const twap =
      tokenInfo.maxTwapDivergenceBps.gtn(0) && Scope.isScopeChainValid(scope.twapChain)
        ? read(scope.twapChain, BigInt(tokenInfo.maxAgeTwapSeconds.toString()))
        : undefined;
    const timestamp = oldestTimestamp!;
    const zeroBelow =
      marketPriceUsd !== undefined && marketPriceUsd.gt(0) ? marketPriceUsd.mul(NEAR_ZERO_PRICE_RATIO) : new Decimal(0);
    const isZero = (price: Decimal) => price.isZero() || price.lt(zeroBelow);
    return {
      kind: isZero(spot.price) || (twap !== undefined && isZero(twap.price)) ? 'zero' : 'healthy',
      timestamp,
      ageSeconds: nowUnixSeconds - timestamp,
      stale,
    };
  } catch (error) {
    return { kind: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function fetchScopeOracleSnapshot(
  rpc: Rpc<SolanaRpcApi>,
  vaultReserves: ReadonlyMap<Address, Pick<KaminoReserve, 'state'>>,
  /** Market prices in USD by mint. */
  marketPrices: ReadonlyMap<Address, Decimal> = new Map()
): Promise<ScopeOracleSnapshot> {
  const reserves = new Map(Array.from(vaultReserves, ([address, reserve]) => [address, reserve.state]));
  const scopeReserves = [...reserves.values()].filter((reserve) =>
    isNotNullPubkey(reserve.config.tokenInfo.scopeConfiguration.priceFeed)
  );
  const accounts = await withTimeout(
    getAllOracleAccounts(rpc, scopeReserves),
    RPC_REQUEST_TIMEOUT_MS,
    '[scope-oracle] load Scope prices'
  );
  // Read the clock after the accounts. This prevents comparison of a new price with an earlier block time.
  const { blockTime: observedAtUnixSeconds } = await withTimeout(
    getCurrentLedgerInstant(rpc),
    RPC_REQUEST_TIMEOUT_MS,
    '[scope-oracle] load observation time'
  );
  return {
    observedAtUnixSeconds,
    observations: new Map(
      [...reserves].map(([address, reserve]) => [
        address,
        readScopeOracleObservation(
          reserve,
          accounts,
          observedAtUnixSeconds,
          marketPrices.get(reserve.liquidity.mintPubkey)
        ),
      ])
    ),
  };
}
