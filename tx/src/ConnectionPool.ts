import {
  createSolanaRpcSubscriptions,
  RequestAirdropApi,
  Rpc,
  RpcSubscriptions,
  SolanaRpcApi,
  SolanaRpcSubscriptionsApi,
} from '@solana/kit';
import { Connection as LegacyConnection } from '@solana/web3.js';
import {
  Cluster,
  createDefaultRpc,
  createResilientRpc,
  resolveRpcCallerChain,
  RpcEndpointConfig,
  RpcEndpointsConfig,
  RpcUrl,
} from './model/index.js';
import {
  createResilientPriorityFeeProvider,
  GetPriorityFeeEstimateApi,
  GetRecentPrioritizationFeesPercentileApi,
  NO_PRIORITY_FEE,
  PriorityFeeProvider,
  resolvePriorityFeeProviderChain,
} from './priority/index.js';
import { SOL } from './utils/index.js';

export const READ_CONNECTION_FINALITY = 'processed';
export const WRITE_CONNECTION_FINALITY = 'confirmed';

export type MulticastTransportConfig = {
  name: string;
  connection: string;
};

export type LiquidatorRpcApi = SolanaRpcApi &
  RequestAirdropApi &
  GetRecentPrioritizationFeesPercentileApi &
  GetPriorityFeeEstimateApi;

export class ConnectionPool {
  private readonly cluster: Cluster;
  private readonly rpc: Rpc<LiquidatorRpcApi>;
  private readonly priorityFeeProvider: PriorityFeeProvider;
  private readonly wsRpc: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  private readonly mccs: Array<MulticastTransportConfig>;
  private readonly config: ConnectionPoolConfig;
  private readonly legacyReadConnection: LegacyConnection;

  constructor(
    cluster: Cluster,
    rpc: Rpc<LiquidatorRpcApi>,
    priorityFeeProvider: PriorityFeeProvider,
    wsRpc: RpcSubscriptions<SolanaRpcSubscriptionsApi>,
    config: ConnectionPoolConfig,
    mccs: Array<MulticastTransportConfig>,
    legacyReadConnection: LegacyConnection
  ) {
    this.cluster = cluster;
    this.rpc = rpc;
    this.priorityFeeProvider = priorityFeeProvider;
    this.wsRpc = wsRpc;
    this.config = config;
    this.mccs = mccs;
    this.legacyReadConnection = legacyReadConnection;
  }

  public static new(
    cluster: Cluster,
    rpcEndpointsConfig: RpcEndpointsConfig,
    wsConnectionEndpoint: string | undefined,
    mccs: Array<MulticastTransportConfig>,
    config: ConnectionPoolConfig
  ): ConnectionPool {
    if (cluster === 'localnet') {
      const localnetRpc = createDefaultRpc<LiquidatorRpcApi>(new RpcUrl('http://localhost:8899'));
      const localnetWs = createSolanaRpcSubscriptions('ws://localhost:8900');

      const legacyReadConnection = new LegacyConnection('http://localhost:8899', {
        commitment: READ_CONNECTION_FINALITY,
      });

      return new ConnectionPool(cluster, localnetRpc, NO_PRIORITY_FEE, localnetWs, config, mccs, legacyReadConnection);
    }

    const multicastRpcUrls = mccs.map(({ name, connection }) => new RpcUrl(connection).withCustomName(name));

    const rpc = createResilientRpc<LiquidatorRpcApi>(
      resolveRpcCallerChain(rpcEndpointsConfig.allRpcs(), multicastRpcUrls)
    );

    const priorityFeeConfig = config.priorityFeeConfig;
    const priorityFeeProvider = createResilientPriorityFeeProvider(
      resolvePriorityFeeProviderChain(rpcEndpointsConfig.allRpcs(), priorityFeeConfig.priorityFeePercentile),
      {
        defaultPerCu: SOL.microLamports(priorityFeeConfig.microLamportsPerCuDefault),
        maxPerCu: SOL.microLamports(priorityFeeConfig.microLamportsPerCuMax),
        minPerCu: SOL.microLamports(priorityFeeConfig.microLamportsPerCuMin),
      }
    );

    // TODO(rpc-fallbacks): the WS here could use some similar fallback/redundancy mechanic:
    const wsRpc = createSolanaRpcSubscriptions(wsConnectionEndpoint ?? rpcEndpointsConfig.readUrl());

    const legacyReadConnection = new LegacyConnection(rpcEndpointsConfig.readUrl(), {
      commitment: READ_CONNECTION_FINALITY,
      wsEndpoint: wsConnectionEndpoint,
    });

    return new ConnectionPool(cluster, rpc, priorityFeeProvider, wsRpc, config, mccs, legacyReadConnection);
  }

  public static singleConnection(
    cluster: Cluster,
    readConnectionEndpoint: string,
    wsConnectionEndpoint?: string
  ): ConnectionPool {
    return ConnectionPool.new(
      cluster,
      new RpcEndpointsConfig(new RpcEndpointConfig(new RpcUrl(readConnectionEndpoint))),
      wsConnectionEndpoint,
      [],
      {
        spam: false,
        simulate: true,
        multicastJito: false,
        priorityFeeConfig: {
          priorityFeePercentile: undefined,
          microLamportsPerCuDefault: 0,
          microLamportsPerCuMin: 0,
          microLamportsPerCuMax: 0,
        },
      }
    );
  }

  public cloneWithConfig(c: ConnectionPoolConfig): ConnectionPool {
    return new ConnectionPool(
      this.cluster,
      this.rpc,
      this.priorityFeeProvider,
      this.wsRpc,
      c,
      this.mccs,
      this.legacyReadConnection
    );
  }

  public getCluster(): Cluster {
    return this.cluster;
  }

  public getRpc(): Rpc<LiquidatorRpcApi> {
    return this.rpc;
  }

  public getWsRpc(): RpcSubscriptions<SolanaRpcSubscriptionsApi> {
    return this.wsRpc;
  }

  public getConfig(): ConnectionPoolConfig {
    return this.config;
  }

  public shouldSpam(): boolean {
    return this.getConfig().spam;
  }

  public shouldSimulate(): boolean {
    return this.getConfig().simulate;
  }

  public shouldMulticastJito(): boolean {
    return this.getConfig().multicastJito;
  }

  public getLegacyReadConnection(): LegacyConnection {
    return this.legacyReadConnection;
  }

  public getPriorityFeeProvider(): PriorityFeeProvider {
    return this.priorityFeeProvider;
  }
}

export type ConnectionPoolConfig = {
  spam: boolean;
  simulate: boolean;
  multicastJito: boolean;
  priorityFeeConfig: PriorityFeeConfig;
};

export type PriorityFeeConfig = {
  /**
   * A percentile to query the priority fee API with.
   * The value of `75` means "75th percentile" (i.e. not bps).
   *
   * If skipped, then it means that the configured RPC does not support percentile queries.
   *
   * See https://docs.triton.one/chains/solana/improved-priority-fees-api for details.
   */
  priorityFeePercentile?: number;
  microLamportsPerCuDefault: number;
  microLamportsPerCuMin: number;
  microLamportsPerCuMax: number;
};

export function hideSensitiveRpcCredentials(url: string): string {
  if (url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1')) {
    return url;
  }
  // Remove query params
  let queryParamsRemoved = url.replace(/\?.*/, '');
  // Remove paths
  queryParamsRemoved = queryParamsRemoved.replace(/(\/\/[^/]+\/)[^/]+/, '$1****');
  queryParamsRemoved = queryParamsRemoved.replace(/(apiKey=)[^&]+/, '$1xxxx');
  return queryParamsRemoved;
}
