import {
  createSolanaRpcSubscriptions,
  RequestAirdropApi,
  Rpc,
  RpcSubscriptions,
  SolanaRpcApi,
  SolanaRpcSubscriptionsApi,
} from '@solana/kit';
import {
  Cluster,
  createDefaultRpc,
  createResilientRpc,
  DEFAULT_RPC_REQUEST_TIMEOUT_MS,
  resolveWebSocketEndpoint,
  resolveRpcCallerChain,
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
  private readonly rpc: Rpc<LiquidatorRpcApi>;
  private readonly priorityFeeProvider: PriorityFeeProvider;
  private readonly wsRpc: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  private readonly config: ConnectionPoolConfig;

  constructor(
    rpc: Rpc<LiquidatorRpcApi>,
    priorityFeeProvider: PriorityFeeProvider,
    wsRpc: RpcSubscriptions<SolanaRpcSubscriptionsApi>,
    config: ConnectionPoolConfig
  ) {
    this.rpc = rpc;
    this.priorityFeeProvider = priorityFeeProvider;
    this.wsRpc = wsRpc;
    this.config = config;
  }

  public static new(
    cluster: Cluster,
    rpcEndpointsConfig: RpcEndpointsConfig,
    wsConnectionEndpoint: string | undefined,
    mccs: Array<MulticastTransportConfig>,
    config: ConnectionPoolConfig
  ): ConnectionPool {
    if (cluster === 'localnet') {
      const localnetRpc = createDefaultRpc<LiquidatorRpcApi>(
        new RpcUrl('http://localhost:8899'),
        config.rpcRequestTimeoutMs
      );
      const localnetWs = createSolanaRpcSubscriptions('ws://localhost:8900');
      return new ConnectionPool(localnetRpc, NO_PRIORITY_FEE, localnetWs, config);
    }

    const multicastRpcUrls = mccs.map(({ name, connection }) => new RpcUrl(connection).withCustomName(name));

    const rpc = createResilientRpc<LiquidatorRpcApi>(
      resolveRpcCallerChain(rpcEndpointsConfig.allRpcs(), multicastRpcUrls, config.rpcRequestTimeoutMs)
    );

    const priorityFeeConfig = config.priorityFeeConfig;
    const priorityFeeProvider = createResilientPriorityFeeProvider(
      resolvePriorityFeeProviderChain(
        rpcEndpointsConfig.allRpcs(),
        priorityFeeConfig.priorityFeePercentile,
        config.externalRequestTimeoutMs,
        config.rpcRequestTimeoutMs
      ),
      {
        defaultPerCu: SOL.microLamports(priorityFeeConfig.microLamportsPerCuDefault),
        maxPerCu: SOL.microLamports(priorityFeeConfig.microLamportsPerCuMax),
        minPerCu: SOL.microLamports(priorityFeeConfig.microLamportsPerCuMin),
      }
    );

    // A blank WS_ENDPOINT (the profile template leaves it empty) counts as unset.
    const wsEndpoint = resolveWebSocketEndpoint(wsConnectionEndpoint, rpcEndpointsConfig.readUrl());
    const wsRpc = createSolanaRpcSubscriptions(wsEndpoint);

    return new ConnectionPool(rpc, priorityFeeProvider, wsRpc, config);
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

  /** Deadline for one RPC call, and for waiting on a transaction's confirmation. */
  public getRpcRequestTimeoutMs(): number {
    return this.getConfig().rpcRequestTimeoutMs ?? DEFAULT_RPC_REQUEST_TIMEOUT_MS;
  }

  public shouldMulticastJito(): boolean {
    return this.getConfig().multicastJito;
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
  /** Deadline for one RPC call; defaults to two minutes. */
  rpcRequestTimeoutMs?: number;
  /** Deadline for one external HTTP call such as a fee estimate; defaults to thirty seconds. */
  externalRequestTimeoutMs?: number;
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
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '****';
  }
  // Credentials travel as user-info, as any path segment, or as a query parameter: keep only scheme and host.
  return `${parsed.protocol}//${parsed.host}${parsed.pathname === '/' ? '' : '/****'}`;
}
