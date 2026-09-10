import { Rpc, SolanaRpcApi } from '@solana/kit';
import { Decimal } from 'decimal.js';
export declare const SLOT_DURATION_REFRESH_IDLE_INTERVAL_MS: number;
export declare class SlotDurationRefreshScheduler {
    private readonly nowMilliseconds;
    private workCyclesSinceRefresh;
    private lastRefreshAtMilliseconds;
    constructor(nowMilliseconds?: () => number);
    recordWorkCycle(): void;
    millisecondsUntilRefresh(): number;
    refreshIfDue(refresh: () => Promise<void>): Promise<boolean>;
}
export declare function getMinimumSlotsForDurationSeconds(durationSeconds: number, slotDurationMilliseconds: number): Decimal;
export declare function getMedianSlotDurationInMsFromLastEpochsOrDefault(rpc: Rpc<SolanaRpcApi>, fallbackSlotDurationMs?: number, readApiSlotDuration?: () => Promise<number>): Promise<number>;
//# sourceMappingURL=solanaUtils.d.ts.map