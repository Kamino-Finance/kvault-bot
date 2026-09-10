import { FeePercentileSupport, RpcEndpointConfig, RpcEndpointsConfig, RpcUrl } from 'kvaults-investing-bot-tx/model';
import { getAllEnvsByPrefix, getEnv, getEnvOrDefaultBool, getEnvOrDefaultJson, parseValidEnum } from './env.js';
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
export function parseRpcEndpointsConfigEnvs() {
    if (getEnvOrDefaultBool('USE_RPC_CONFIG_FILE', false)) {
        return parseIndexedRpcEndpointsConfigEnvs();
    }
    return parseLegacyRpcEndpointsConfigEnvs();
}
function parseIndexedRpcEndpointsConfigEnvs() {
    const readUrls = parseIndexedRpcUrlEnvs('RPC_READ');
    if (readUrls.length === 0) {
        throw new Error('USE_RPC_CONFIG_FILE=true requires at least one RPC_READ_<n> environment variable');
    }
    const readIndices = new Set(readUrls.map(({ index }) => index));
    const sendUrlsByIndex = new Map(parseIndexedRpcUrlEnvs('RPC_SEND').map((entry) => [entry.index, entry]));
    for (const sendUrl of sendUrlsByIndex.values()) {
        if (!readIndices.has(sendUrl.index)) {
            throw new Error(`${sendUrl.envName} requires a matching RPC_READ_${sendUrl.index}`);
        }
    }
    const readEndpoints = readUrls.map((readUrl) => {
        const endpoint = new RpcEndpointConfig(new RpcUrl(readUrl.url).withCustomName(readUrl.envName)).withFeePercentileSupport(resolveDefaultFeePercentileSupport(readUrl.url));
        const sendUrl = sendUrlsByIndex.get(readUrl.index);
        if (sendUrl !== undefined) {
            endpoint.withDedicatedWriteUrl(new RpcUrl(sendUrl.url).withCustomName(sendUrl.envName));
        }
        return endpoint;
    });
    const readEndpointByUrl = new Map(readEndpoints.map((endpoint) => [endpoint.url.url, endpoint]));
    const priorityFeeEndpoints = [];
    for (const priorityFeeUrl of parsePriorityFeeRpcUrlEnvs()) {
        const existingReadEndpoint = readEndpointByUrl.get(priorityFeeUrl.url);
        if (existingReadEndpoint !== undefined) {
            existingReadEndpoint.withFeePercentileSupport(priorityFeeUrl.feePercentileSupport);
            continue;
        }
        // The local RPC model represents fee-capable RPCs as regular endpoints with a fee-support flag.
        priorityFeeEndpoints.push(new RpcEndpointConfig(new RpcUrl(priorityFeeUrl.url).withCustomName(priorityFeeUrl.envName)).withFeePercentileSupport(priorityFeeUrl.feePercentileSupport));
    }
    const allRpcUrls = [...readEndpoints, ...priorityFeeEndpoints];
    const [primaryRpcUrl, ...fallbackRpcUrls] = allRpcUrls;
    return new RpcEndpointsConfig(primaryRpcUrl, ...fallbackRpcUrls);
}
function parseIndexedRpcUrlEnvs(envPrefix) {
    return [...getAllEnvsByPrefix(`${envPrefix}_`).entries()]
        .map(([keySuffix, url]) => parseIndexedRpcUrlEnv(envPrefix, keySuffix, url))
        .sort((left, right) => left.index - right.index);
}
function parseIndexedRpcUrlEnv(envPrefix, keySuffix, url) {
    const match = keySuffix.match(/^([1-9]\d*)$/);
    if (match === null) {
        throw new Error(`${envPrefix}_${keySuffix} must use ${envPrefix}_<n> format`);
    }
    return {
        envName: `${envPrefix}_${keySuffix}`,
        index: Number(match[1]),
        url,
    };
}
function parsePriorityFeeRpcUrlEnvs() {
    return [...getAllEnvsByPrefix('RPC_PRIORITY_FEE_').entries()]
        .map(([keySuffix, url]) => parsePriorityFeeRpcUrlEnv(keySuffix, url))
        .sort((left, right) => left.index - right.index || left.envName.localeCompare(right.envName));
}
function parsePriorityFeeRpcUrlEnv(keySuffix, url) {
    const match = keySuffix.match(/^([1-9]\d*)_(TRITON|HELIUS)$/);
    if (match === null) {
        throw new Error(`RPC_PRIORITY_FEE_${keySuffix} must use RPC_PRIORITY_FEE_<n>_TRITON or RPC_PRIORITY_FEE_<n>_HELIUS`);
    }
    const provider = match[2];
    return {
        envName: `RPC_PRIORITY_FEE_${keySuffix}`,
        index: Number(match[1]),
        url,
        feePercentileSupport: provider === 'TRITON' ? FeePercentileSupport.TritonStyle : FeePercentileSupport.HeliusStyle,
    };
}
function parseLegacyRpcEndpointsConfigEnvs() {
    const legacyOptionalSingleEndpoint = [getEnv('RPC_ENDPOINT')]
        .filter((env) => env !== undefined)
        .map((url) => new RpcEndpointConfig(new RpcUrl(url)).withFeePercentileSupport(resolveDefaultFeePercentileSupport(url)));
    const jsonArrayEndpoints = getEnvOrDefaultJson('RPC_ENDPOINTS', []).map((envRpcEndpointConfig) => parseRpcEndpointConfigJson(envRpcEndpointConfig));
    const flatEnvVarEndpoints = [...getAllEnvsByPrefix('RPC_ENDPOINT_').entries()]
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
        .map(([key, url]) => new RpcEndpointConfig(new RpcUrl(url).withCustomName(key)).withFeePercentileSupport(parseOverriddenFeePercentileSupport(key) ?? resolveDefaultFeePercentileSupport(url)));
    const allRpcUrls = [...legacyOptionalSingleEndpoint, ...jsonArrayEndpoints, ...flatEnvVarEndpoints];
    if (allRpcUrls.length === 0) {
        throw new Error(`At least one of RPC_ENDPOINT (legacy) or RPC_ENDPOINTS (json) or RPC_ENDPOINT_... (flat) environment variables must be specified`);
    }
    const [primaryRpcUrl, ...fallbackRpcUrls] = allRpcUrls;
    return new RpcEndpointsConfig(primaryRpcUrl, ...fallbackRpcUrls);
}
function parseOverriddenFeePercentileSupport(envKey) {
    return selectByOneOfSubstrings(envKey, new Map([
        ['FEES_TRITON_STYLE', FeePercentileSupport.TritonStyle],
        ['FEES_HELIUS_STYLE', FeePercentileSupport.HeliusStyle],
        ['FEES_NONE', FeePercentileSupport.None],
    ]));
}
function selectByOneOfSubstrings(sourceString, valuesBySubstrings) {
    const matchedSubstrings = [...valuesBySubstrings.entries()]
        .filter(([substring]) => sourceString.includes(substring))
        .map(([, value]) => value);
    if (matchedSubstrings.length > 1) {
        throw new Error(`Expected to find at most one of ${[...valuesBySubstrings.keys()]} within ${sourceString}`);
    }
    if (matchedSubstrings.length === 0) {
        return undefined;
    }
    return matchedSubstrings[0];
}
function parseRpcEndpointConfigJson(envRpcEndpointConfig) {
    const { url, dedicatedWriteUrl, name, feePercentileSupportOverride } = envRpcEndpointConfig;
    const rpcUrl = new RpcUrl(url);
    if (name !== undefined) {
        rpcUrl.withCustomName(name);
    }
    const rpcEndpointConfig = new RpcEndpointConfig(rpcUrl);
    rpcEndpointConfig.withFeePercentileSupport(feePercentileSupportOverride !== undefined
        ? parseValidEnum(FeePercentileSupport, feePercentileSupportOverride)
        : resolveDefaultFeePercentileSupport(url));
    if (dedicatedWriteUrl !== undefined) {
        const writeUrl = new RpcUrl(dedicatedWriteUrl);
        if (name !== undefined) {
            writeUrl.withCustomName(`${name} (write)`);
        }
        rpcEndpointConfig.withDedicatedWriteUrl(writeUrl);
    }
    return rpcEndpointConfig;
}
function resolveDefaultFeePercentileSupport(rpcUrl) {
    if (rpcUrl.includes('rpcpool.com')) {
        return FeePercentileSupport.TritonStyle;
    }
    if (rpcUrl.includes('helius-rpc.com')) {
        return FeePercentileSupport.HeliusStyle;
    }
    return FeePercentileSupport.None;
}
//# sourceMappingURL=rpcConfig.js.map