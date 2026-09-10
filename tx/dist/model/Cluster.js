import { hideSensitiveRpcCredentials } from '../ConnectionPool.js';
export const EligibleClusters = ['localnet', 'devnet', 'mainnet-beta'];
/**
 * A URL of an RPC - typically containing secret, authentication-related parts.
 *
 * Logging such URL needs some special care: either by heuristically "sanitizing" the URL, or by giving it an explicit
 * custom name - the {@link #toString()} method of this class is **safe** in this regard.
 */
export class RpcUrl {
    url;
    representation;
    constructor(url) {
        RpcUrl.checkValid(url);
        this.url = url;
        this.representation = hideSensitiveRpcCredentials(this.url);
    }
    withCustomName(name) {
        this.representation = name;
        return this;
    }
    toString() {
        return this.representation;
    }
    static checkValid(url) {
        let newUrl;
        try {
            newUrl = new URL(url);
        }
        catch (err) {
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
    url;
    /**
     * The URL to use for writing (if this RPC supports a separate one).
     */
    dedicatedWriteUrl;
    /**
     * What type of percentile-based fee query is supported by this RPC (possibly none).
     */
    feePercentileSupport;
    constructor(url) {
        this.url = url;
        this.dedicatedWriteUrl = undefined;
        this.feePercentileSupport = FeePercentileSupport.None;
    }
    withDedicatedWriteUrl(dedicatedWriteUrl) {
        this.dedicatedWriteUrl = dedicatedWriteUrl;
        return this;
    }
    withFeePercentileSupport(feePercentileSupport) {
        this.feePercentileSupport = feePercentileSupport;
        return this;
    }
}
export var FeePercentileSupport;
(function (FeePercentileSupport) {
    FeePercentileSupport["TritonStyle"] = "TritonStyle";
    FeePercentileSupport["HeliusStyle"] = "HeliusStyle";
    FeePercentileSupport["None"] = "None";
})(FeePercentileSupport || (FeePercentileSupport = {}));
export class RpcEndpointsConfig {
    primary;
    fallbacks;
    constructor(primary, ...fallbacks) {
        this.primary = primary;
        this.fallbacks = fallbacks;
    }
    // Should only be used by legacy code:
    readUrl() {
        return this.primary.url.url;
    }
    allRpcs() {
        return [this.primary, ...this.fallbacks];
    }
    toString() {
        return this.allRpcs()
            .map((rpc) => rpc.url)
            .join(' -> ');
    }
}
//# sourceMappingURL=Cluster.js.map