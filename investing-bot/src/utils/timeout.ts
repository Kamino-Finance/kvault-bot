import { readNumber } from '../config/schema.js';
import { SETTINGS } from '../config/settings.js';

export const EXTERNAL_REQUEST_TIMEOUT_MS = readNumber(SETTINGS.EXTERNAL_REQUEST_TIMEOUT_MS);
export const RPC_REQUEST_TIMEOUT_MS = readNumber(SETTINGS.RPC_REQUEST_TIMEOUT_MS);

/** The operation did not settle within its deadline. */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Watchdog for operations that should settle within a bounded time.
 * This rejects the caller on timeout, but does not cancel the underlying RPC/SDK promise.
 */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new TimeoutError(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
