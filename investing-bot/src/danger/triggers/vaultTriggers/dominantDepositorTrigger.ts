import { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import { KaminoReserve, lamportsToDecimal } from '@kamino-finance/klend-sdk';
import { logger } from 'kvaults-investing-bot-logger';
import { DangerTriggerUnavailableError, VaultDangerTrigger, VaultTriggerContext } from '../../dangerTypes.js';

const FULL_BPS = 10_000;

// Vault holds x% of the total funds allocated in a reserve
const MINIMAL_POSITION = 0.1;
const MAJORITY_POSITION = 0.5;
const SINGLE_DEPOSITOR = 0.9;

const SAFETY_RATINGS: Record<number, number> = {
  [MINIMAL_POSITION]: 1.0, // ≤10% allocation - always safe
  [MAJORITY_POSITION]: 0.7, // (10%;50%] - usually safe
  [SINGLE_DEPOSITOR]: 0.3, // (50%; 90%) - potentially unsafe
  // ≥90% - usually unsafe
};

/**
 * Red flag trigger: detects when a vault is a dominant depositor in a reserve.
 *
 * Compares the vault's invested amount against the reserve's total supply.
 * If the vault holds a large fraction of the reserve, exiting could cause a
 * liquidity spiral (forced unwind of borrows, slippage, etc.).
 *
 * Per-vault: different vaults will get different scores for the same reserve.
 */
export class DominantDepositorTrigger implements VaultDangerTrigger {
  readonly name = 'dominant-depositor';

  async check(_rpc: Rpc<SolanaRpcApi>, reserveAddress: Address, reserve: KaminoReserve, context: VaultTriggerContext) {
    const { vaultInvestedInReserve, currentSlot } = context;

    if (vaultInvestedInReserve.lte(0)) {
      return {
        safetyScore: 1.0,
        triggerName: this.name,
        reserveAddress,
        details: 'no vault exposure to reserve',
      };
    }

    try {
      const decimals = reserve.state.liquidity.mintDecimals.toNumber();
      const totalSupply = lamportsToDecimal(reserve.getEstimatedTotalSupply(currentSlot, 0).toString(), decimals);

      if (totalSupply.lte(0)) {
        // Reserve has no supply but vault has a position — treat as 100% dominance, which also trips
        // any configured pull-out threshold (every threshold is at most 100%).
        const safetyScore = computeDominanceSafetyScore(1, context.maxVaultDominanceBps);
        const details = `reserve total supply is zero, vault invested ${vaultInvestedInReserve.toFixed(2)}`;
        logger.warn(
          `[danger-detection] dominant depositor for reserve ${reserveAddress}: safety=${safetyScore.toFixed(2)}, ${details}`
        );
        return { safetyScore, triggerName: this.name, reserveAddress, details };
      }

      const dominance = vaultInvestedInReserve.div(totalSupply).toNumber();
      const safetyScore = computeDominanceSafetyScore(dominance, context.maxVaultDominanceBps);
      const configuredThreshold =
        context.maxVaultDominanceBps === undefined
          ? ''
          : `, pull-out threshold ${(context.maxVaultDominanceBps / FULL_BPS) * 100}%`;
      const details = `invested ${vaultInvestedInReserve.toFixed(2)} / total supply ${totalSupply.toFixed(2)} = ${(dominance * 100).toFixed(2)}% dominance${configuredThreshold}`;

      if (safetyScore < 1.0) {
        logger.warn(
          `[danger-detection] dominant depositor for reserve ${reserveAddress}: safety=${safetyScore.toFixed(2)}, ${details}`
        );
      }

      return { safetyScore, triggerName: this.name, reserveAddress, details };
    } catch (error) {
      logger.warn(`[danger-detection] error checking dominant depositor for reserve ${reserveAddress}: ${error}`);
      throw new DangerTriggerUnavailableError(this.name, reserveAddress, error);
    }
  }
}

/**
 * Piecewise linear, skewed so above 50% gets dangerous fast.
 * Anchor points come from SAFETY_RATINGS:
 *  ≤MINIMAL_POSITION  → 1.0  (safe)
 *  MINIMAL_POSITION  → MAJORITY_POSITION  → linear interpolation (mild)
 *  MAJORITY_POSITION → SINGLE_DEPOSITOR   → linear interpolation (steeper)
 *  ≥SINGLE_DEPOSITOR  → 0.3  (floor)
 * Floor 0.3 sits at the SENSIBLE threshold, so this trigger never fires alone for SENSIBLE
 * or YOLO. PARANOID (threshold 0.5) can pull out on extreme dominance alone — accepted by design.
 *
 * `maxDominanceBps` overrides that ceiling when configured: at or above it the score is 0, which
 * forces an emergency pull-out at any risk appetite. It is deliberately a step rather than a rescaled
 * curve — an operator setting "leave above 60%" gets exactly that, and the graduated red-flag score
 * still compounds with the other triggers everywhere below it.
 */
function computeDominanceSafetyScore(dominance: number, maxDominanceBps?: number): number {
  if (maxDominanceBps !== undefined && dominance >= maxDominanceBps / FULL_BPS) {
    return 0;
  }
  if (dominance <= MINIMAL_POSITION) {
    return SAFETY_RATINGS[MINIMAL_POSITION];
  }
  if (dominance <= MAJORITY_POSITION) {
    return interpolate(dominance, MINIMAL_POSITION, MAJORITY_POSITION);
  }
  if (dominance <= SINGLE_DEPOSITOR) {
    return interpolate(dominance, MAJORITY_POSITION, SINGLE_DEPOSITOR);
  }
  return SAFETY_RATINGS[SINGLE_DEPOSITOR];
}

function interpolate(dominance: number, lo: number, hi: number): number {
  const t = (dominance - lo) / (hi - lo);
  return SAFETY_RATINGS[lo] + t * (SAFETY_RATINGS[hi] - SAFETY_RATINGS[lo]);
}
