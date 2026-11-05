import { logger } from 'kvaults-investing-bot-logger';

/** Messages the allocation worker posts to the main thread. */
export type AllocationWorkerMessage =
  | { type: 'heartbeat' }
  | { type: 'pass-completed' }
  | { type: 'danger-failing' }
  | { type: 'danger-recovered' }
  | { type: 'no-new-funds'; reserves: string[] }
  | { type: 'error'; error: string };

/** The subset of `worker_threads.Worker` the supervisor uses. */
export interface WorkerLike {
  on(event: 'message', listener: (message: AllocationWorkerMessage) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (exitCode: number) => void): unknown;
  once(event: 'exit', listener: (exitCode: number) => void): unknown;
  postMessage(message: { type: 'shutdown' }): void;
  terminate(): Promise<number>;
}

export interface SupervisorTimers {
  setTimeout(callback: () => void, delayMs: number): NodeJS.Timeout;
  clearTimeout(handle: NodeJS.Timeout): void;
}

export interface AllocationWorkerSupervisorDeps {
  createWorker: () => WorkerLike;
  onHeartbeat: () => void;
  onUnhealthy: () => void;
  /** Reports danger-pass failure and recovery. */
  onDangerStatus?: (failing: boolean) => void;
  /** Reports deposit exclusions after each successful danger pass. */
  onNoNewFundsReserves?: (reserves: string[]) => void;
  isShuttingDown: () => boolean;
  timers?: SupervisorTimers;
  restartDelayMs?: number;
  /** Consecutive worker exits, with no completed pass in between, before the loop is marked unhealthy. */
  maxRestarts?: number;
  terminateGraceMs?: number;
}

const DEFAULT_TIMERS: SupervisorTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

/** Runs the allocation worker thread, restarts it after unexpected exits, and stops it on shutdown. */
export class AllocationWorkerSupervisor {
  private readonly timers: SupervisorTimers;
  private readonly restartDelayMs: number;
  private readonly maxRestarts: number;
  private readonly terminateGraceMs: number;
  private worker: WorkerLike | null = null;
  /** Workers that have exited; stop() does not wait for an exit that already happened. */
  private readonly exitedWorkers = new WeakSet<WorkerLike>();
  private restartCount = 0;
  /** A scheduled worker restart; cleared on stop so no new worker starts while the process exits. */
  private pendingRestart: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(private readonly deps: AllocationWorkerSupervisorDeps) {
    this.timers = deps.timers ?? DEFAULT_TIMERS;
    this.restartDelayMs = deps.restartDelayMs ?? 5000;
    this.maxRestarts = deps.maxRestarts ?? 3;
    this.terminateGraceMs = deps.terminateGraceMs ?? 5000;
  }

  start(): void {
    logger.info('[allocation-worker] Starting allocation loop in worker thread');

    const worker = this.deps.createWorker();
    let restartScheduled = false;

    const scheduleRestart = () => {
      if (restartScheduled || this.isStopping()) {
        return;
      }
      if (this.restartCount >= this.maxRestarts) {
        logger.error('[allocation-worker] Max restarts reached, stopping');
        this.deps.onUnhealthy();
        return;
      }

      this.restartCount++;
      restartScheduled = true;
      logger.info(`[allocation-worker] Restarting worker (${this.restartCount}/${this.maxRestarts})`);
      this.pendingRestart = this.timers.setTimeout(() => {
        this.pendingRestart = null;
        if (this.isStopping()) return;
        this.start();
      }, this.restartDelayMs);
    };

    worker.on('message', (message) => {
      if (message.type === 'heartbeat') {
        this.deps.onHeartbeat();
      } else if (message.type === 'pass-completed') {
        // A completed pass is the checkpoint that clears the restart budget. A worker that heartbeats
        // once mid-pass and then dies must not restart without bound.
        this.restartCount = 0;
        this.deps.onHeartbeat();
      } else if (message.type === 'danger-failing' || message.type === 'danger-recovered') {
        this.deps.onDangerStatus?.(message.type === 'danger-failing');
      } else if (message.type === 'no-new-funds') {
        this.deps.onNoNewFundsReserves?.(message.reserves);
      } else if (message.type === 'error') {
        logger.error('[allocation-worker] Worker error:', message.error);
      }
    });

    // A worker error ends in an exit, which restarts the worker. The loop is marked unhealthy only when the restart
    // budget is spent: marking it at once lets the liveness probe kill the pod before the new worker beats. A worker that
    // never beats again still goes unhealthy through the heartbeat timeout.
    worker.on('error', (error) => {
      logger.error('[allocation-worker] Worker error:', error);
    });

    worker.on('exit', (code) => {
      this.exitedWorkers.add(worker);
      if (this.isStopping()) {
        return;
      }
      logger.error(`[allocation-worker] Worker exited unexpectedly with code ${code}`);
      scheduleRestart();
    });

    this.worker = worker;
  }

  /** Cancels a pending restart, asks the worker to shut down, and terminates it after the grace period. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.pendingRestart) {
      this.timers.clearTimeout(this.pendingRestart);
      this.pendingRestart = null;
    }

    const worker = this.worker;
    if (!worker || this.exitedWorkers.has(worker)) {
      return;
    }
    logger.info('Terminating allocation worker...');
    worker.postMessage({ type: 'shutdown' });

    await new Promise<void>((resolve) => {
      const timeout = this.timers.setTimeout(() => {
        logger.warn('Worker did not terminate gracefully, forcing termination');
        worker.terminate().then(
          () => resolve(),
          () => resolve()
        );
      }, this.terminateGraceMs);

      worker.once('exit', () => {
        this.timers.clearTimeout(timeout);
        resolve();
      });
    });
  }

  private isStopping(): boolean {
    return this.stopping || this.deps.isShuttingDown();
  }
}
