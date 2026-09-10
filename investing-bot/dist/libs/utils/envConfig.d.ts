import { ConnectionPoolConfig, MulticastTransportConfig } from 'kvaults-investing-bot-tx/ConnectionPool';
import { Address } from '@solana/kit';
import { RpcEndpointsConfig } from 'kvaults-investing-bot-tx/model';
export { parseRpcEndpointsConfigEnvs } from './rpcConfig.js';
export type BaseEnvConfig = {
    wsEndpoint?: string;
    rpcEndpointsConfig: RpcEndpointsConfig;
    kswapApiBaseUrl: string;
    kswapApiKey?: string;
    klendProgramId: Address;
    kvaultsProgramId: Address;
    connectionPoolConfig: ConnectionPoolConfig;
    rpcMulticastEndpoints: Array<MulticastTransportConfig>;
    rpcEndpoint?: string;
    investVaultKeyOverrides: Address[];
    investVaultOwners: Address[];
    investUIVaults: boolean;
    allocationConfigPath: string;
    loopIntervalMs: number;
    minInvestTokens: number;
    minSecondsSinceLastInvest: number;
    defaultSwapSlippageBps: number;
    defaultPriceSlippageBps: number;
    gridSearchResolution: number;
    verbose: boolean;
    allocationDryRun: boolean;
    blacklistPath: string;
    marketPriceMaxAgeSeconds: number;
};
export declare function fromBaseEnv(): BaseEnvConfig;
export declare function parseEnvList(vaults: string): Address[];
/**
 * Send the same tx to multiple endpoints
 * e.g. RPC_MULTICAST_ENDPOINTS='[{"name": "ironforge", "connection": "https://..."}]'
 * Alternatively,
 * RPC_MULTICAST_ENDPOINT_IRONFORGE='https://...'
 */
export declare function getRpcMulticastEndpoints(): Array<MulticastTransportConfig>;
//# sourceMappingURL=envConfig.d.ts.map