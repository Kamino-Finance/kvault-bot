import { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import { KaminoReserve } from '@kamino-finance/klend-sdk';
import { Decimal } from 'decimal.js';
import { logger } from 'kvaults-investing-bot-logger';
import { WRAPPED_SOL_MINT } from 'kvaults-investing-bot-tx/instruction';
import { TokenFlags } from '../../utils/tokenFlags.js';
import { DangerTrigger, DangerTriggerUnavailableError, TriggerContext, TriggerResult } from '../dangerTypes.js';

const FULL_BPS = 10_000;

// A hard $1 stablecoin should track its peg tightly from BOTH price sources. Below the safe band it
// scores 1.0; the score then decays to 0 at the max band, which puts the pull-out point at ~88 bps
// for PARANOID (0.5), ~124 bps for SENSIBLE (0.3) and ~172 bps for YOLO (0.1) — i.e. roughly the
// 100 bps target, tightening or loosening with the configured risk appetite.
const STABLE_SAFE_DIVERGENCE_BPS = 50;
const STABLE_MAX_DIVERGENCE_BPS = 200;

// An LST is redeemable for at least the SOL that minted it and its redemption rate only grows, so
// par is a floor rather than a peg: the band is wide and one-sided.
const LST_SAFE_DISCOUNT_BPS = 100;
const LST_MAX_DISCOUNT_BPS = 1_000;

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
export const NON_USD_STABLECOIN_SYMBOLS: ReadonlySet<string> = new Set(
  [
    // non-USD currencies
    'EURC',
    'EURCV',
    'EUROE',
    'EUROP',
    'vEUR',
    'VGBP',
    'vCHF',
    // yield-bearing / redemption-value wrappers
    'CASH',
    'ONyc',
    'PRIME',
    'USD*',
    'USD+',
    'USDu',
    'USX',
    'eUSX',
    'YU',
    'deJAAA',
    'deJTRSY',
    'hyUSD',
    'mPST',
    'rUSD',
    'sUSD',
    'sUSDu',
    'syrupUSDC',
    'wYLDS',
    'wsrUSD',
  ].map((symbol) => symbol.toLowerCase())
);

/** What a token's secondary-market price is expected to hold against. */
export type PegTarget =
  | { readonly kind: 'usd'; readonly priceUsd: number }
  | { readonly kind: 'token'; readonly referenceMint: Address; readonly minRatio: number };

/** Every hard $1 stablecoin shares this target; only the tag decides which tokens get it. */
const DOLLAR_PEG: PegTarget = { kind: 'usd', priceUsd: 1.0 };

/** Every LST shares this target: worth at least the SOL backing it. */
const SOL_PAR_PEG: PegTarget = { kind: 'token', referenceMint: WRAPPED_SOL_MINT, minRatio: 1.0 };

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
export class SecondaryDepegTrigger implements DangerTrigger {
  readonly name = 'secondary-depeg';
  private readonly pegTargetOverrides: ReadonlyMap<Address, PegTarget>;
  // Mints already reported as unmonitored / misclassified, so each gap is logged once rather than
  // every pass. Diagnostics only — never affects a score.
  private readonly reportedUnpegged = new Set<string>();
  private readonly reportedImplausible = new Set<string>();

  constructor(pegTargetOverrides: ReadonlyMap<Address, PegTarget> = new Map()) {
    this.pegTargetOverrides = pegTargetOverrides;
  }

  /**
   * Reference mints this trigger needs priced on top of the universe's own reserve mints — only for
   * the tokens actually present that are quoted against another token, so an unrelated universe never
   * widens the price fetch (whose strict mode aborts the danger pass when any requested mint is
   * unpriced).
   */
  priceReferenceMints(reserveMints: Address[], tokenFlags?: ReadonlyMap<Address, TokenFlags>): Address[] {
    const referenceMints = new Set<Address>();
    for (const mint of reserveMints) {
      const peg = this.resolvePegTarget(mint, tokenFlags);
      if (peg?.kind === 'token') {
        referenceMints.add(peg.referenceMint);
      }
    }
    return Array.from(referenceMints);
  }

  /**
   * The peg a mint is held to: an explicit override first, then the feed's tags. Returns undefined
   * when the token has no known peg, which scores 1.0 (this trigger simply does not apply).
   */
  private resolvePegTarget(mint: Address, tokenFlags?: ReadonlyMap<Address, TokenFlags>): PegTarget | undefined {
    const override = this.pegTargetOverrides.get(mint);
    if (override) {
      return override;
    }
    const flags = tokenFlags?.get(mint);
    if (!flags) {
      return undefined;
    }
    if (flags.isStablecoin && !NON_USD_STABLECOIN_SYMBOLS.has(flags.symbol.toLowerCase())) {
      return DOLLAR_PEG;
    }
    if (flags.isLst) {
      return SOL_PAR_PEG;
    }
    return undefined;
  }

  async check(
    _rpc: Rpc<SolanaRpcApi>,
    reserveAddress: Address,
    reserve: KaminoReserve,
    context: TriggerContext
  ): Promise<TriggerResult> {
    const mintAddress = reserve.state.liquidity.mintPubkey;
    const peg = this.resolvePegTarget(mintAddress, context.tokenFlags);
    if (!peg) {
      this.reportUnpegged(mintAddress, context.tokenFlags?.get(mintAddress));
      return {
        safetyScore: 1.0,
        triggerName: this.name,
        reserveAddress,
        details: `no peg configured for mint ${mintAddress}`,
      };
    }

    try {
      // A missing, non-positive, or non-finite price must abort the pass, never score as safe: a NaN
      // would sail through every comparison below and come back out as a NaN safety score.
      const marketPrice = context.marketPrices.get(mintAddress);
      if (!marketPrice || !marketPrice.isFinite() || marketPrice.lte(0)) {
        throw new Error(`unusable secondary-market price for mint ${mintAddress}: ${marketPrice ?? 'missing'}`);
      }

      const { divergenceBps, safeBps, maxBps, details } =
        peg.kind === 'usd'
          ? this.measureDollarPeg(mintAddress, peg.priceUsd, marketPrice, reserve)
          : this.measureTokenPeg(mintAddress, peg, marketPrice, context);

      let safetyScore: number;
      if (divergenceBps <= safeBps) {
        safetyScore = 1.0;
      } else {
        safetyScore = Math.max(0, 1 - Math.sqrt((divergenceBps - safeBps) / (maxBps - safeBps)));
      }

      if (safetyScore < 1.0) {
        logger.warn(
          `[danger-detection] secondary market depeg for reserve ${reserveAddress}: safety=${safetyScore.toFixed(2)}, ${details}`
        );
      }

      return { safetyScore, triggerName: this.name, reserveAddress, details };
    } catch (error) {
      logger.warn(`[danger-detection] error checking secondary market depeg for reserve ${reserveAddress}: ${error}`);
      throw new DangerTriggerUnavailableError(this.name, reserveAddress, error);
    }
  }

  /**
   * Two-sided: a hard $1 peg is symmetric, and the worse of the two independent sources wins. The
   * oracle leg is what makes a market-and-oracle-agree depeg visible, since agreement at $0.92 leaves
   * `oracle-divergence` reporting a perfectly healthy 0%.
   */
  private measureDollarPeg(
    mintAddress: Address,
    pegPriceUsd: number,
    marketPrice: Decimal,
    reserve: KaminoReserve
  ): { divergenceBps: number; safeBps: number; maxBps: number; details: string } {
    const peg = new Decimal(pegPriceUsd);
    if (!peg.isFinite() || peg.lte(0)) {
      throw new Error(`peg price for mint ${mintAddress} must be finite and positive, got ${peg.toString()}`);
    }

    const marketBps = peg.sub(marketPrice).abs().div(peg).mul(FULL_BPS).toNumber();
    // The SDK flags a price it cannot trust; an untrusted oracle is `oracle-divergence`'s business, so
    // here it is simply left out of the comparison rather than scored as a divergence of its own.
    const oraclePrice = reserve.tokenOraclePrice.valid ? reserve.tokenOraclePrice.price : undefined;
    const oracleBps =
      oraclePrice && oraclePrice.isFinite() && oraclePrice.gt(0)
        ? peg.sub(oraclePrice).abs().div(peg).mul(FULL_BPS).toNumber()
        : undefined;

    const divergenceBps = Math.max(marketBps, oracleBps ?? 0);
    const implausible = this.reportImplausiblePeg(mintAddress, marketPrice, peg, 'USD');
    const details =
      `mint ${mintAddress}: market ${marketPrice.toFixed(6)} (${marketBps.toFixed(0)} bps) and ` +
      `oracle ${oraclePrice ? `${oraclePrice.toFixed(6)} (${oracleBps!.toFixed(0)} bps)` : 'unavailable'} ` +
      `vs ${peg.toFixed(6)} USD peg, worst=${divergenceBps.toFixed(0)} bps` +
      (implausible ? ' [IMPLAUSIBLE PEG: verify this token is really worth $1]' : '');

    return { divergenceBps, safeBps: STABLE_SAFE_DIVERGENCE_BPS, maxBps: STABLE_MAX_DIVERGENCE_BPS, details };
  }

  /**
   * One-sided: only a discount below the reference floor is a danger signal. A premium is not a loss
   * for a depositor holding the token, and is the normal state of a yield-accruing LST.
   */
  private measureTokenPeg(
    mintAddress: Address,
    peg: { readonly referenceMint: Address; readonly minRatio: number },
    marketPrice: Decimal,
    context: TriggerContext
  ): { divergenceBps: number; safeBps: number; maxBps: number; details: string } {
    const referencePrice = context.marketPrices.get(peg.referenceMint);
    if (!referencePrice || !referencePrice.isFinite() || referencePrice.lte(0)) {
      throw new Error(
        `unusable secondary-market price for peg reference mint ${peg.referenceMint}: ${referencePrice ?? 'missing'}`
      );
    }
    const floor = new Decimal(peg.minRatio);
    if (!floor.isFinite() || floor.lte(0)) {
      throw new Error(`peg floor for mint ${mintAddress} must be finite and positive, got ${floor.toString()}`);
    }

    const observed = marketPrice.div(referencePrice);
    const divergenceBps = observed.gte(floor) ? 0 : floor.sub(observed).div(floor).mul(FULL_BPS).toNumber();
    const implausible = this.reportImplausiblePeg(mintAddress, observed, floor, `× ${peg.referenceMint}`);
    const details =
      `mint ${mintAddress}: market ${observed.toFixed(6)} vs floor ${floor.toFixed(6)} × ${peg.referenceMint}, ` +
      `discount=${divergenceBps.toFixed(0)} bps` +
      (implausible ? ' [IMPLAUSIBLE PEG: verify this token is really pegged to that reference]' : '');

    return { divergenceBps, safeBps: LST_SAFE_DISCOUNT_BPS, maxBps: LST_MAX_DISCOUNT_BPS, details };
  }

  /** Log once per mint that this trigger is not watching it, and why. */
  private reportUnpegged(mintAddress: Address, flags: TokenFlags | undefined): void {
    const key = mintAddress.toString();
    if (this.reportedUnpegged.has(key)) {
      return;
    }
    this.reportedUnpegged.add(key);
    if (flags?.isStablecoin) {
      logger.warn(
        `[danger-detection] ${this.name}: ${flags.symbol} (${mintAddress}) carries the stablecoin tag but is on the non-USD/yield-bearing exclusion list, so its peg value is NOT checked — only oracle-divergence covers it`
      );
      return;
    }
    logger.warn(
      `[danger-detection] ${this.name}: no peg is known for ${flags?.symbol ?? 'mint'} ${mintAddress} (not tagged stablecoin or lst), so its peg is NOT checked`
    );
  }

  /**
   * A peg target should be the same order of magnitude as what the token actually trades at. Outside
   * a 0.5x-2x band the classification is almost certainly wrong — a token that is not really worth
   * the peg value. Reported once per mint, and deliberately advisory: the score is never relaxed on
   * the low side, because an implausibly low observation is indistinguishable from a total depeg and
   * treating it as a config error would fail open on the exact event this trigger exists to catch.
   */
  private reportImplausiblePeg(mintAddress: Address, observed: Decimal, target: Decimal, unit: string): boolean {
    const ratio = observed.div(target).toNumber();
    if (ratio >= 0.5 && ratio <= 2) {
      return false;
    }
    const key = mintAddress.toString();
    if (!this.reportedImplausible.has(key)) {
      this.reportedImplausible.add(key);
      logger.error(
        `[danger-detection] ${this.name}: mint ${mintAddress} trades at ${observed.toFixed(6)} against a ${target.toFixed(6)} ${unit} peg target (${ratio.toFixed(3)}x) — either a total depeg or a misclassified token; verify it before trusting this trigger's verdict`
      );
    }
    return true;
  }
}
