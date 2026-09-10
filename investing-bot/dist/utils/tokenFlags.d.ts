import { Address } from '@solana/kit';
export declare const KAMINO_TOKEN_FLAGS_URL = "https://tokens.kamino.finance/tokens-flags.json";
/**
 * What Kamino's token feed says a token is. This is the authoritative answer to "is this a
 * stablecoin" — the bot must not infer it from symbols or prices of its own accord.
 */
export interface TokenFlags {
    readonly symbol: string;
    readonly isStablecoin: boolean;
    readonly isLst: boolean;
}
/**
 * Fetch the Kamino token flags feed and reduce it to the tags the danger triggers act on.
 *
 * Fails closed: a transport error, a malformed body, or a body that yields zero usable entries all
 * throw rather than returning an empty map, because an empty map is indistinguishable from "nothing
 * is a stablecoin" and would silently disable every peg check.
 */
export declare function fetchTokenFlags(): Promise<Map<Address, TokenFlags>>;
//# sourceMappingURL=tokenFlags.d.ts.map