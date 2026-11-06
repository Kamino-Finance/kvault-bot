import { Decimal } from 'decimal.js';
import { KaminoReserve, LedgerInstant } from '@kamino-finance/klend-sdk';

/** Compares the current and target utilization at the same ledger instant. Token amounts use whole-token units. */
export function isUtilizationChangeAllowed(
  reserve: KaminoReserve,
  currentTokens: Decimal,
  targetTokens: Decimal,
  currentLedgerInstant: LedgerInstant,
  maxUtilizationChangeBps: number
): boolean {
  if (
    !currentTokens.isFinite() ||
    currentTokens.isNegative() ||
    !targetTokens.isFinite() ||
    targetTokens.isNegative() ||
    !Number.isFinite(maxUtilizationChangeBps) ||
    maxUtilizationChangeBps < 0
  ) {
    return false;
  }
  const deltaTokens = targetTokens.sub(currentTokens);
  if (deltaTokens.isZero()) return true;
  const currentUtilization = new Decimal(reserve.getEstimatedUtilizationRatio(currentLedgerInstant, 0));
  const deltaLamports = deltaTokens.abs().mul(new Decimal(10).pow(reserve.state.liquidity.mintDecimals.toNumber()));
  const targetUtilization = new Decimal(
    reserve.calcSimulatedUtilizationRatio(
      deltaLamports,
      deltaTokens.gt(0) ? 'deposit' : 'withdraw',
      currentLedgerInstant,
      0
    )
  );
  return (
    currentUtilization.isFinite() &&
    targetUtilization.isFinite() &&
    targetUtilization.sub(currentUtilization).abs().lte(new Decimal(maxUtilizationChangeBps).div(10_000))
  );
}
