import { Address, Rpc } from '@solana/kit';
import { TokenAmount } from '../utils/index.js';
import { RpcEndpointConfig } from '../model/index.js';
import { Fetcher, RecentPeriod } from './solanaCompass.js';
import { GetRecentPrioritizationFeesPercentileApi } from './triton.js';
import { GetPriorityFeeEstimateApi } from './helius.js';
/**
 * A result of {@link PriorityFeeProvider#getPriorityFeeForAccounts()}.
 */
export type PriorityFeeResult = {
    /**
     * The estimated fee per compute unit.
     */
    feePerCu: TokenAmount;
    /**
     * An information-only "source" of the estimate (e.g. a specific RPC, or a static configuration, or a cache).
     */
    source: string;
};
/**
 * A fee estimator.
 */
export interface PriorityFeeProvider {
    /**
     * Returns a fee to set in order to land a transaction the given write accounts.
     */
    getPriorityFeeForAccounts(accounts: Address[]): Promise<PriorityFeeResult>;
}
/**
 * Configuration of static fee bounds and defaults.
 */
export type ConfiguredPriorityFees = {
    defaultPerCu: TokenAmount;
    minPerCu: TokenAmount;
    maxPerCu: TokenAmount;
};
/**
 * Constructs a list of fee providers from the given RPC endpoint URLs, in their fallback order.
 *
 * A static SolanaCompass provider will be added to the end of the list, with some caching (typically very appropriate
 * for HTTP-based public data sources).
 *
 * Note: passing a `feePercentile: undefined` will in practice skip all the RPCs except the SolanaCompass (since at the
 * moment, all RPCs need to know the fee percentile to return any meaningful number better than "min for each slot").
 *
 * Note: each RPC supports the fee percentile in a custom way - this means that all unrecognized URLs will be skipped.
 */
export declare function resolvePriorityFeeProviderChain(rpcEndpoints: RpcEndpointConfig[], feePercentile: number | undefined): PriorityFeeProvider[];
/**
 * Creates a fee provider that will use the given fallback chain + static config, and thus never throw errors.
 *
 * Conceptually, the composite provider built by this method will:
 * 1. Try the first provider from the given chain (typically obtained from {@link resolvePriorityFeeProviderChain()}).
 * 2. In case of failure, log warn and try the next one (and so on).
 * 3. If no provider from the given chain is successful - return the last known successful result.
 * 4. If no result was successful ever - return the default given by {@link ConfiguredPriorityFees}.
 * 5. For any returned result - apply the bounds given by {@link ConfiguredPriorityFees}.
 */
export declare function createResilientPriorityFeeProvider(chain: PriorityFeeProvider[], configuredFees: ConfiguredPriorityFees): PriorityFeeProvider;
/**
 * A provider using the Triton's RPC customization (i.e. `percentile` param for `getRecentPrioritizationFees()`).
 */
export declare class TritonPriorityFeeProvider implements PriorityFeeProvider {
    private readonly tritonRpc;
    private readonly feePercentile;
    constructor(tritonRpc: Rpc<GetRecentPrioritizationFeesPercentileApi>, feePercentile: number);
    getPriorityFeeForAccounts(accounts: Address[]): Promise<PriorityFeeResult>;
}
/**
 * A provider using the Helius' RPC customization (i.e. a new `getPriorityFeeEstimate()` method).
 */
export declare class HeliusPriorityFeeProvider implements PriorityFeeProvider {
    private readonly heliusRpc;
    private readonly feePercentile;
    constructor(heliusRpc: Rpc<GetPriorityFeeEstimateApi>, feePercentile: number);
    getPriorityFeeForAccounts(accounts: Address[]): Promise<PriorityFeeResult>;
}
/**
 * A provider using SolanaCompass' HTTP API for global fee summary.
 *
 * Note: this provider ignores the list of write accounts passed for the estimation!
 */
export declare class SolanaCompassPriorityFeeProvider implements PriorityFeeProvider {
    private readonly fetcher;
    private readonly period;
    constructor(fetcher: Fetcher, period: RecentPeriod);
    getPriorityFeeForAccounts(accounts: Address[]): Promise<PriorityFeeResult>;
}
/**
 * A provider that will attempt to call a single configured fallback delegate in case the primary delegate throws.
 *
 * Note: a common pattern is to construct a fallback chain (from N delegates) by chaining N instances recursively.
 */
export declare class FallbackPriorityFeeProvider implements PriorityFeeProvider {
    private readonly primary;
    private readonly fallback;
    constructor(primary: PriorityFeeProvider, fallback: PriorityFeeProvider);
    getPriorityFeeForAccounts(accounts: Address[]): Promise<PriorityFeeResult>;
}
/**
 * A provider that will cache each *successful* result for a configured period (before calling its delegate again).
 *
 * Note: this provider ignores the list of write accounts passed for the estimation! (i.e. the cached result is
 * considered "global"; it does *not* keep any map with account lists). Hence, it is most suitable for wrapping
 * providers that already ignore the accounts.
 */
export declare class CachingPriorityFeeProvider implements PriorityFeeProvider {
    private readonly underlying;
    private readonly cache;
    constructor(underlying: PriorityFeeProvider, expirationPeriodMillis: number);
    getPriorityFeeForAccounts(accounts: Address[]): Promise<PriorityFeeResult>;
}
/**
 * A provider always returning a preconfigured result.
 */
export declare class ManualPriorityFeeProvider implements PriorityFeeProvider {
    private readonly result;
    constructor(name: string, feePerCu: TokenAmount);
    getPriorityFeeForAccounts(accounts: Address[]): Promise<PriorityFeeResult>;
}
/**
 * A provider which can be used when no priority fees are needed (e.g. localnet).
 */
export declare const NO_PRIORITY_FEE: ManualPriorityFeeProvider;
/**
 * A provider that captures its delegate's last successful result, and returns it in case of future errors.
 */
export declare class LastSuccessCapturingPriorityFeeProvider implements PriorityFeeProvider {
    private readonly captured;
    private lastSuccessfulResult;
    constructor(captured: PriorityFeeProvider);
    getPriorityFeeForAccounts(accounts: Address[]): Promise<PriorityFeeResult>;
}
/**
 * A provider that always throws an error.
 *
 * This is a technicality used for terminating a fallback chain with a clear error.
 */
export declare class TerminatingPriorityFeeProvider implements PriorityFeeProvider {
    getPriorityFeeForAccounts(accounts: Address[]): Promise<PriorityFeeResult>;
}
/**
 * A provider clamping any underlying result to a preconfigured range (i.e. not allowing too low or too high fees).
 */
export declare class ClampingPriorityFeeProvider implements PriorityFeeProvider {
    private readonly clamped;
    private readonly min;
    private readonly max;
    constructor(clamped: PriorityFeeProvider, min: TokenAmount, max: TokenAmount);
    getPriorityFeeForAccounts(accounts: Address[]): Promise<PriorityFeeResult>;
}
//# sourceMappingURL=priorityFeeInfra.d.ts.map