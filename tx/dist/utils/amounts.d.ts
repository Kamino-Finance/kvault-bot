import { Decimal } from 'decimal.js';
/**
 * A factor to multiply lamports by, in order to obtain micro-lamports.
 *
 * Note that this value is independent of the particular token's decimal factor.
 */
export declare const MICRO_DECIMAL_FACTOR = 1000000;
/**
 * Minimal information needed to unambiguously express a "currency" of a {@link TokenAmount}.
 */
export declare class TokenSummary {
    /**
     * The token's symbol.
     */
    readonly symbol: string;
    /**
     * The number of decimal digits for the token's lamports.
     */
    readonly decimals: number;
    constructor(symbol: string, decimals: number);
    /**
     * Creates a {@link TokenAmount} of this token, from a number of **tokens** (as opposed to {@link #lamports()}).
     */
    amount(amount: Decimal.Value): TokenAmount;
    /**
     * Creates a {@link TokenAmount} of this token, from a number of lamports.
     */
    lamports(amountLamports: Decimal.Value): TokenAmount;
    /**
     * Creates a {@link TokenAmount} of this token, from a number of micro-lamports.
     */
    microLamports(amountMicroLamports: Decimal.Value): TokenAmount;
    /**
     * The factor to multiply the {@link TokenAmount#amount} by, in order to obtain a value in lamports.
     */
    decimalFactor(): Decimal;
    toString(): string;
}
/**
 * A well-known native SOL token summary.
 */
export declare const SOL: TokenSummary;
/**
 * Some amount of a specific token.
 */
export declare class TokenAmount {
    /**
     * The amount of {@link #token} (in regular units, i.e. not lamports).
     */
    readonly amount: Decimal;
    /**
     * The "currency" of this amount.
     */
    readonly token: TokenSummary;
    constructor(amount: Decimal, token: TokenSummary);
    /**
     * The amount of {@link #token}, in lamports.
     */
    lamports(): Decimal;
    /**
     * The amount of {@link #token}, in micro-lamports.
     */
    microLamports(): Decimal;
    toString(): string;
}
//# sourceMappingURL=amounts.d.ts.map