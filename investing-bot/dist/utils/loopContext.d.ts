import { KaminoManager } from '@kamino-finance/klend-sdk';
import { ConnectionPool } from 'kvaults-investing-bot-tx/ConnectionPool';
import { Cluster } from 'kvaults-investing-bot-tx/model';
import { SlotDurationRefreshScheduler } from './solanaUtils.js';
export interface KaminoManagerConsumer {
    updateKaminoManager(kaminoManager: KaminoManager): void;
}
export declare class KaminoManagerRefreshCoordinator {
    private kaminoManager;
    private readonly refreshKaminoManager;
    private readonly consumers;
    private readonly scheduler;
    constructor(kaminoManager: KaminoManager, refreshKaminoManager: () => Promise<KaminoManager>, consumers?: ReadonlyArray<KaminoManagerConsumer>, scheduler?: SlotDurationRefreshScheduler);
    getKaminoManager(): KaminoManager;
    millisecondsUntilRefresh(): number;
    refreshIfDue(): Promise<boolean>;
    completeWorkCycle(workPerformed: boolean): Promise<boolean>;
}
export declare function createLoopContext(cluster: Cluster): Promise<{
    envConfig: import("../libs/utils/envConfig.js").BaseEnvConfig;
    connectionPool: ConnectionPool;
    kaminoManager: KaminoManager;
    refreshKaminoManager: () => Promise<KaminoManager>;
}>;
//# sourceMappingURL=loopContext.d.ts.map