import { KaminoManager } from '@kamino-finance/klend-sdk';
import { Rpc, SolanaRpcApi } from '@solana/kit';
import { logger } from 'kvaults-investing-bot-logger';
import { ConnectionPool } from 'kvaults-investing-bot-tx/ConnectionPool';
import { Cluster } from 'kvaults-investing-bot-tx/model';
import { DEFAULT_MEDIAN_SLOT_DURATION_IN_MS } from '../libs/utils/consts.js';
import { fromBaseEnv } from '../libs/utils/envConfig.js';
import { getMedianSlotDurationInMsFromLastEpochsOrDefault, SlotDurationRefreshScheduler } from './solanaUtils.js';

export interface KaminoManagerConsumer {
  updateKaminoManager(kaminoManager: KaminoManager): void;
}

export class KaminoManagerRefreshCoordinator {
  constructor(
    private kaminoManager: KaminoManager,
    private readonly refreshKaminoManager: () => Promise<KaminoManager>,
    private readonly consumers: ReadonlyArray<KaminoManagerConsumer> = [],
    private readonly scheduler: SlotDurationRefreshScheduler = new SlotDurationRefreshScheduler()
  ) {}

  getKaminoManager(): KaminoManager {
    return this.kaminoManager;
  }

  millisecondsUntilRefresh(): number {
    return this.scheduler.millisecondsUntilRefresh();
  }

  async refreshIfDue(): Promise<boolean> {
    return this.scheduler.refreshIfDue(async () => {
      const refreshedKaminoManager = await this.refreshKaminoManager();
      for (const consumer of this.consumers) {
        consumer.updateKaminoManager(refreshedKaminoManager);
      }
      this.kaminoManager = refreshedKaminoManager;
    });
  }

  async completeWorkCycle(workPerformed: boolean): Promise<boolean> {
    if (workPerformed) {
      this.scheduler.recordWorkCycle();
    }
    return this.refreshIfDue();
  }
}

export async function createLoopContext(cluster: Cluster) {
  const envConfig = fromBaseEnv();
  const connectionPool = ConnectionPool.new(
    cluster,
    envConfig.rpcEndpointsConfig,
    envConfig.wsEndpoint,
    envConfig.rpcMulticastEndpoints,
    envConfig.connectionPoolConfig
  );
  const rpc = connectionPool.getRpc() as Rpc<SolanaRpcApi>;
  let lastKnownSlotDurationMilliseconds = DEFAULT_MEDIAN_SLOT_DURATION_IN_MS;
  const refreshKaminoManager = async () => {
    const slotDurationMilliseconds = await getMedianSlotDurationInMsFromLastEpochsOrDefault(
      rpc,
      lastKnownSlotDurationMilliseconds
    );
    lastKnownSlotDurationMilliseconds = slotDurationMilliseconds;
    logger.info(`[slot-duration] KaminoManager uses ${slotDurationMilliseconds} ms per slot`);
    return new KaminoManager(rpc, slotDurationMilliseconds, envConfig.klendProgramId, envConfig.kvaultsProgramId);
  };
  const kaminoManager = await refreshKaminoManager();
  return { envConfig, connectionPool, kaminoManager, refreshKaminoManager };
}
