export type Fetcher = typeof fetch;
export declare enum RecentPeriod {
    ONE_MINUTE = 1,
    FIVE_MINUTES = 5,
    FIFTEEN_MINUTES = 15
}
export declare function getAverageFeesPerCUForPeriodLamports(fetcher: Fetcher, period: RecentPeriod): Promise<number>;
export declare function getAverageFees(fetcher: Fetcher): Promise<SolanaCompassFeesByPeriod>;
export type SolanaCompassFeesByPeriod = {
    1: SolanaCompassFees;
    5: SolanaCompassFees;
    15: SolanaCompassFees;
};
export type SolanaCompassFees = {
    min: number;
    max: number;
    avg: number;
    priorityTx: number;
    nonVotes: number;
    priorityRatio: number;
    avgCuPerBlock: number;
    blockspaceUsageRatio: number;
};
//# sourceMappingURL=solanaCompass.d.ts.map