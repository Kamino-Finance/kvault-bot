export declare const EXTERNAL_REQUEST_TIMEOUT_MS: number;
export declare const RPC_REQUEST_TIMEOUT_MS: number;
/**
 * Watchdog for operations that should settle within a bounded time.
 * This rejects the caller on timeout, but does not cancel the underlying RPC/SDK promise.
 */
export declare function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T>;
//# sourceMappingURL=timeout.d.ts.map