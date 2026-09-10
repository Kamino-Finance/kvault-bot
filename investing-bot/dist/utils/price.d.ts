import { Address } from '@solana/kit';
import { Decimal } from 'decimal.js';
export declare const KSWAP_BASE_API = "https://api.kamino.finance/kswap";
export declare const DEFAULT_MARKET_PRICE_MAX_AGE_SECONDS = 300;
export interface PriceFetchOptions {
    /** Throw unless every requested token has a finite, positive price. */
    requireAll?: boolean;
    /** Throw when a price is older than this many seconds. Only applied in strict requireAll mode. */
    maxAgeSeconds?: number;
    /** Injectable wall clock for deterministic tests. */
    nowUnixTime?: number;
}
export declare function getTokensBatchPrice(tokens: Address[], options?: PriceFetchOptions): Promise<Map<Address, Decimal>>;
//# sourceMappingURL=price.d.ts.map