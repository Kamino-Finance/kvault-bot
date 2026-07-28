import { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import { KaminoReserve } from '@kamino-finance/klend-sdk';
import { logger } from 'kvaults-investing-bot-logger';
import { DangerTrigger, DangerTriggerUnavailableError, TriggerContext, TriggerResult } from '../dangerTypes.js';

const DEFAULT_APY_CEILING = 0.2;

/**
 * Transient trigger: detects a supply APY spike above a sane ceiling.
 *
 * No legitimate lending market sustains 20%+ supply APY on its own — values above the
 * ceiling indicate rate model manipulation, oracle issues, or an exploited reserve
 * inflating apparent yields.
 * Binary: APY ≤ ceiling → 1.0 (safe), APY > ceiling → 0.0 (danger).
 */
export class SupplyApySpikeTrigger implements DangerTrigger {
  readonly name = 'supply-apy-spike';
  private readonly apyCeiling: number;

  constructor(apyCeiling: number = DEFAULT_APY_CEILING) {
    this.apyCeiling = apyCeiling;
  }

  async check(
    _rpc: Rpc<SolanaRpcApi>,
    reserveAddress: Address,
    reserve: KaminoReserve,
    context: TriggerContext
  ): Promise<TriggerResult> {
    try {
      const supplyApy = reserve.totalSupplyAPY(context.currentSlot);
      if (!Number.isFinite(supplyApy)) {
        throw new Error(`invalid supply APY ${supplyApy}`);
      }

      if (supplyApy > this.apyCeiling) {
        const details = `supply APY ${(supplyApy * 100).toFixed(2)}% exceeds ceiling ${(this.apyCeiling * 100).toFixed(2)}% for reserve ${reserveAddress}`;
        logger.error(`[danger-detection] SUPPLY APY SPIKE: ${details}`);
        return { safetyScore: 0.0, triggerName: this.name, reserveAddress, details };
      }

      return {
        safetyScore: 1.0,
        triggerName: this.name,
        reserveAddress,
        details: `supply APY ${(supplyApy * 100).toFixed(2)}% within ceiling`,
      };
    } catch (error) {
      logger.warn(`[danger-detection] error checking supply APY for reserve ${reserveAddress}: ${error}`);
      throw new DangerTriggerUnavailableError(this.name, reserveAddress, error);
    }
  }
}
