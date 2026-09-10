import { RequestAirdropApi, Rpc, RpcSubscriptions, SolanaRpcApi, SolanaRpcSubscriptionsApi } from '@solana/kit';
import { Connection as LegacyConnection } from '@solana/web3.js';
import { Cluster, RpcEndpointsConfig } from './model/index.js';
import { GetPriorityFeeEstimateApi, GetRecentPrioritizationFeesPercentileApi, PriorityFeeProvider } from './priority/index.js';
export declare const READ_CONNECTION_FINALITY = "processed";
export declare const WRITE_CONNECTION_FINALITY = "confirmed";
export type MulticastTransportConfig = {
    name: string;
    connection: string;
};
export type LiquidatorRpcApi = SolanaRpcApi & RequestAirdropApi & GetRecentPrioritizationFeesPercentileApi & GetPriorityFeeEstimateApi;
export declare class ConnectionPool {
    private readonly cluster;
    private readonly rpc;
    private readonly priorityFeeProvider;
    private readonly wsRpc;
    private readonly mccs;
    private readonly config;
    private readonly legacyReadConnection;
    constructor(cluster: Cluster, rpc: Rpc<LiquidatorRpcApi>, priorityFeeProvider: PriorityFeeProvider, wsRpc: RpcSubscriptions<SolanaRpcSubscriptionsApi>, config: ConnectionPoolConfig, mccs: Array<MulticastTransportConfig>, legacyReadConnection: LegacyConnection);
    static new(cluster: Cluster, rpcEndpointsConfig: RpcEndpointsConfig, wsConnectionEndpoint: string | undefined, mccs: Array<MulticastTransportConfig>, config: ConnectionPoolConfig): ConnectionPool;
    static singleConnection(cluster: Cluster, readConnectionEndpoint: string, wsConnectionEndpoint?: string): ConnectionPool;
    cloneWithConfig(c: ConnectionPoolConfig): ConnectionPool;
    getCluster(): Cluster;
    getRpc(): Rpc<LiquidatorRpcApi>;
    getWsRpc(): RpcSubscriptions<SolanaRpcSubscriptionsApi>;
    getConfig(): ConnectionPoolConfig;
    shouldSpam(): boolean;
    shouldSimulate(): boolean;
    shouldMulticastJito(): boolean;
    getLegacyReadConnection(): LegacyConnection;
    getPriorityFeeProvider(): PriorityFeeProvider;
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
export declare function hideSensitiveRpcCredentials(url: string): string;
//# sourceMappingURL=ConnectionPool.d.ts.map