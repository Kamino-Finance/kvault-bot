/**
 * A synchronous, auto-reloading, single-slot cache.
 *
 * Automatically reloads a managed value on next {@link #get()} after a preconfigured time period.
 */
export class TimeBasedReloadingSlot {
    expirationPeriodMillis;
    valueReloader;
    currentValue;
    cachedSinceMilli;
    /**
     * Configures the expiration period and the function to use for obtaining the value each time the cached one expires.
     */
    constructor(expirationPeriodMillis, valueReloader) {
        this.expirationPeriodMillis = expirationPeriodMillis;
        this.valueReloader = valueReloader;
        this.currentValue = undefined;
        this.cachedSinceMilli = undefined;
    }
    /**
     * Returns a previously-cached (if not older than {@link #expirationPeriodMillis}) or freshly-obtained value from the
     * configured loading function.
     */
    get() {
        const currentMilli = performance.now();
        let ageMillis;
        if (this.cachedSinceMilli === undefined || currentMilli - this.cachedSinceMilli > this.expirationPeriodMillis) {
            this.currentValue = this.valueReloader();
            this.cachedSinceMilli = currentMilli;
        }
        else {
            ageMillis = currentMilli - this.cachedSinceMilli;
        }
        return {
            value: this.currentValue,
            ageMillis,
        };
    }
}
/**
 * An asynchronous, single-slot, load-only-once cache.
 *
 * Ensures that only one async loading operation happens, even with concurrent {@link #get()} calls.
 */
export class AsyncLoadingSlot {
    valueAsyncLoader;
    valuePromise;
    /**
     * Configures the underlying function that should be loaded only once.
     */
    constructor(valueAsyncLoader) {
        this.valueAsyncLoader = valueAsyncLoader;
    }
    /**
     * Gets the loaded value, either by delegating to the configured loader (on the first call ever), or by returning the
     * previously-cached result.
     */
    async get() {
        if (this.valueAsyncLoader !== undefined) {
            this.valuePromise = this.valueAsyncLoader();
            this.valueAsyncLoader = undefined;
        }
        return this.valuePromise;
    }
}
//# sourceMappingURL=caching.js.map