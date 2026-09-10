export type LoopHeartbeat = () => void;
/** Sleeps in short intervals so shutdown and health checks are not blocked. */
export declare function interruptibleSleep(milliseconds: number, heartbeat?: LoopHeartbeat, checkIntervalMilliseconds?: number): Promise<boolean>;
//# sourceMappingURL=loop.d.ts.map