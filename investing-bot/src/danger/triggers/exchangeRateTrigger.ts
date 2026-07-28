import { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import { KaminoReserve } from '@kamino-finance/klend-sdk';
import { Decimal } from 'decimal.js';
import { logger } from 'kvaults-investing-bot-logger';
import { DangerTrigger, DangerTriggerUnavailableError, TriggerContext, TriggerResult } from '../dangerTypes.js';

// Relative increase above which the collateral exchange rate is judged anomalous. Deposits and
// withdrawals preserve the rate exactly and interest accrual only lowers it (see below), so any
// meaningful increase signals lost liquidity. The small tolerance absorbs fee-refresh/rounding
// micro-movements so they cannot trip a permanent blacklist, while any real loss (>0.1%) still fires.
const RATE_INCREASE_TOLERANCE = 0.001;

/**
 * Catastrophic trigger: detects cToken exchange rate increases.
 *
 * `getEstimatedCollateralExchangeRate` returns cTokens-per-liquidity-token
 * (`collateral.mintTotalSupply / estimatedTotalSupply`). Deposits and withdrawals change both terms
 * proportionally and preserve the ratio; interest accrual grows the liquidity denominator, so under
 * healthy operation the rate only ever DECREASES. An increase means the liquidity backing the
 * cTokens shrank — a loss of funds in the reserve (exploit, bad debt).
 * Binary: rate stable/decreasing → 1.0 (safe), increase beyond tolerance → 0.0 (catastrophic danger).
 */
export class ExchangeRateTrigger implements DangerTrigger {
  readonly name = 'exchange-rate-anomaly';
  private readonly previousRateByReserve: Map<string, Decimal> = new Map();
  private readonly pendingRateByReserve: Map<string, Decimal> = new Map();

  async check(
    _rpc: Rpc<SolanaRpcApi>,
    reserveAddress: Address,
    reserve: KaminoReserve,
    context: TriggerContext
  ): Promise<TriggerResult> {
    const reserveKey = reserveAddress.toString();

    try {
      // The SDK clamps getEstimatedCollateralExchangeRate to INITIAL_COLLATERAL_RATE (1) when either
      // mintTotalSupply or totalSupply is zero, which MASKS the worst catastrophe: cTokens still
      // outstanding with zero liquidity backing them (a full drain / total loss of funds). Detect that
      // state directly from the raw supplies instead of trusting the clamped rate.
      const totalSupply = reserve.getEstimatedTotalSupply(context.currentSlot, 0);
      const mintTotalSupply = new Decimal(reserve.state.collateral.mintTotalSupply.toString());
      if (totalSupply.lte(0) && mintTotalSupply.gt(0)) {
        const details = `reserve ${reserveKey} has ${mintTotalSupply.toString()} cTokens outstanding but zero liquidity backing — total loss of funds`;
        logger.error(`[danger-detection] EXCHANGE RATE ANOMALY: ${details}`);
        return { safetyScore: 0.0, triggerName: this.name, reserveAddress, details, catastrophic: true };
      }

      const currentRate = reserve.getEstimatedCollateralExchangeRate(context.currentSlot, 0);
      if (!currentRate.isFinite() || currentRate.lte(0)) {
        throw new Error(`invalid collateral exchange rate ${currentRate.toString()}`);
      }
      const previousRate = this.previousRateByReserve.get(reserveKey);
      const finish = (result: TriggerResult): TriggerResult => {
        this.pendingRateByReserve.set(reserveKey, currentRate);
        if (!context.deferObservationCommit) {
          this.commitObservation(reserveAddress);
        }
        return result;
      };

      if (previousRate === undefined) {
        return finish({ safetyScore: 1.0, triggerName: this.name, reserveAddress, details: 'first observation' });
      }

      const maxHealthyRate = previousRate.mul(1 + RATE_INCREASE_TOLERANCE);
      if (currentRate.gt(maxHealthyRate)) {
        const details = `exchange rate increased from ${previousRate.toString()} to ${currentRate.toString()} for reserve ${reserveKey} (liquidity backing shrank — likely loss of funds)`;
        logger.error(`[danger-detection] EXCHANGE RATE ANOMALY: ${details}`);
        return finish({
          safetyScore: 0.0,
          triggerName: this.name,
          reserveAddress,
          details,
          catastrophic: true,
        });
      }

      return finish({
        safetyScore: 1.0,
        triggerName: this.name,
        reserveAddress,
        details: `exchange rate stable/decreasing: ${currentRate.toString()}`,
      });
    } catch (error) {
      logger.warn(`[danger-detection] error checking exchange rate for reserve ${reserveAddress}: ${error}`);
      throw new DangerTriggerUnavailableError(this.name, reserveAddress, error);
    }
  }

  commitObservation(reserveAddress: Address): void {
    const reserveKey = reserveAddress.toString();
    const pendingRate = this.pendingRateByReserve.get(reserveKey);
    if (pendingRate !== undefined) {
      this.previousRateByReserve.set(reserveKey, pendingRate);
      this.pendingRateByReserve.delete(reserveKey);
    }
  }
}
