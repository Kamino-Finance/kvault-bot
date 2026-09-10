import { createDefaultRpcTransport, createRpc, createSolanaRpcApi, DEFAULT_RPC_CONFIG, } from '@solana/kit';
import { logger } from 'kvaults-investing-bot-logger';
import { READ_CONNECTION_FINALITY } from '../ConnectionPool.js';
// Note: the method name consts below are defined in this convoluted way only to ensure no typos.
/**
 * Names of Solana RPC methods that should be multicasted to all configured multicast RPCs.
 */
const MULTICASTED_METHOD_NAMES = ['sendTransaction'];
/**
 * Names of Solana RPC methods that are related to "writing" operations.
 */
const WRITING_METHOD_NAMES = [
    'getEpochInfo',
    'getLatestBlockhash',
    'getTransaction',
    'getSignatureStatuses',
    'getSlot',
    'simulateTransaction',
];
/**
 * Resolves an {@link RpcCallerChain} from configuration.
 */
export function resolveRpcCallerChain(regularRpcEndpoints, multicastRpcUrls) {
    const readWriteRpcChain = regularRpcEndpoints.map((regularRpcEndpoint) => resolveReadWriteRpcCallers(regularRpcEndpoint));
    const multicastRpcs = new Set(multicastRpcUrls.map((multicastRpcUrl) => createUrlRpcCaller(multicastRpcUrl)));
    return { readWriteRpcChain, multicastRpcs };
}
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
export function createResilientRpc(rpcCallerChain) {
    let resilientRpcCaller = new TerminatingRpcCaller();
    for (const readWriteRpcCallers of rpcCallerChain.readWriteRpcChain.reverse()) {
        const linkRpcCaller = readWriteRpcCallers.dedicatedWriteRpcCaller !== undefined
            ? withDedicatedWrite(readWriteRpcCallers.regularRpcCaller, readWriteRpcCallers.dedicatedWriteRpcCaller)
            : readWriteRpcCallers.regularRpcCaller;
        // TODO(rpc-fallbacks): we could achieve a "cooldown period for extended downtime" here via wrapping each link in a circuit-breaker decorator:
        resilientRpcCaller = new FallbackRpcCaller(linkRpcCaller, resilientRpcCaller);
    }
    if (rpcCallerChain.multicastRpcs.size > 0) {
        resilientRpcCaller = new MethodRoutingRpcTransport(resilientRpcCaller, MULTICASTED_METHOD_NAMES, new MulticastingRpcTransport(rpcCallerChain.multicastRpcs, resilientRpcCaller));
    }
    return asRpc(resilientRpcCaller);
}
/**
 * Creates a "plain" RPC from a single URL.
 */
export function createDefaultRpc(url) {
    return asRpc(createUrlRpcCaller(url));
}
function asRpc(rpcCaller) {
    const api = createSolanaRpcApi({
        ...DEFAULT_RPC_CONFIG,
        defaultCommitment: READ_CONNECTION_FINALITY,
    });
    const transport = asRpcTransport(rpcCaller);
    return createRpc({ api, transport });
}
function asRpcTransport(rpcCaller) {
    // Despite `ReturnType<RpcTransport>` working fine in all other contexts, it loses its type-inferring powers when
    // `RpcCaller.call()` is referenced directly (due to not seeing the actual type parameter), forcing this ugly cast:
    return rpcCaller.call.bind(rpcCaller);
}
function resolveReadWriteRpcCallers(rpcEndpoint) {
    return {
        regularRpcCaller: createUrlRpcCaller(rpcEndpoint.url),
        dedicatedWriteRpcCaller: rpcEndpoint.dedicatedWriteUrl !== undefined ? createUrlRpcCaller(rpcEndpoint.dedicatedWriteUrl) : undefined,
    };
}
// only exposed for tests:
export function withDedicatedWrite(regularRpcCaller, dedicatedWriteRpcCaller) {
    return new MethodRoutingRpcTransport(regularRpcCaller, WRITING_METHOD_NAMES, dedicatedWriteRpcCaller);
}
function createUrlRpcCaller({ url, representation }) {
    return new LabelledRpcCaller(createDefaultRpcTransport({ url }), representation);
}
class FallbackRpcCaller {
    primary;
    fallback;
    constructor(primary, fallback) {
        this.primary = primary;
        this.fallback = fallback;
    }
    async call(...args) {
        try {
            return FallbackRpcCaller.checkResponseSuccessful(await this.primary.call(...args));
        }
        catch (e) {
            logger.warn(`Calling RPC ${this.primary} failed; proceeding to its fallback:`, e);
            return this.fallback.call(...args);
        }
    }
    static checkResponseSuccessful(response) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const error = response.error;
        if (error !== undefined) {
            throw new Error(`Error response received: ${JSON.stringify(error)}`);
        }
        return response;
    }
}
class MethodRoutingRpcTransport {
    defaultRpcCaller;
    routedMethodNames;
    routedRpcCaller;
    constructor(defaultRpcCaller, routedMethodNames, routedRpcCaller) {
        this.defaultRpcCaller = defaultRpcCaller;
        this.routedMethodNames = new Set(routedMethodNames);
        this.routedRpcCaller = routedRpcCaller;
    }
    call(...args) {
        const methodName = MethodRoutingRpcTransport.resolveMethodName(...args);
        if (this.routedMethodNames.has(methodName)) {
            return this.routedRpcCaller.call(...args);
        }
        return this.defaultRpcCaller.call(...args);
    }
    static resolveMethodName(...args) {
        // Please excuse the ugly introspection, needed only because of the RpcTransport using a private type:
        return args[0].payload.method;
    }
}
class MulticastingRpcTransport {
    multicastRpcCallers;
    finalRpcCaller;
    constructor(multicastRpcCallers, finalRpcCaller) {
        this.multicastRpcCallers = new Set(multicastRpcCallers);
        this.finalRpcCaller = finalRpcCaller;
    }
    call(...args) {
        for (const multicastRpcCaller of this.multicastRpcCallers) {
            // Please note the lack of `await` below. This is intended, since we want to fire and forget to all multicast
            // RPCs. This works in JavaScript (in contrast to e.g. Rust), because `Promise`s here start work when constructed,
            // not when "polled".
            multicastRpcCaller
                .call(...args)
                .catch((e) => logger.warn(`Calling multicast RPC ${multicastRpcCaller} failed; ignoring it`, e));
        }
        return this.finalRpcCaller.call(...args);
    }
}
class TerminatingRpcCaller {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    call(...args) {
        throw new Error('All RPCs failed');
    }
}
// only exposed for tests:
export class LabelledRpcCaller {
    transport;
    label;
    constructor(transport, label) {
        this.transport = transport;
        this.label = label;
    }
    call(...args) {
        return this.transport(...args);
    }
    toString() {
        return this.label;
    }
}
//# sourceMappingURL=rpcTransportInfra.js.map