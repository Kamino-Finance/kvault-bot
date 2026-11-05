/**
 * Observations that stateful triggers stage during a danger pass and commit only once the pass has
 * durably recorded its results. Staging is keyed by the pass generation: a pass that outlived its
 * watchdog keeps staging under its own generation, so a newer pass never commits a stale value.
 *
 * Every stage and take also drops what older, superseded passes left behind, so staging never
 * accumulates even when a pass commits nothing (for example a dry-run-only setup).
 */
export class StagedObservations<T> {
  private readonly staged = new Map<string, { generation: number; value: T }>();

  /** Stages one observation for `key` under this generation. */
  stage(generation: number, key: string, value: T): void {
    this.staged.set(stagingKey(generation, key), { generation, value });
    this.pruneOlderThan(generation);
  }

  /** Removes and returns the observation this generation staged for `key`. */
  take(generation: number, key: string): T | undefined {
    const own = stagingKey(generation, key);
    const value = this.staged.get(own)?.value;
    this.staged.delete(own);
    this.pruneOlderThan(generation);
    return value;
  }

  private pruneOlderThan(generation: number): void {
    for (const [key, entry] of this.staged) {
      if (entry.generation < generation) this.staged.delete(key);
    }
  }
}

function stagingKey(generation: number, key: string): string {
  return `${generation}|${key}`;
}
