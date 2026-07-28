import { KaminoManager } from '@kamino-finance/klend-sdk';
import { Rpc, SolanaRpcApi } from '@solana/kit';
import { ConnectionPool } from 'kvaults-investing-bot-tx/ConnectionPool';
import { Cluster } from 'kvaults-investing-bot-tx/model';
import { fromBaseEnv } from '../libs/utils/envConfig.js';
import { getMedianSlotDurationInMsFromLastEpochsOrDefault } from './solanaUtils.js';

export async function createLoopContext(cluster: Cluster) {
  const envConfig = fromBaseEnv();
  const connectionPool = ConnectionPool.new(
    cluster,
    envConfig.rpcEndpointsConfig,
    envConfig.wsEndpoint,
    envConfig.rpcMulticastEndpoints,
    envConfig.connectionPoolConfig
  );
  const slotDurationMilliseconds = await getMedianSlotDurationInMsFromLastEpochsOrDefault();
  const kaminoManager = new KaminoManager(
    connectionPool.getRpc() as Rpc<SolanaRpcApi>,
    slotDurationMilliseconds,
    envConfig.klendProgramId,
    envConfig.kvaultsProgramId
  );
  return { envConfig, connectionPool, kaminoManager };
}
