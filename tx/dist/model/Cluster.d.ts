export declare const EligibleClusters: readonly ["localnet", "devnet", "mainnet-beta"];
export type Cluster = (typeof EligibleClusters)[number];
/**
 * A URL of an RPC - typically containing secret, authentication-related parts.
 *
 * Logging such URL needs some special care: either by heuristically "sanitizing" the URL, or by giving it an explicit
 * custom name - the {@link #toString()} method of this class is **safe** in this regard.
 */
export declare class RpcUrl {
    readonly url: string;
    representation: string;
    constructor(url: string);
    withCustomName(name: string): RpcUrl;
    toString(): string;
    private static checkValid;
}
/**
 * Configuration of a general-purpose RPC.
 */
export declare class RpcEndpointConfig {
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
    constructor(url: RpcUrl);
    withDedicatedWriteUrl(dedicatedWriteUrl: RpcUrl | undefined): RpcEndpointConfig;
    withFeePercentileSupport(feePercentileSupport: FeePercentileSupport): RpcEndpointConfig;
}
export declare enum FeePercentileSupport {
    TritonStyle = "TritonStyle",// i.e. adding percentile param to the existing `getRecentPrioritizationFees()` RPC method
    HeliusStyle = "HeliusStyle",// i.e. using a newly-introduced `getPriorityFeeEstimate()` RPC method
    None = "None"
}
export declare class RpcEndpointsConfig {
    private readonly primary;
    private readonly fallbacks;
    constructor(primary: RpcEndpointConfig, ...fallbacks: RpcEndpointConfig[]);
    readUrl(): string;
    allRpcs(): RpcEndpointConfig[];
    toString(): string;
}
//# sourceMappingURL=Cluster.d.ts.map