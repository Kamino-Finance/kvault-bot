import { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import { logger } from 'kvaults-investing-bot-logger';
import { CollateralReserve, CollateralTrigger, DangerTrigger, TriggerContext, TriggerResult } from '../dangerTypes.js';
import { StagedObservations } from '../observationStaging.js';

/**
 * Scores Scope age against MAX_STALE_PRICE_DURATION_SECONDS: 0.4 past the limit, 0.2 past twice it, 0 past four times it.
 * Zero and near-zero prices use the greater of publish age and observed zero duration. Skips reserves without Scope pricing.
 */
export class StalePriceTrigger implements DangerTrigger, CollateralTrigger {
  readonly name = 'stale-price';
  /** The ledger time each reserve's Scope price was first seen zero. In memory: a restart starts the clock again. */
  private readonly zeroPriceSinceByReserve = new Map<string, bigint>();
  /**
   * Clock changes staged per pass generation and reserve; see observationStaging.ts. An older pass that outlived its
   * watchdog never commits, so it cannot end the clock a newer pass started. `since: undefined` ends the clock.
   */
  private readonly pendingZeroPriceSince = new StagedObservations<{ since: bigint | undefined }>();

  async check(
    _rpc: Rpc<SolanaRpcApi>,
    reserveAddress: Address,
    _reserve: CollateralReserve,
    context: TriggerContext
  ): Promise<TriggerResult> {
    const observation = context.scopeOracleObservations?.get(reserveAddress);
    const limitSeconds = context.maxStalePriceDurationSeconds;
    const reserveKey = reserveAddress.toString();
    // Only a normal price ends a zero; an unreadable pass leaves the clock as it is.
    if (observation?.kind === 'healthy' || observation?.kind === 'notConfigured') {
      this.stageClock(context, reserveKey, undefined);
    }
    if (limitSeconds === undefined || (observation?.kind !== 'healthy' && observation?.kind !== 'zero')) {
      return { safetyScore: 1, triggerName: this.name, reserveAddress, details: 'no Scope price age to check' };
    }
    let ageSeconds = Number(observation.ageSeconds);
    let zeroDetails = '';
    if (observation.kind === 'zero') {
      const nowSeconds = BigInt(context.currentLedgerInstant.blockTime);
      const zeroSince = this.zeroPriceSinceByReserve.get(reserveKey) ?? nowSeconds;
      this.stageClock(context, reserveKey, zeroSince);
      const zeroSeconds = Number(nowSeconds - zeroSince);
      ageSeconds = Math.max(ageSeconds, zeroSeconds);
      zeroDetails = ` (zero or near zero for ${zeroSeconds}s)`;
    }
    const safetyScore =
      ageSeconds > 4 * limitSeconds ? 0 : ageSeconds > 2 * limitSeconds ? 0.2 : ageSeconds > limitSeconds ? 0.4 : 1;
    const details = `Scope price of reserve ${reserveAddress} is ${ageSeconds}s old${zeroDetails}; the stale-price limit is ${limitSeconds}s`;
    if (safetyScore < 1) {
      logger.warn(`[danger-detection] stale price: ${details}; safety ${safetyScore}`);
    }
    return { safetyScore, triggerName: this.name, reserveAddress, details };
  }

  commitObservation(reserveAddress: Address, _reserve: CollateralReserve, generation: number): void {
    const reserveKey = reserveAddress.toString();
    const pending = this.pendingZeroPriceSince.take(generation, reserveKey);
    if (pending !== undefined) {
      this.setClock(reserveKey, pending.since);
    }
  }

  private stageClock(context: TriggerContext, reserveKey: string, since: bigint | undefined): void {
    const staging = context.observationStaging;
    if (staging) {
      this.pendingZeroPriceSince.stage(staging.generation, reserveKey, { since });
    } else {
      this.setClock(reserveKey, since);
    }
  }

  private setClock(reserveKey: string, since: bigint | undefined): void {
    if (since === undefined) {
      this.zeroPriceSinceByReserve.delete(reserveKey);
    } else {
      this.zeroPriceSinceByReserve.set(reserveKey, since);
    }
  }
}
