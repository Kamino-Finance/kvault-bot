import { logger } from 'kvaults-investing-bot-logger';
import { SOL } from '../utils/index.js';
import { AsyncLoadingSlot, TimeBasedReloadingSlot } from '../utils/caching.js';
import { createDefaultRpc, FeePercentileSupport } from '../model/index.js';
import { getAverageFeesPerCUForPeriodLamports, RecentPeriod } from './solanaCompass.js';
import { getRpcRecentFeesOfPercentile } from './triton.js';
import { getPriorityFeeEstimate } from './helius.js';
// TODO(type-safety): have a lib (or own ~20 lines of code) to provide time units safety (see `amounts.ts`)
const SOLANA_COMPASS_RESPONSE_CACHE_MILLIS = 1000 * 60 * 2; // 2 minutes
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
export function resolvePriorityFeeProviderChain(rpcEndpoints, feePercentile) {
    const chain = [];
    for (const rpcEndpoint of rpcEndpoints) {
        const priorityFeeProvider = resolvePriorityFeeProvider(rpcEndpoint, feePercentile);
        if (priorityFeeProvider !== undefined) {
            chain.push(priorityFeeProvider);
        }
    }
    // TODO(rpc-fallbacks): time-limiting for this HTTP call (and others?) can be implemented via decorator here
    chain.push(new CachingPriorityFeeProvider(new SolanaCompassPriorityFeeProvider(fetch, RecentPeriod.ONE_MINUTE), SOLANA_COMPASS_RESPONSE_CACHE_MILLIS));
    return chain;
}
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
export function createResilientPriorityFeeProvider(chain, configuredFees) {
    const { defaultPerCu, minPerCu, maxPerCu } = configuredFees;
    let chained = new TerminatingPriorityFeeProvider();
    for (const link of chain.reverse()) {
        chained = new FallbackPriorityFeeProvider(link, chained);
    }
    const capturingLastSuccess = new LastSuccessCapturingPriorityFeeProvider(chained);
    const usingDefault = new FallbackPriorityFeeProvider(capturingLastSuccess, new ManualPriorityFeeProvider('configured default', defaultPerCu));
    return new ClampingPriorityFeeProvider(usingDefault, minPerCu, maxPerCu);
}
// The internals below are only exported for test purposes:
/**
 * A provider using the Triton's RPC customization (i.e. `percentile` param for `getRecentPrioritizationFees()`).
 */
export class TritonPriorityFeeProvider {
    tritonRpc;
    feePercentile;
    constructor(tritonRpc, feePercentile) {
        this.tritonRpc = tritonRpc;
        this.feePercentile = feePercentile;
    }
    async getPriorityFeeForAccounts(accounts) {
        const tritonResponse = await getRpcRecentFeesOfPercentile(this.tritonRpc, accounts, {
            percentile: this.feePercentile * 100,
        });
        return {
            feePerCu: SOL.microLamports(tritonResponse.average),
            source: 'Triton-style RPC',
        };
    }
}
/**
 * A provider using the Helius' RPC customization (i.e. a new `getPriorityFeeEstimate()` method).
 */
export class HeliusPriorityFeeProvider {
    heliusRpc;
    feePercentile;
    constructor(heliusRpc, feePercentile) {
        this.heliusRpc = heliusRpc;
        this.feePercentile = feePercentile;
    }
    async getPriorityFeeForAccounts(accounts) {
        const heliusResponse = await getPriorityFeeEstimate(this.heliusRpc, accounts, this.feePercentile);
        return {
            feePerCu: SOL.microLamports(heliusResponse),
            source: 'Helius-style RPC',
        };
    }
}
/**
 * A provider using SolanaCompass' HTTP API for global fee summary.
 *
 * Note: this provider ignores the list of write accounts passed for the estimation!
 */
export class SolanaCompassPriorityFeeProvider {
    fetcher;
    period;
    constructor(fetcher, period) {
        this.fetcher = fetcher;
        this.period = period;
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async getPriorityFeeForAccounts(accounts) {
        const amount = await getAverageFeesPerCUForPeriodLamports(this.fetcher, this.period);
        return {
            feePerCu: SOL.lamports(amount),
            source: 'SolanaCompass',
        };
    }
}
/**
 * A provider that will attempt to call a single configured fallback delegate in case the primary delegate throws.
 *
 * Note: a common pattern is to construct a fallback chain (from N delegates) by chaining N instances recursively.
 */
export class FallbackPriorityFeeProvider {
    primary;
    fallback;
    constructor(primary, fallback) {
        this.primary = primary;
        this.fallback = fallback;
    }
    async getPriorityFeeForAccounts(accounts) {
        try {
            return await this.primary.getPriorityFeeForAccounts(accounts);
        }
        catch (e) {
            logger.warn(`Fee provider error; proceeding to its fallback:`, e);
            return this.fallback.getPriorityFeeForAccounts(accounts);
        }
    }
}
/**
 * A provider that will cache each *successful* result for a configured period (before calling its delegate again).
 *
 * Note: this provider ignores the list of write accounts passed for the estimation! (i.e. the cached result is
 * considered "global"; it does *not* keep any map with account lists). Hence, it is most suitable for wrapping
 * providers that already ignore the accounts.
 */
export class CachingPriorityFeeProvider {
    underlying;
    cache;
    constructor(underlying, expirationPeriodMillis) {
        this.underlying = underlying;
        this.cache = new TimeBasedReloadingSlot(expirationPeriodMillis, () => new AsyncLoadingSlot(() => this.underlying.getPriorityFeeForAccounts([])));
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async getPriorityFeeForAccounts(accounts) {
        const slot = this.cache.get();
        const { feePerCu, source } = await slot.value.get();
        return {
            feePerCu,
            source: slot.ageMillis === undefined ? `freshly-loaded ${source}` : `cached ${source}`,
        };
    }
}
/**
 * A provider always returning a preconfigured result.
 */
export class ManualPriorityFeeProvider {
    result;
    constructor(name, feePerCu) {
        this.result = {
            feePerCu,
            source: name,
        };
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async getPriorityFeeForAccounts(accounts) {
        return this.result;
    }
}
/**
 * A provider which can be used when no priority fees are needed (e.g. localnet).
 */
export const NO_PRIORITY_FEE = new ManualPriorityFeeProvider('disabled', SOL.amount(0));
/**
 * A provider that captures its delegate's last successful result, and returns it in case of future errors.
 */
export class LastSuccessCapturingPriorityFeeProvider {
    captured;
    lastSuccessfulResult;
    constructor(captured) {
        this.captured = captured;
        this.lastSuccessfulResult = undefined;
    }
    async getPriorityFeeForAccounts(accounts) {
        try {
            this.lastSuccessfulResult = await this.captured.getPriorityFeeForAccounts(accounts);
            return this.lastSuccessfulResult;
        }
        catch (e) {
            if (this.lastSuccessfulResult === undefined) {
                throw new Error(`No last successful result available yet`, e);
            }
            return {
                feePerCu: this.lastSuccessfulResult.feePerCu,
                source: `last successful (${this.lastSuccessfulResult.source})`,
            };
        }
    }
}
/**
 * A provider that always throws an error.
 *
 * This is a technicality used for terminating a fallback chain with a clear error.
 */
export class TerminatingPriorityFeeProvider {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    getPriorityFeeForAccounts(accounts) {
        throw new Error(`Could not get priority fee from any provider`);
    }
}
/**
 * A provider clamping any underlying result to a preconfigured range (i.e. not allowing too low or too high fees).
 */
export class ClampingPriorityFeeProvider {
    clamped;
    min;
    max;
    constructor(clamped, min, max) {
        if (min.token.symbol !== max.token.symbol || min.amount.gt(max.amount)) {
            throw new Error(`inconsistent bounds: ${min} <= X <= ${max}`);
        }
        this.clamped = clamped;
        this.min = min;
        this.max = max;
    }
    async getPriorityFeeForAccounts(accounts) {
        const underlyingResult = await this.clamped.getPriorityFeeForAccounts(accounts);
        if (underlyingResult.feePerCu.token.symbol !== this.min.token.symbol) {
            return {
                feePerCu: underlyingResult.feePerCu,
                source: `non-clampable (!) ${underlyingResult.source}`,
            };
        }
        if (underlyingResult.feePerCu.amount.lt(this.min.amount)) {
            return {
                feePerCu: this.min,
                source: `configured minimum`,
            };
        }
        if (underlyingResult.feePerCu.amount.gt(this.max.amount)) {
            return {
                feePerCu: this.max,
                source: `configured maximum`,
            };
        }
        return underlyingResult;
    }
}
function resolvePriorityFeeProvider(rpcEndpoint, feePercentile) {
    if (rpcEndpoint.feePercentileSupport === FeePercentileSupport.None) {
        if (feePercentile !== undefined) {
            logger.warn(`Configured P[${feePercentile}] fee percentile queries not supported by ${rpcEndpoint.url}; ignoring this RPC for fee estimation`);
        }
        return undefined;
    }
    if (feePercentile === undefined) {
        logger.warn(`Configured RPC ${rpcEndpoint.url} supports a ${rpcEndpoint.feePercentileSupport} fee percentile queries, but they were explicitly disabled; ignoring this RPC for fee estimation`);
        return undefined;
    }
    switch (rpcEndpoint.feePercentileSupport) {
        case FeePercentileSupport.TritonStyle:
            return new TritonPriorityFeeProvider(createDefaultRpc(rpcEndpoint.url), feePercentile);
        case FeePercentileSupport.HeliusStyle:
            return new HeliusPriorityFeeProvider(createDefaultRpc(rpcEndpoint.url), feePercentile);
        default:
            throw new Error(`Unexpected fee percentile support: ${rpcEndpoint.feePercentileSupport}`);
    }
}
//# sourceMappingURL=priorityFeeInfra.js.map