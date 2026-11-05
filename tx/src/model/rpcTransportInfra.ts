import {
  createDefaultRpcTransport,
  SendTransactionApi,
  GetSlotApi,
  RpcTransport,
  GetEpochInfoApi,
  GetLatestBlockhashApi,
  GetTransactionApi,
  GetSignatureStatusesApi,
  SimulateTransactionApi,
  SolanaRpcApi,
  createRpc,
  createSolanaRpcApi,
  DEFAULT_RPC_CONFIG,
  Rpc,
} from '@solana/kit';
import { logger } from 'kvaults-investing-bot-logger';
import { READ_CONNECTION_FINALITY } from '../ConnectionPool.js';
import { RpcEndpointConfig, RpcUrl } from './Cluster.js';

// Note: the method name consts below are defined in this convoluted way only to ensure no typos.

/**
 * Names of Solana RPC methods that should be multicasted to all configured multicast RPCs.
 */
const MULTICASTED_METHOD_NAMES: string[] = ['sendTransaction' as const satisfies keyof SendTransactionApi];

/**
 * Names of Solana RPC methods that are related to "writing" operations.
 */
const WRITING_METHOD_NAMES: string[] = [
  // The submission itself goes to the dedicated send endpoint too, next to the blockhash and simulation
  // reads it depends on; otherwise a configured send RPC is bypassed and the read node's slot may lag.
  'sendTransaction' as const satisfies keyof SendTransactionApi,
  'getEpochInfo' as const satisfies keyof GetEpochInfoApi,
  'getLatestBlockhash' as const satisfies keyof GetLatestBlockhashApi,
  'getTransaction' as const satisfies keyof GetTransactionApi,
  'getSignatureStatuses' as const satisfies keyof GetSignatureStatusesApi,
  'getSlot' as const satisfies keyof GetSlotApi,
  'simulateTransaction' as const satisfies keyof SimulateTransactionApi,
];

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
export function resolveRpcCallerChain(
  regularRpcEndpoints: RpcEndpointConfig[],
  multicastRpcUrls: RpcUrl[],
  requestTimeoutMs: number = DEFAULT_RPC_REQUEST_TIMEOUT_MS
): RpcCallerChain {
  const readWriteRpcChain = regularRpcEndpoints.map((regularRpcEndpoint) =>
    resolveReadWriteRpcCallers(regularRpcEndpoint, requestTimeoutMs)
  );
  const multicastRpcs = new Set(
    multicastRpcUrls.map((multicastRpcUrl) => createUrlRpcCaller(multicastRpcUrl, requestTimeoutMs))
  );
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
export function createResilientRpc<TExtraMethods>(rpcCallerChain: RpcCallerChain): Rpc<RpcMethodTypes & TExtraMethods> {
  let resilientRpcCaller: RpcCaller = new TerminatingRpcCaller();
  for (const readWriteRpcCallers of [...rpcCallerChain.readWriteRpcChain].reverse()) {
    const linkRpcCaller =
      readWriteRpcCallers.dedicatedWriteRpcCaller !== undefined
        ? withDedicatedWrite(readWriteRpcCallers.regularRpcCaller, readWriteRpcCallers.dedicatedWriteRpcCaller)
        : readWriteRpcCallers.regularRpcCaller;
    resilientRpcCaller = new FallbackRpcCaller(linkRpcCaller, resilientRpcCaller);
  }
  if (rpcCallerChain.multicastRpcs.size > 0) {
    resilientRpcCaller = new MethodRoutingRpcTransport(
      resilientRpcCaller,
      MULTICASTED_METHOD_NAMES,
      new MulticastingRpcTransport(rpcCallerChain.multicastRpcs, resilientRpcCaller)
    );
  }
  return asRpc(resilientRpcCaller);
}

/**
 * Creates a "plain" RPC from a single URL.
 */
export function createDefaultRpc<TExtraMethods>(
  url: RpcUrl,
  requestTimeoutMs: number = DEFAULT_RPC_REQUEST_TIMEOUT_MS
): Rpc<RpcMethodTypes & TExtraMethods> {
  return asRpc(createUrlRpcCaller(url, requestTimeoutMs));
}

// only exposed for tests:
export type RpcMethodTypes = SolanaRpcApi;

function asRpc<TExtraMethods>(rpcCaller: RpcCaller): Rpc<RpcMethodTypes & TExtraMethods> {
  const api = createSolanaRpcApi<RpcMethodTypes & TExtraMethods>({
    ...DEFAULT_RPC_CONFIG,
    defaultCommitment: READ_CONNECTION_FINALITY,
  });
  const transport = asRpcTransport(rpcCaller);
  return createRpc({ api, transport });
}

function asRpcTransport(rpcCaller: RpcCaller): RpcTransport {
  // Despite `ReturnType<RpcTransport>` working fine in all other contexts, it loses its type-inferring powers when
  // `RpcCaller.call()` is referenced directly (due to not seeing the actual type parameter), forcing this ugly cast:
  return rpcCaller.call.bind(rpcCaller) as RpcTransport;
}

function resolveReadWriteRpcCallers(rpcEndpoint: RpcEndpointConfig, requestTimeoutMs: number): ReadWriteRpcCallers {
  return {
    regularRpcCaller: createUrlRpcCaller(rpcEndpoint.url, requestTimeoutMs),
    dedicatedWriteRpcCaller:
      rpcEndpoint.dedicatedWriteUrl !== undefined
        ? createUrlRpcCaller(rpcEndpoint.dedicatedWriteUrl, requestTimeoutMs)
        : undefined,
  };
}

// only exposed for tests:
export function withDedicatedWrite(regularRpcCaller: RpcCaller, dedicatedWriteRpcCaller: RpcCaller): RpcCaller {
  return new MethodRoutingRpcTransport(regularRpcCaller, WRITING_METHOD_NAMES, dedicatedWriteRpcCaller);
}

/** An RPC call with no answer within this window fails, so a stalled socket cannot hold a loop. */
export const DEFAULT_RPC_REQUEST_TIMEOUT_MS = 2 * 60_000;

function createUrlRpcCaller({ url, representation }: RpcUrl, requestTimeoutMs: number): RpcCaller {
  return new LabelledRpcCaller(
    withRequestTimeout(createDefaultRpcTransport({ url }), requestTimeoutMs),
    representation
  );
}

/** Bounds every call through the transport with a deadline, combined with any signal the caller passes. */
function withRequestTimeout(transport: RpcTransport, requestTimeoutMs: number): RpcTransport {
  return ((config: Parameters<RpcTransport>[0]) => {
    const deadline = AbortSignal.timeout(requestTimeoutMs);
    const signal = config.signal ? AbortSignal.any([config.signal, deadline]) : deadline;
    return transport({ ...config, signal });
  }) as RpcTransport;
}

/** All configured RPC endpoints failed for one request. */
export class RpcRequestError extends Error {
  constructor(cause: unknown) {
    super(`All RPCs failed; last error: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'RpcRequestError';
  }
}

class FallbackRpcCaller implements RpcCaller {
  private readonly primary: RpcCaller;
  private readonly fallback: RpcCaller;

  constructor(primary: RpcCaller, fallback: RpcCaller) {
    this.primary = primary;
    this.fallback = fallback;
  }

  async call(...args: Parameters<RpcTransport>): ReturnType<RpcTransport> {
    try {
      return FallbackRpcCaller.checkResponseSuccessful(await this.primary.call(...args));
    } catch (e) {
      logger.warn(`Calling RPC ${this.primary} failed; proceeding to its fallback:`, e);
      if (this.fallback instanceof TerminatingRpcCaller) {
        // The caller gets the last endpoint's error, not only that every endpoint failed.
        throw new RpcRequestError(e);
      }
      return this.fallback.call(...args);
    }
  }

  private static checkResponseSuccessful<TResponse>(response: TResponse): TResponse {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const error = (response as any).error;
    if (error !== undefined) {
      throw new Error(`Error response received: ${JSON.stringify(error)}`);
    }
    return response;
  }
}

class MethodRoutingRpcTransport implements RpcCaller {
  private readonly defaultRpcCaller: RpcCaller;
  private readonly routedMethodNames: Set<string>;
  private readonly routedRpcCaller: RpcCaller;

  constructor(defaultRpcCaller: RpcCaller, routedMethodNames: Iterable<string>, routedRpcCaller: RpcCaller) {
    this.defaultRpcCaller = defaultRpcCaller;
    this.routedMethodNames = new Set(routedMethodNames);
    this.routedRpcCaller = routedRpcCaller;
  }

  /** Names both callers, for the fallback warning that names a failed caller. */
  toString(): string {
    return `${this.defaultRpcCaller} (${[...this.routedMethodNames].join(', ')} via ${this.routedRpcCaller})`;
  }

  call(...args: Parameters<RpcTransport>): ReturnType<RpcTransport> {
    const methodName = MethodRoutingRpcTransport.resolveMethodName(...args);
    if (this.routedMethodNames.has(methodName)) {
      return this.routedRpcCaller.call(...args);
    }
    return this.defaultRpcCaller.call(...args);
  }

  private static resolveMethodName(...args: Parameters<RpcTransport>): string {
    // Please excuse the ugly introspection, needed only because of the RpcTransport using a private type:
    return (args[0].payload as { method: string }).method;
  }
}

class MulticastingRpcTransport implements RpcCaller {
  private readonly multicastRpcCallers: Set<RpcCaller>;
  private readonly finalRpcCaller: RpcCaller;

  constructor(multicastRpcCallers: Iterable<RpcCaller>, finalRpcCaller: RpcCaller) {
    this.multicastRpcCallers = new Set(multicastRpcCallers);
    this.finalRpcCaller = finalRpcCaller;
  }

  call(...args: Parameters<RpcTransport>): ReturnType<RpcTransport> {
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

class TerminatingRpcCaller implements RpcCaller {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  call(...args: Parameters<RpcTransport>): ReturnType<RpcTransport> {
    throw new Error('All RPCs failed');
  }
}

// only exposed for tests:
export class LabelledRpcCaller implements RpcCaller {
  private readonly transport: RpcTransport;
  private readonly label: string;

  constructor(transport: RpcTransport, label: string) {
    this.transport = transport;
    this.label = label;
  }

  call(...args: Parameters<RpcTransport>): ReturnType<RpcTransport> {
    return this.transport(...args);
  }

  toString(): string {
    return this.label;
  }
}
