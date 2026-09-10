import { createSolanaRpcSubscriptions, } from '@solana/kit';
import { Connection as LegacyConnection } from '@solana/web3.js';
import { createDefaultRpc, createResilientRpc, resolveRpcCallerChain, RpcEndpointConfig, RpcEndpointsConfig, RpcUrl, } from './model/index.js';
import { createResilientPriorityFeeProvider, NO_PRIORITY_FEE, resolvePriorityFeeProviderChain, } from './priority/index.js';
import { SOL } from './utils/index.js';
export const READ_CONNECTION_FINALITY = 'processed';
export const WRITE_CONNECTION_FINALITY = 'confirmed';
export class ConnectionPool {
    cluster;
    rpc;
    priorityFeeProvider;
    wsRpc;
    mccs;
    config;
    legacyReadConnection;
    constructor(cluster, rpc, priorityFeeProvider, wsRpc, config, mccs, legacyReadConnection) {
        this.cluster = cluster;
        this.rpc = rpc;
        this.priorityFeeProvider = priorityFeeProvider;
        this.wsRpc = wsRpc;
        this.config = config;
        this.mccs = mccs;
        this.legacyReadConnection = legacyReadConnection;
    }
    static new(cluster, rpcEndpointsConfig, wsConnectionEndpoint, mccs, config) {
        if (cluster === 'localnet') {
            const localnetRpc = createDefaultRpc(new RpcUrl('http://localhost:8899'));
            const localnetWs = createSolanaRpcSubscriptions('ws://localhost:8900');
            const legacyReadConnection = new LegacyConnection('http://localhost:8899', {
                commitment: READ_CONNECTION_FINALITY,
            });
            return new ConnectionPool(cluster, localnetRpc, NO_PRIORITY_FEE, localnetWs, config, mccs, legacyReadConnection);
        }
        const multicastRpcUrls = mccs.map(({ name, connection }) => new RpcUrl(connection).withCustomName(name));
        const rpc = createResilientRpc(resolveRpcCallerChain(rpcEndpointsConfig.allRpcs(), multicastRpcUrls));
        const priorityFeeConfig = config.priorityFeeConfig;
        const priorityFeeProvider = createResilientPriorityFeeProvider(resolvePriorityFeeProviderChain(rpcEndpointsConfig.allRpcs(), priorityFeeConfig.priorityFeePercentile), {
            defaultPerCu: SOL.microLamports(priorityFeeConfig.microLamportsPerCuDefault),
            maxPerCu: SOL.microLamports(priorityFeeConfig.microLamportsPerCuMax),
            minPerCu: SOL.microLamports(priorityFeeConfig.microLamportsPerCuMin),
        });
        // TODO(rpc-fallbacks): the WS here could use some similar fallback/redundancy mechanic:
        const wsRpc = createSolanaRpcSubscriptions(wsConnectionEndpoint ?? rpcEndpointsConfig.readUrl());
        const legacyReadConnection = new LegacyConnection(rpcEndpointsConfig.readUrl(), {
            commitment: READ_CONNECTION_FINALITY,
            wsEndpoint: wsConnectionEndpoint,
        });
        return new ConnectionPool(cluster, rpc, priorityFeeProvider, wsRpc, config, mccs, legacyReadConnection);
    }
    static singleConnection(cluster, readConnectionEndpoint, wsConnectionEndpoint) {
        return ConnectionPool.new(cluster, new RpcEndpointsConfig(new RpcEndpointConfig(new RpcUrl(readConnectionEndpoint))), wsConnectionEndpoint, [], {
            spam: false,
            simulate: true,
            multicastJito: false,
            priorityFeeConfig: {
                priorityFeePercentile: undefined,
                microLamportsPerCuDefault: 0,
                microLamportsPerCuMin: 0,
                microLamportsPerCuMax: 0,
            },
        });
    }
    cloneWithConfig(c) {
        return new ConnectionPool(this.cluster, this.rpc, this.priorityFeeProvider, this.wsRpc, c, this.mccs, this.legacyReadConnection);
    }
    getCluster() {
        return this.cluster;
    }
    getRpc() {
        return this.rpc;
    }
    getWsRpc() {
        return this.wsRpc;
    }
    getConfig() {
        return this.config;
    }
    shouldSpam() {
        return this.getConfig().spam;
    }
    shouldSimulate() {
        return this.getConfig().simulate;
    }
    shouldMulticastJito() {
        return this.getConfig().multicastJito;
    }
    getLegacyReadConnection() {
        return this.legacyReadConnection;
    }
    getPriorityFeeProvider() {
        return this.priorityFeeProvider;
    }
}
export function hideSensitiveRpcCredentials(url) {
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
//# sourceMappingURL=ConnectionPool.js.map