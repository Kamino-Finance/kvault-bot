import { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import { KaminoReserve, lamportsToDecimal } from '@kamino-finance/klend-sdk';
import { logger } from 'kvaults-investing-bot-logger';
import { DangerTriggerUnavailableError, VaultDangerTrigger, VaultTriggerContext } from '../../dangerTypes.js';

const MIN_LIQUIDITY_RATIO = 0.3;

/**
 * Slippery slope trigger: detects when a vault's exit liquidity is constrained.
 *
 * Compares the reserve's available liquidity against the vault's invested amount in that reserve.
 * Score is 1.0 at 100%+ coverage, drops linearly to 0.0 at 30% coverage, and stays at 0.0 below.
 * Per-vault: different vaults will get different scores for the same reserve.
 */
export class ExitLiquidityTrigger implements VaultDangerTrigger {
  readonly name = 'exit-liquidity';

  async check(_rpc: Rpc<SolanaRpcApi>, reserveAddress: Address, reserve: KaminoReserve, context: VaultTriggerContext) {
    const { vaultInvestedInReserve } = context;

    if (vaultInvestedInReserve.lte(0)) {
      // No exposure means no exit risk
      return {
        safetyScore: 1.0,
        triggerName: this.name,
        reserveAddress,
        details: 'no vault exposure to reserve',
      };
    }

    try {
      const decimals = reserve.state.liquidity.mintDecimals.toNumber();
      const availableLiquidity = lamportsToDecimal(
        reserve.getFreelyAvailableLiquidityAmount(context.currentSlot).toString(),
        decimals
      );
      const liquidityRatio = availableLiquidity.div(vaultInvestedInReserve);

      // Linear from MIN_LIQUIDITY_RATIO → 0.0 to 100% → 1.0; clamp outside this range
      const safetyScore = Math.max(
        0,
        Math.min(1.0, (liquidityRatio.toNumber() - MIN_LIQUIDITY_RATIO) / (1 - MIN_LIQUIDITY_RATIO))
      );
      const details = `available ${availableLiquidity.toFixed(2)} / invested ${vaultInvestedInReserve.toFixed(2)} = ${liquidityRatio.toFixed(2)}x coverage`;

      if (safetyScore < 1.0) {
        logger.warn(
          `[danger-detection] exit liquidity for reserve ${reserveAddress}: safety=${safetyScore.toFixed(2)}, ${details}`
        );
      }

      return { safetyScore, triggerName: this.name, reserveAddress, details };
    } catch (error) {
      logger.warn(`[danger-detection] error checking exit liquidity for reserve ${reserveAddress}: ${error}`);
      throw new DangerTriggerUnavailableError(this.name, reserveAddress, error);
    }
  }
}
