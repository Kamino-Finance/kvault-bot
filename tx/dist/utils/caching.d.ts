/**
 * A synchronous, auto-reloading, single-slot cache.
 *
 * Automatically reloads a managed value on next {@link #get()} after a preconfigured time period.
 */
export declare class TimeBasedReloadingSlot<T> {
    private readonly expirationPeriodMillis;
    private readonly valueReloader;
    private currentValue;
    private cachedSinceMilli;
    /**
     * Configures the expiration period and the function to use for obtaining the value each time the cached one expires.
     */
    constructor(expirationPeriodMillis: number, valueReloader: () => T);
    /**
     * Returns a previously-cached (if not older than {@link #expirationPeriodMillis}) or freshly-obtained value from the
     * configured loading function.
     */
    get(): TimeBasedReloadingSlotGetResult<T>;
}
/**
 * A result of {@link TimeBasedReloadingSlot#get()}.
 */
export type TimeBasedReloadingSlotGetResult<T> = {
    /**
     * A cached or freshly-reloaded value.
     */
    value: T;
    /**
     * The millisecond age of the {@link #value} (if a cached one was returned) or `undefined` (if it was freshly-loaded
     * during the {@link TimeBasedReloadingSlot#get()} call).
     */
    ageMillis: number | undefined;
};
/**
 * An asynchronous, single-slot, load-only-once cache.
 *
 * Ensures that only one async loading operation happens, even with concurrent {@link #get()} calls.
 */
export declare class AsyncLoadingSlot<T> {
    private valueAsyncLoader;
    private valuePromise;
    /**
     * Configures the underlying function that should be loaded only once.
     */
    constructor(valueAsyncLoader: () => Promise<T>);
    /**
     * Gets the loaded value, either by delegating to the configured loader (on the first call ever), or by returning the
     * previously-cached result.
     */
    get(): Promise<T>;
}
//# sourceMappingURL=caching.d.ts.map