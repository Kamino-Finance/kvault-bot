import { hideSensitiveRpcCredentials } from '../ConnectionPool.js';

export const EligibleClusters = ['localnet', 'devnet', 'mainnet-beta'] as const;
export type Cluster = (typeof EligibleClusters)[number];

/** Narrows an environment value to a supported cluster, or throws naming the supported ones. */
export function parseCluster(value: string): Cluster {
  if (!isCluster(value)) {
    throw new Error(`CLUSTER "${value}" is not supported; expected one of ${EligibleClusters.join(', ')}`);
  }
  return value;
}

function isCluster(value: string): value is Cluster {
  return (EligibleClusters as readonly string[]).includes(value);
}

/**
 * The WebSocket URL of an HTTP RPC endpoint, for when WS_ENDPOINT is not configured. The kit subscriptions
 * client rejects an http(s) scheme, which would fail every confirmation after the transaction was sent.
 */
export function deriveWebSocketUrl(httpUrl: string): string {
  const url = new URL(httpUrl);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.port !== '') {
    // A local validator serves pubsub on the RPC port plus one (8899 -> 8900). On any other host an
    // explicit port is ambiguous, since hosted providers serve WebSocket on the same port: ask for it.
    if (!isLoopbackHost(url.hostname)) {
      throw new Error(
        `WS_ENDPOINT must be set: the WebSocket port of ${hideSensitiveRpcCredentials(httpUrl)} cannot be derived from an explicit port on a remote host`
      );
    }
    url.port = String(Number(url.port) + 1);
  }
  return url.toString();
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/** The WebSocket endpoint to use: the configured one unless blank, else derived from the read RPC URL. */
export function resolveWebSocketEndpoint(configured: string | undefined, readUrl: string): string {
  const trimmed = configured?.trim();
  return trimmed || deriveWebSocketUrl(readUrl);
}

/**
 * A URL of an RPC - typically containing secret, authentication-related parts.
 *
 * Logging such URL needs some special care: either by heuristically "sanitizing" the URL, or by giving it an explicit
 * custom name - the {@link #toString()} method of this class is **safe** in this regard.
 */
export class RpcUrl {
  readonly url: string;

  representation: string;

  constructor(url: string) {
    RpcUrl.checkValid(url);
    this.url = url;
    this.representation = hideSensitiveRpcCredentials(this.url);
  }

  withCustomName(name: string): RpcUrl {
    this.representation = name;
    return this;
  }

  toString(): string {
    return this.representation;
  }

  // The URL can carry an access token, so an error names it only in its sanitized form. The URL parser's own error keeps
  // the input, so it is not attached as the cause.
  private static checkValid(url: string): void {
    let newUrl;
    try {
      newUrl = new URL(url);
    } catch {
      throw new Error(`Not a valid URL: ${hideSensitiveRpcCredentials(url)}`);
    }
    if (!['http:', 'https:'].includes(newUrl.protocol)) {
      throw new Error(`Expected RPC to have http(s) URL: ${hideSensitiveRpcCredentials(url)}`);
    }
  }
}

/**
 * Configuration of a general-purpose RPC.
 */
export class RpcEndpointConfig {
  /**
   * The URL to use.
   *
   * Note: if {@link dedicatedWriteUrl} is set, the one here will only be used for reading.
   */
  readonly url: RpcUrl;

  /**
   * The URL to use for writing (if this RPC supports a separate one).
   */
  dedicatedWriteUrl: RpcUrl | undefined;

  /**
   * What type of percentile-based fee query is supported by this RPC (possibly none).
   */
  feePercentileSupport: FeePercentileSupport;

  constructor(url: RpcUrl) {
    this.url = url;
    this.dedicatedWriteUrl = undefined;
    this.feePercentileSupport = FeePercentileSupport.None;
  }

  withDedicatedWriteUrl(dedicatedWriteUrl: RpcUrl | undefined): RpcEndpointConfig {
    this.dedicatedWriteUrl = dedicatedWriteUrl;
    return this;
  }

  withFeePercentileSupport(feePercentileSupport: FeePercentileSupport): RpcEndpointConfig {
    this.feePercentileSupport = feePercentileSupport;
    return this;
  }
}

export enum FeePercentileSupport {
  TritonStyle = 'TritonStyle', // i.e. adding percentile param to the existing `getRecentPrioritizationFees()` RPC method
  HeliusStyle = 'HeliusStyle', // i.e. using a newly-introduced `getPriorityFeeEstimate()` RPC method
  None = 'None',
}

export class RpcEndpointsConfig {
  private readonly primary: RpcEndpointConfig;
  private readonly fallbacks: RpcEndpointConfig[];

  constructor(primary: RpcEndpointConfig, ...fallbacks: RpcEndpointConfig[]) {
    this.primary = primary;
    this.fallbacks = fallbacks;
  }

  // Should only be used by legacy code:
  readUrl(): string {
    return this.primary.url.url;
  }

  allRpcs(): RpcEndpointConfig[] {
    return [this.primary, ...this.fallbacks];
  }

  toString(): string {
    return this.allRpcs()
      .map((rpc) => rpc.url)
      .join(' -> ');
  }
}
