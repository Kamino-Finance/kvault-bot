import { hideSensitiveRpcCredentials } from '../ConnectionPool.js';

export const EligibleClusters = ['localnet', 'devnet', 'mainnet-beta'] as const;
export type Cluster = (typeof EligibleClusters)[number];

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

  private static checkValid(url: string): void {
    let newUrl;
    try {
      newUrl = new URL(url);
    } catch (err) {
      throw new Error(`Not a valid URL: ${url}`, err);
    }
    if (!['http:', 'https:'].includes(newUrl.protocol)) {
      throw new Error(`Expected RPC to have http(s) URL: ${url}`);
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
