import { sleep } from '@kamino-finance/klend-sdk';
import { logger } from 'kvaults-investing-bot-logger';
import { isProcessShuttingDown } from './shutdown.js';

/**
 * Completed passes reset the worker restart budget. Danger events update readiness.
 */
export type LoopHeartbeatEvent = 'pass-completed' | 'danger-failing' | 'danger-recovered';
export type LoopHeartbeat = (event?: LoopHeartbeatEvent) => void;

const HEARTBEAT_DURING_SLEEP_INTERVAL_MS = 10_000;

/** Sleeps in short intervals so shutdown and health checks are not blocked. */
export async function interruptibleSleep(
  milliseconds: number,
  heartbeat?: LoopHeartbeat,
  checkIntervalMilliseconds: number = 1_000
): Promise<boolean> {
  let sleptMilliseconds = 0;
  let lastHeartbeatAt = 0;
  while (sleptMilliseconds < milliseconds) {
    if (isProcessShuttingDown()) {
      return true;
    }
    const now = Date.now();
    if (heartbeat && now - lastHeartbeatAt >= HEARTBEAT_DURING_SLEEP_INTERVAL_MS) {
      heartbeat();
      lastHeartbeatAt = now;
    }
    const sleepMilliseconds = Math.min(checkIntervalMilliseconds, milliseconds - sleptMilliseconds);
    await sleep(sleepMilliseconds);
    sleptMilliseconds += sleepMilliseconds;
  }
  return isProcessShuttingDown();
}

/** Runs one read for a loop. A throw is logged as `<label>: <error>` and becomes undefined, so the caller decides how to skip. */
export async function attempt<T>(label: string, read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (e) {
    logger.error(`${label}: ${e}`);
    return undefined;
  }
}

/** How often a send in flight beats the loop heartbeat: well inside the heartbeat timeout of three RPC timeouts. */
/** Yields to the event loop, then beats the heartbeat. */
export async function yieldAndBeat(heartbeat?: LoopHeartbeat): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  heartbeat?.();
}

export const SEND_HEARTBEAT_INTERVAL_MS = 30_000;

export interface IntervalTimers {
  setInterval(callback: () => void, intervalMs: number): NodeJS.Timeout;
  clearInterval(handle: NodeJS.Timeout): void;
}

const DEFAULT_INTERVAL_TIMERS: IntervalTimers = {
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (handle) => clearInterval(handle),
};

/**
 * Runs `work` and beats `heartbeat` every SEND_HEARTBEAT_INTERVAL_MS until it settles. One transaction send can retry
 * past the heartbeat timeout; every RPC call in it has a deadline, so the send still ends.
 */
export async function whileBeating<T>(
  heartbeat: LoopHeartbeat | undefined,
  work: () => Promise<T>,
  timers: IntervalTimers = DEFAULT_INTERVAL_TIMERS
): Promise<T> {
  if (heartbeat === undefined) {
    return work();
  }
  const handle = timers.setInterval(() => heartbeat(), SEND_HEARTBEAT_INTERVAL_MS);
  try {
    return await work();
  } finally {
    timers.clearInterval(handle);
  }
}
