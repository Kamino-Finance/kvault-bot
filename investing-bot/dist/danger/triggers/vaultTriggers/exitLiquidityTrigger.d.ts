import { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import { KaminoReserve } from '@kamino-finance/klend-sdk';
import { VaultDangerTrigger, VaultTriggerContext } from '../../dangerTypes.js';
/**
 * Slippery slope trigger: detects when a vault's exit liquidity is constrained.
 *
 * Compares the reserve's available liquidity against the vault's invested amount in that reserve.
 * Score is 1.0 at 100%+ coverage, drops linearly to 0.0 at 30% coverage, and stays at 0.0 below.
 * Per-vault: different vaults will get different scores for the same reserve.
 */
export declare class ExitLiquidityTrigger implements VaultDangerTrigger {
    readonly name = "exit-liquidity";
    check(_rpc: Rpc<SolanaRpcApi>, reserveAddress: Address, reserve: KaminoReserve, context: VaultTriggerContext): Promise<{
        safetyScore: number;
        triggerName: string;
        reserveAddress: Address;
        details: string;
    }>;
}
//# sourceMappingURL=exitLiquidityTrigger.d.ts.map