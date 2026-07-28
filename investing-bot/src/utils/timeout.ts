import { getEnvOrDefaultNum } from '../libs/utils/env.js';

export const EXTERNAL_REQUEST_TIMEOUT_MS = getEnvOrDefaultNum('EXTERNAL_REQUEST_TIMEOUT_MS', 30_000);
export const RPC_REQUEST_TIMEOUT_MS = getEnvOrDefaultNum('RPC_REQUEST_TIMEOUT_MS', 2 * 60_000);
if (!Number.isSafeInteger(EXTERNAL_REQUEST_TIMEOUT_MS) || EXTERNAL_REQUEST_TIMEOUT_MS <= 0) {
  throw new Error('EXTERNAL_REQUEST_TIMEOUT_MS must be a positive safe integer');
}
if (!Number.isSafeInteger(RPC_REQUEST_TIMEOUT_MS) || RPC_REQUEST_TIMEOUT_MS <= 0) {
  throw new Error('RPC_REQUEST_TIMEOUT_MS must be a positive safe integer');
}

/**
 * Watchdog for operations that should settle within a bounded time.
 * This rejects the caller on timeout, but does not cancel the underlying RPC/SDK promise.
 */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
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
