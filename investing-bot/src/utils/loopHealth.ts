import { logger } from 'kvaults-investing-bot-logger';

/**
 * Ready while all enabled loops have recent heartbeats and danger monitoring is not failing.
 */
export class LoopHealth<Loop extends string> {
  /** Last heartbeat of each expected loop in ms; 0 before the first one and after a loop failed. */
  private readonly lastHeartbeatMsByLoop = new Map<Loop, number>();
  private dangerPassesFailing = false;
  private lastReady: boolean | undefined;

  constructor(
    expectedLoops: Loop[],
    private readonly timeoutMs: number,
    /** Publishes a readiness change. Without it the bot runs no health server and readiness is not computed. */
    private readonly setReady: ((ready: boolean) => void) | undefined,
    private readonly isShuttingDown: () => boolean,
    private readonly nowMs: () => number = Date.now
  ) {
    for (const loop of expectedLoops) {
      this.lastHeartbeatMsByLoop.set(loop, 0);
    }
  }

  markHeartbeat(loop: Loop): void {
    if (!this.lastHeartbeatMsByLoop.has(loop)) return;
    this.lastHeartbeatMsByLoop.set(loop, this.nowMs());
    this.update();
  }

  markUnhealthy(loop: Loop): void {
    if (!this.lastHeartbeatMsByLoop.has(loop)) return;
    this.lastHeartbeatMsByLoop.set(loop, 0);
    this.update();
  }

  /** Records whether the allocation loop's danger passes are failing. */
  setDangerPassesFailing(failing: boolean): void {
    this.dangerPassesFailing = failing;
    this.update();
  }

  /** Recomputes readiness and publishes it when it changed. */
  update(): void {
    if (!this.setReady) return;
    if (this.isShuttingDown()) {
      this.publish(false);
      return;
    }
    const nowMs = this.nowMs();
    const staleLoops = Array.from(this.lastHeartbeatMsByLoop)
      .filter(([, lastHeartbeatMs]) => lastHeartbeatMs === 0 || nowMs - lastHeartbeatMs > this.timeoutMs)
      .map(([loop]) => loop);
    const reasons = [
      ...(staleLoops.length > 0 ? [`stale loops: ${staleLoops.join(', ')}`] : []),
      ...(this.dangerPassesFailing ? ['allocation danger passes are failing'] : []),
    ];
    if (reasons.length > 0 && this.lastReady !== false) {
      logger.warn(`[health] marking not ready; ${reasons.join('; ')}`);
    }
    this.publish(reasons.length === 0);
  }

  private publish(ready: boolean): void {
    if (this.lastReady === ready) return;
    this.setReady!(ready);
    this.lastReady = ready;
  }
}
