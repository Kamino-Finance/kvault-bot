/**
 * A synchronous, auto-reloading, single-slot cache.
 *
 * Automatically reloads a managed value on next {@link #get()} after a preconfigured time period.
 */
export class TimeBasedReloadingSlot<T> {
  private readonly expirationPeriodMillis: number;
  private readonly valueReloader: () => T;

  private currentValue: T | undefined;
  private cachedSinceMilli: number | undefined;

  /**
   * Configures the expiration period and the function to use for obtaining the value each time the cached one expires.
   */
  constructor(expirationPeriodMillis: number, valueReloader: () => T) {
    this.expirationPeriodMillis = expirationPeriodMillis;
    this.valueReloader = valueReloader;
    this.currentValue = undefined;
    this.cachedSinceMilli = undefined;
  }

  /**
   * Returns a previously-cached (if not older than {@link #expirationPeriodMillis}) or freshly-obtained value from the
   * configured loading function.
   */
  get(): TimeBasedReloadingSlotGetResult<T> {
    const currentMilli = performance.now();
    let ageMillis;
    if (this.cachedSinceMilli === undefined || currentMilli - this.cachedSinceMilli > this.expirationPeriodMillis) {
      this.currentValue = this.valueReloader();
      this.cachedSinceMilli = currentMilli;
    } else {
      ageMillis = currentMilli - this.cachedSinceMilli;
    }
    return {
      value: this.currentValue!,
      ageMillis,
    };
  }
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
export class AsyncLoadingSlot<T> {
  private valueAsyncLoader: (() => Promise<T>) | undefined;
  private valuePromise: Promise<T> | undefined;

  /**
   * Configures the underlying function that should be loaded only once.
   */
  constructor(valueAsyncLoader: () => Promise<T>) {
    this.valueAsyncLoader = valueAsyncLoader;
  }

  /**
   * Gets the loaded value, either by delegating to the configured loader (on the first call ever), or by returning the
   * previously-cached result.
   */
  async get(): Promise<T> {
    if (this.valueAsyncLoader !== undefined) {
      this.valuePromise = this.valueAsyncLoader();
      this.valueAsyncLoader = undefined;
    }
    return this.valuePromise!;
  }
}
