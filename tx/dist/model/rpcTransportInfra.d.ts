import { RpcTransport, SolanaRpcApi, Rpc } from '@solana/kit';
import { RpcEndpointConfig, RpcUrl } from './Cluster.js';
/**
 * A "true" interface wrapping the function interface {@link RpcTransport} (so that a class can implement it).
 */
export interface RpcCaller {
    /**
     * See {@link RpcTransport}.
     */
    call(...args: Parameters<RpcTransport>): ReturnType<RpcTransport>;
}
/**
 * A set of all already-resolved individual {@link RpcCaller}s used by liquidator.
 */
export type RpcCallerChain = {
    /**
     * A list of RPCs, in their fallback order.
     */
    readWriteRpcChain: ReadWriteRpcCallers[];
    /**
     * RPCs to additionally broadcast the {@link MULTICASTED_METHOD_NAMES} to.
     */
    multicastRpcs: Set<RpcCaller>;
};
export type ReadWriteRpcCallers = {
    /**
     * The caller (to be used for all calls, or just reading - depending on the {@link #dedicatedWriteRpcCaller}).
     */
    regularRpcCaller: RpcCaller;
    /**
     * An optional counterpart to be used in case of {@link WRITING_METHOD_NAMES}.
     */
    dedicatedWriteRpcCaller?: RpcCaller;
};
/**
 * Resolves an {@link RpcCallerChain} from configuration.
 */
export declare function resolveRpcCallerChain(regularRpcEndpoints: RpcEndpointConfig[], multicastRpcUrls: RpcUrl[]): RpcCallerChain;
/**
 * Creates a composite RPC by chaining the given individual RPCs (obtained from {@link resolveRpcCallerChain()}).
 *
 * Conceptually, the composite RPC built by this method will:
 * A. For {@link WRITING_METHOD_NAMES}:
 *   1. Consider the first RPC from the {@link RpcCallerChain#readWriteRpcChain}.
 *   2a. If it has {@link ReadWriteRpcCallers#dedicatedWriteRpcCaller} - call it.
 *   2b. Otherwise, call its {@link ReadWriteRpcCallers#regularRpcCaller}.
 *   3. In case of an error being thrown, log warn and consider the next RPC from the chain (and so on).
 * B. For {@link MULTICASTED_METHOD_NAMES}:
 *   1. Broadcast the call to all {@link RpcCallerChain#multicastRpcs}.
 *   2. In case of an error being thrown, log warn and ignore it.
 *   3. Continue to A. (see above)
 * C. For the remaining methods:
 *   1. Consider the first RPC from the {@link RpcCallerChain#readWriteRpcChain}.
 *   2. Call its {@link ReadWriteRpcCallers#regularRpcCaller}.
 *   3. In case of an error being thrown, log warn and consider the next RPC from the chain (and so on).
 */
export declare function createResilientRpc<TExtraMethods>(rpcCallerChain: RpcCallerChain): Rpc<RpcMethodTypes & TExtraMethods>;
/**
 * Creates a "plain" RPC from a single URL.
 */
export declare function createDefaultRpc<TExtraMethods>(url: RpcUrl): Rpc<RpcMethodTypes & TExtraMethods>;
export type RpcMethodTypes = SolanaRpcApi;
export declare function withDedicatedWrite(regularRpcCaller: RpcCaller, dedicatedWriteRpcCaller: RpcCaller): RpcCaller;
export declare class LabelledRpcCaller implements RpcCaller {
    private readonly transport;
    private readonly label;
    constructor(transport: RpcTransport, label: string);
    call(...args: Parameters<RpcTransport>): ReturnType<RpcTransport>;
    toString(): string;
}
//# sourceMappingURL=rpcTransportInfra.d.ts.map