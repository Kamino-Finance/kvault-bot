import { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import { KaminoReserve } from '@kamino-finance/klend-sdk';
import { DangerTrigger, TriggerContext, TriggerResult } from '../dangerTypes.js';
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
export declare class OracleDivergenceTrigger implements DangerTrigger {
    readonly name = "oracle-divergence";
    check(_rpc: Rpc<SolanaRpcApi>, reserveAddress: Address, reserve: KaminoReserve, context: TriggerContext): Promise<TriggerResult>;
}
//# sourceMappingURL=oracleDivergenceTrigger.d.ts.map