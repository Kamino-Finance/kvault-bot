import { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import { KaminoReserve } from '@kamino-finance/klend-sdk';
import { logger } from 'kvaults-investing-bot-logger';
import { DangerTrigger, DangerTriggerUnavailableError, TriggerContext, TriggerResult } from '../dangerTypes.js';

const SAFE_DIVERGENCE_PERCENT = 2; // below this, no concern
const MAX_DIVERGENCE_PERCENT = 10; // at and above this, score = 0

/**
 * Slippery slope trigger: detects divergence between the on-chain oracle price
 * and the off-chain market price (Kamino API).
 *
 * Compares `reserve.tokenOraclePrice.price` against the market price for the same mint.
 * Below 2% divergence → 1.0 (normal market spread).
 * Above 2% the score decays as `1 - sqrt((divergence - 2) / 8)`, hitting 0 at 10%+.
 * At 5% → ~0.39, at 7% → ~0.21, at 10%+ → 0.0 (forces pullout for any risk appetite).
 * Tight thresholds because both price sources should agree closely under normal conditions —
 * any large divergence indicates a stale/manipulated oracle or a depegging stablecoin.
 * Reserve-intrinsic: same divergence applies to all vaults using this reserve.
 */
export class OracleDivergenceTrigger implements DangerTrigger {
  readonly name = 'oracle-divergence';

  async check(
    _rpc: Rpc<SolanaRpcApi>,
    reserveAddress: Address,
    reserve: KaminoReserve,
    context: TriggerContext
  ): Promise<TriggerResult> {
    const mintAddress = reserve.state.liquidity.mintPubkey;

    try {
      // The SDK flags a price it cannot trust (stale beyond the feed's max age, low confidence, or an
      // unhealthy oracle account) as invalid. A frozen/invalid oracle is the classic pre-exploit
      // condition, so fail closed here rather than comparing a stale price as if it were live. Not
      // marked catastrophic — the oracle can recover, so this drives an emergency pull-out, not a
      // permanent blacklist.
      if (!reserve.tokenOraclePrice.valid) {
        logger.error(
          `[danger-detection] oracle price is flagged invalid/stale for mint ${mintAddress} — failing closed`
        );
        return {
          safetyScore: 0.0,
          triggerName: this.name,
          reserveAddress,
          details: `oracle price flagged invalid/stale for mint ${mintAddress} — failing closed`,
        };
      }

      const oraclePrice = reserve.tokenOraclePrice.price;
      const marketPrice = context.marketPrices.get(mintAddress);

      if (!marketPrice || marketPrice.lte(0)) {
        throw new Error(`missing positive market price for mint ${mintAddress}`);
      }

      if (oraclePrice.lte(0)) {
        logger.error(
          `[danger-detection] oracle price is non-positive (${oraclePrice.toString()}) for mint ${mintAddress} while market price is ${marketPrice.toFixed(6)} — failing closed`
        );
        return {
          safetyScore: 0.0,
          triggerName: this.name,
          reserveAddress,
          details: `oracle price is non-positive (${oraclePrice.toString()}) for mint ${mintAddress} while market price exists — failing closed`,
        };
      }

      const divergencePercent = oraclePrice.sub(marketPrice).abs().div(marketPrice).mul(100).toNumber();

      let safetyScore: number;
      if (divergencePercent <= SAFE_DIVERGENCE_PERCENT) {
        safetyScore = 1.0;
      } else {
        const normalized =
          (divergencePercent - SAFE_DIVERGENCE_PERCENT) / (MAX_DIVERGENCE_PERCENT - SAFE_DIVERGENCE_PERCENT);
        safetyScore = Math.max(0, 1 - Math.sqrt(normalized));
      }

      const details = `mint ${mintAddress}: oracle=${oraclePrice.toFixed(6)}, market=${marketPrice.toFixed(6)}, divergence=${divergencePercent.toFixed(2)}%`;

      if (safetyScore < 1.0) {
        logger.warn(
          `[danger-detection] oracle divergence for reserve ${reserveAddress}: safety=${safetyScore.toFixed(2)}, ${details}`
        );
      }

      return { safetyScore, triggerName: this.name, reserveAddress, details };
    } catch (error) {
      logger.warn(`[danger-detection] error checking oracle divergence for reserve ${reserveAddress}: ${error}`);
      throw new DangerTriggerUnavailableError(this.name, reserveAddress, error);
    }
  }
}
