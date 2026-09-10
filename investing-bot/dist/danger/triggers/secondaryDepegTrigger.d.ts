import { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import { KaminoReserve } from '@kamino-finance/klend-sdk';
import { TokenFlags } from '../../utils/tokenFlags.js';
import { DangerTrigger, TriggerContext, TriggerResult } from '../dangerTypes.js';
/**
 * Symbols carrying Kamino's `stablecoin` tag that are NOT worth one US dollar, so the $1 check must
 * not be applied to them. Two kinds:
 *
 *  - non-USD currencies: stable against EUR/GBP/CHF, so a $1 floor would read as a permanent 15-30%
 *    depeg and pull out on every pass forever;
 *  - yield-bearing or redemption-value wrappers: designed to drift above $1 as they accrue, so a
 *    two-sided $1 band fires on completely normal behaviour.
 *
 * Excluded tokens still get `oracle-divergence`; they only lose the peg-value check, and each one is
 * logged so the gap is visible rather than silent. Matched case-insensitively on the feed's symbol.
 */
export declare const NON_USD_STABLECOIN_SYMBOLS: ReadonlySet<string>;
/** What a token's secondary-market price is expected to hold against. */
export type PegTarget = {
    readonly kind: 'usd';
    readonly priceUsd: number;
} | {
    readonly kind: 'token';
    readonly referenceMint: Address;
    readonly minRatio: number;
};
/**
 * Slippery slope trigger: detects a token trading away from its peg.
 *
 * Which tokens have a peg is not guessed — it comes from Kamino's token-flags feed in the trigger
 * context (`tokenFlags`): the `stablecoin` tag means a $1 peg (minus the documented non-USD and
 * yield-bearing exclusions) and the `lst` tag means par with SOL. Tokens with neither tag are scored
 * 1.0; an explicit peg-target override can be supplied for tests and for one-off pegs.
 *
 * A $1 stablecoin is checked against BOTH price sources — the KSwap secondary-market price and the
 * reserve's on-chain oracle — and scored on whichever diverges further from $1, in either direction.
 * That covers the depeg `oracle-divergence` cannot see: when a peg genuinely breaks, the oracle
 * tracks the market down with it, so the two agree while both sit well off $1.
 *
 * An LST is checked one-sided against par with SOL, since trading above par is the normal state of a
 * token that accrues staking rewards.
 *
 * Not catastrophic: a depeg can recover, so it drives an emergency pull-out and cooldown rather than
 * a permanent blacklist. Reserve-intrinsic — the same depeg applies to every vault holding the token.
 */
export declare class SecondaryDepegTrigger implements DangerTrigger {
    readonly name = "secondary-depeg";
    private readonly pegTargetOverrides;
    private readonly reportedUnpegged;
    private readonly reportedImplausible;
    constructor(pegTargetOverrides?: ReadonlyMap<Address, PegTarget>);
    /**
     * Reference mints this trigger needs priced on top of the universe's own reserve mints — only for
     * the tokens actually present that are quoted against another token, so an unrelated universe never
     * widens the price fetch (whose strict mode aborts the danger pass when any requested mint is
     * unpriced).
     */
    priceReferenceMints(reserveMints: Address[], tokenFlags?: ReadonlyMap<Address, TokenFlags>): Address[];
    /**
     * The peg a mint is held to: an explicit override first, then the feed's tags. Returns undefined
     * when the token has no known peg, which scores 1.0 (this trigger simply does not apply).
     */
    private resolvePegTarget;
    check(_rpc: Rpc<SolanaRpcApi>, reserveAddress: Address, reserve: KaminoReserve, context: TriggerContext): Promise<TriggerResult>;
    /**
     * Two-sided: a hard $1 peg is symmetric, and the worse of the two independent sources wins. The
     * oracle leg is what makes a market-and-oracle-agree depeg visible, since agreement at $0.92 leaves
     * `oracle-divergence` reporting a perfectly healthy 0%.
     */
    private measureDollarPeg;
    /**
     * One-sided: only a discount below the reference floor is a danger signal. A premium is not a loss
     * for a depositor holding the token, and is the normal state of a yield-accruing LST.
     */
    private measureTokenPeg;
    /** Log once per mint that this trigger is not watching it, and why. */
    private reportUnpegged;
    /**
     * A peg target should be the same order of magnitude as what the token actually trades at. Outside
     * a 0.5x-2x band the classification is almost certainly wrong — a token that is not really worth
     * the peg value. Reported once per mint, and deliberately advisory: the score is never relaxed on
     * the low side, because an implausibly low observation is indistinguishable from a total depeg and
     * treating it as a config error would fail open on the exact event this trigger exists to catch.
     */
    private reportImplausiblePeg;
}
//# sourceMappingURL=secondaryDepegTrigger.d.ts.map