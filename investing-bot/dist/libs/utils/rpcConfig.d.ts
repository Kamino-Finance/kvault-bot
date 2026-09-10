import { RpcEndpointsConfig } from 'kvaults-investing-bot-tx/model';
/**
 * Parses the RPC endpoints' configuration from environment variables.
 *
 * Legacy mode supports:
 * - `RPC_ENDPOINT`: a single URL.
 * - `RPC_ENDPOINTS`: a JSON array of {@link EnvRpcEndpointConfig} objects.
 * - `RPC_ENDPOINT_<x>`: a helm-ready variant of `RPC_ENDPOINTS`.
 *
 * Indexed mode is enabled with `USE_RPC_CONFIG_FILE=true` and supports:
 * - `RPC_READ_<n>`: read RPCs, in numeric fallback order.
 * - `RPC_SEND_<n>`: optional write RPC paired with `RPC_READ_<n>`.
 * - `RPC_PRIORITY_FEE_<n>_TRITON` / `RPC_PRIORITY_FEE_<n>_HELIUS`: RPCs that support priority fee APIs.
 */
export declare function parseRpcEndpointsConfigEnvs(): RpcEndpointsConfig;
//# sourceMappingURL=rpcConfig.d.ts.map