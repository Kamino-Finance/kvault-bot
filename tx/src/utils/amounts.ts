import { Decimal } from 'decimal.js';

/**
 * A factor to multiply lamports by, in order to obtain micro-lamports.
 *
 * Note that this value is independent of the particular token's decimal factor.
 */
export const MICRO_DECIMAL_FACTOR = 1_000_000;

/**
 * Minimal information needed to unambiguously express a "currency" of a {@link TokenAmount}.
 */
export class TokenSummary {
  /**
   * The token's symbol.
   */
  readonly symbol: string;

  /**
   * The number of decimal digits for the token's lamports.
   */
  readonly decimals: number;

  constructor(symbol: string, decimals: number) {
    this.symbol = symbol;
    this.decimals = decimals;
  }

  /**
   * Creates a {@link TokenAmount} of this token, from a number of **tokens** (as opposed to {@link #lamports()}).
   */
  amount(amount: Decimal.Value): TokenAmount {
    return new TokenAmount(new Decimal(amount), this);
  }

  /**
   * Creates a {@link TokenAmount} of this token, from a number of lamports.
   */
  lamports(amountLamports: Decimal.Value): TokenAmount {
    return this.amount(new Decimal(amountLamports).div(this.decimalFactor()));
  }

  /**
   * Creates a {@link TokenAmount} of this token, from a number of micro-lamports.
   */
  microLamports(amountMicroLamports: Decimal.Value): TokenAmount {
    return this.lamports(new Decimal(amountMicroLamports).div(MICRO_DECIMAL_FACTOR));
  }

  /**
   * The factor to multiply the {@link TokenAmount#amount} by, in order to obtain a value in lamports.
   */
  decimalFactor(): Decimal {
    return new Decimal(10).pow(this.decimals);
  }

  toString(): string {
    return this.symbol;
  }
}

/**
 * A well-known native SOL token summary.
 */
export const SOL = new TokenSummary('SOL', 9);

/**
 * Some amount of a specific token.
 */
export class TokenAmount {
  /**
   * The amount of {@link #token} (in regular units, i.e. not lamports).
   */
  readonly amount: Decimal;

  /**
   * The "currency" of this amount.
   */
  readonly token: TokenSummary;

  constructor(amount: Decimal, token: TokenSummary) {
    this.amount = amount;
    this.token = token;
  }

  /**
   * The amount of {@link #token}, in lamports.
   */
  lamports(): Decimal {
    return this.amount.mul(this.token.decimalFactor());
  }

  /**
   * The amount of {@link #token}, in micro-lamports.
   */
  microLamports(): Decimal {
    return this.lamports().mul(MICRO_DECIMAL_FACTOR);
  }

  toString(): string {
    return `${this.amount} ${this.token}`;
  }
}
