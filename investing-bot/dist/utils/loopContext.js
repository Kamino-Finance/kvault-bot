import { KaminoManager } from '@kamino-finance/klend-sdk';
import { logger } from 'kvaults-investing-bot-logger';
import { ConnectionPool } from 'kvaults-investing-bot-tx/ConnectionPool';
import { DEFAULT_MEDIAN_SLOT_DURATION_IN_MS } from '../libs/utils/consts.js';
import { fromBaseEnv } from '../libs/utils/envConfig.js';
import { getMedianSlotDurationInMsFromLastEpochsOrDefault, SlotDurationRefreshScheduler } from './solanaUtils.js';
export class KaminoManagerRefreshCoordinator {
    kaminoManager;
    refreshKaminoManager;
    consumers;
    scheduler;
    constructor(kaminoManager, refreshKaminoManager, consumers = [], scheduler = new SlotDurationRefreshScheduler()) {
        this.kaminoManager = kaminoManager;
        this.refreshKaminoManager = refreshKaminoManager;
        this.consumers = consumers;
        this.scheduler = scheduler;
    }
    getKaminoManager() {
        return this.kaminoManager;
    }
    millisecondsUntilRefresh() {
        return this.scheduler.millisecondsUntilRefresh();
    }
    async refreshIfDue() {
        return this.scheduler.refreshIfDue(async () => {
            const refreshedKaminoManager = await this.refreshKaminoManager();
            for (const consumer of this.consumers) {
                consumer.updateKaminoManager(refreshedKaminoManager);
            }
            this.kaminoManager = refreshedKaminoManager;
        });
    }
    async completeWorkCycle(workPerformed) {
        if (workPerformed) {
            this.scheduler.recordWorkCycle();
        }
        return this.refreshIfDue();
    }
}
export async function createLoopContext(cluster) {
    const envConfig = fromBaseEnv();
    const connectionPool = ConnectionPool.new(cluster, envConfig.rpcEndpointsConfig, envConfig.wsEndpoint, envConfig.rpcMulticastEndpoints, envConfig.connectionPoolConfig);
    const rpc = connectionPool.getRpc();
    let lastKnownSlotDurationMilliseconds = DEFAULT_MEDIAN_SLOT_DURATION_IN_MS;
    const refreshKaminoManager = async () => {
        const slotDurationMilliseconds = await getMedianSlotDurationInMsFromLastEpochsOrDefault(rpc, lastKnownSlotDurationMilliseconds);
        lastKnownSlotDurationMilliseconds = slotDurationMilliseconds;
        logger.info(`[slot-duration] KaminoManager uses ${slotDurationMilliseconds} ms per slot`);
        return new KaminoManager(rpc, slotDurationMilliseconds, envConfig.klendProgramId, envConfig.kvaultsProgramId);
    };
    const kaminoManager = await refreshKaminoManager();
    return { envConfig, connectionPool, kaminoManager, refreshKaminoManager };
}
//# sourceMappingURL=loopContext.js.map