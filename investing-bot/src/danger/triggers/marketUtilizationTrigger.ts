import { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import { KaminoReserve } from '@kamino-finance/klend-sdk';
import { logger } from 'kvaults-investing-bot-logger';
import { DangerTrigger, DangerTriggerUnavailableError, TriggerContext, TriggerResult } from '../dangerTypes.js';

const DEFAULT_SAFE_UTILIZATION = 0.9; // below this, ordinary lending-market demand
// Full utilization is a physical limit, not a tuning knob: every supplied token is borrowed, so
// nothing can be withdrawn. It is the zero point of the score, hence not configurable.
const FULL_UTILIZATION = 1.0;

/**
 * Slippery slope trigger: detects a reserve whose utilization leaves no room to withdraw.
 *
 * Utilization is borrowed / supplied, so the un-borrowed remainder is what any depositor can
 * actually exit with. Ordinary demand keeps it below the safe threshold; approaching full
 * utilization means the vault can only leave ahead of the other depositors, and at 100% it cannot
 * leave at all until borrowers repay.
 * Score is 1.0 at or below the safe threshold and decays linearly to 0.0 at 100% utilization:
 * with the 90% default, 95% → 0.5, 97% → 0.3, 99% → 0.1.
 * Not catastrophic: utilization falls back as borrowers repay, so this drives an emergency pull-out
 * and cooldown rather than a permanent blacklist.
 * Reserve-intrinsic and vault-size independent — `exit-liquidity` scores the same squeeze relative
 * to what a specific vault has invested, and the two compound.
 */
export class MarketUtilizationTrigger implements DangerTrigger {
  readonly name = 'market-utilization';
  private readonly safeUtilization: number;

  /** @param safeUtilization highest utilization still scored fully safe; must be in [0, 1). */
  constructor(safeUtilization: number = DEFAULT_SAFE_UTILIZATION) {
    if (!Number.isFinite(safeUtilization) || safeUtilization < 0 || safeUtilization >= FULL_UTILIZATION) {
      throw new Error(
        `[danger-detection] ${MarketUtilizationTrigger.name} safeUtilization must be in [0, ${FULL_UTILIZATION}), got ${safeUtilization}`
      );
    }
    this.safeUtilization = safeUtilization;
  }

  async check(
    _rpc: Rpc<SolanaRpcApi>,
    reserveAddress: Address,
    reserve: KaminoReserve,
    context: TriggerContext
  ): Promise<TriggerResult> {
    try {
      // Ledger-aware read: interest accrued since the reserve's last on-chain refresh moves both
      // borrowed and supplied amounts, so the stale ratio can understate the current squeeze.
      const utilization = reserve.getEstimatedUtilizationRatio(context.currentLedgerInstant, 0);
      // Utilization is borrowed / supplied, so it cannot be negative or non-finite. Such a reading is
      // garbage, not a safe reserve: abort the pass instead of clamping it up to a 1.0 score.
      if (!Number.isFinite(utilization) || utilization < 0) {
        throw new Error(`invalid utilization ratio ${utilization}`);
      }

      // Linear from safeUtilization → 1.0 down to FULL_UTILIZATION → 0.0; clamp outside that range.
      const safetyScore = Math.max(
        0,
        Math.min(1.0, (FULL_UTILIZATION - utilization) / (FULL_UTILIZATION - this.safeUtilization))
      );
      const details = `utilization ${(utilization * 100).toFixed(2)}% vs safe threshold ${(this.safeUtilization * 100).toFixed(2)}%`;

      if (safetyScore < 1.0) {
        logger.warn(
          `[danger-detection] market utilization for reserve ${reserveAddress}: safety=${safetyScore.toFixed(2)}, ${details}`
        );
      }

      return { safetyScore, triggerName: this.name, reserveAddress, details };
    } catch (error) {
      logger.warn(`[danger-detection] error checking market utilization for reserve ${reserveAddress}: ${error}`);
      throw new DangerTriggerUnavailableError(this.name, reserveAddress, error);
    }
  }
}
