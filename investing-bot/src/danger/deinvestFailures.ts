import { Address } from '@solana/kit';
import { logger } from 'kvaults-investing-bot-logger';

/** Failed emergency broadcasts after which a reserve must pass simulation before another broadcast. */
export const DEFAULT_FORCE_SEND_FAILURE_LIMIT = 3;

/**
 * Tracks consecutive failed emergency allocation or withdrawal broadcasts for each vault and reserve pair.
 *
 * The tracker stays in memory because it limits fees. It does not make the evacuation decision.
 * A process restart clears the counts and permits force-send again.
 */
export class ReserveDeinvestFailures {
  private readonly consecutiveFailures = new Map<Address, Map<Address, number>>();

  constructor(private readonly forceSendFailureLimit: number = DEFAULT_FORCE_SEND_FAILURE_LIMIT) {}

  shouldForceSend(vault: Address, reserve: Address): boolean {
    return this.failures(vault, reserve) < this.forceSendFailureLimit;
  }

  failures(vault: Address, reserve: Address): number {
    return this.consecutiveFailures.get(vault)?.get(reserve) ?? 0;
  }

  recordFailure(vault: Address, reserve: Address, reason: string): void {
    const failureCount = this.failures(vault, reserve) + 1;
    let vaultFailures = this.consecutiveFailures.get(vault);
    if (vaultFailures === undefined) {
      vaultFailures = new Map<Address, number>();
      this.consecutiveFailures.set(vault, vaultFailures);
    }
    vaultFailures.set(reserve, failureCount);

    if (failureCount >= this.forceSendFailureLimit) {
      const gateStatus =
        failureCount === this.forceSendFailureLimit
          ? 'The bot will now broadcast it only after a successful simulation'
          : `Force-send remains disabled at the limit of ${this.forceSendFailureLimit}`;
      logger.error(
        `[danger-response] emergency transaction for reserve ${reserve} failed ${failureCount} broadcasts in a row ` +
          `for vault ${vault}. ` +
          `${gateStatus} (last failure: ${reason})`
      );
      return;
    }
    logger.error(
      `[danger-response] emergency transaction for reserve ${reserve} failed for vault ${vault} ` +
        `(${failureCount}/${this.forceSendFailureLimit} failed broadcasts in a row): ${reason}`
    );
  }

  recordSuccess(vault: Address, reserve: Address): void {
    const failureCount = this.failures(vault, reserve);
    if (failureCount === 0) return;

    const vaultFailures = this.consecutiveFailures.get(vault);
    vaultFailures?.delete(reserve);
    if (vaultFailures?.size === 0) this.consecutiveFailures.delete(vault);
    logger.info(
      `[danger-response] emergency transaction for reserve ${reserve} confirmed for vault ${vault} after ` +
        `${failureCount} failed broadcast(s). Force-send restored`
    );
  }
}
