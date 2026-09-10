import { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import { KaminoReserve } from '@kamino-finance/klend-sdk';
import { DangerTrigger, TriggerContext, TriggerResult } from '../dangerTypes.js';
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
export declare class ExchangeRateTrigger implements DangerTrigger {
    readonly name = "exchange-rate-anomaly";
    private readonly previousRateByReserve;
    private readonly pendingRateByReserve;
    check(_rpc: Rpc<SolanaRpcApi>, reserveAddress: Address, reserve: KaminoReserve, context: TriggerContext): Promise<TriggerResult>;
    commitObservation(reserveAddress: Address): void;
}
//# sourceMappingURL=exchangeRateTrigger.d.ts.map