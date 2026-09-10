import { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import { KaminoReserve } from '@kamino-finance/klend-sdk';
import { VaultDangerTrigger, VaultTriggerContext } from '../../dangerTypes.js';
/**
 * Red flag trigger: detects when a vault is a dominant depositor in a reserve.
 *
 * Compares the vault's invested amount against the reserve's total supply.
 * If the vault holds a large fraction of the reserve, exiting could cause a
 * liquidity spiral (forced unwind of borrows, slippage, etc.).
 *
 * Per-vault: different vaults will get different scores for the same reserve.
 */
export declare class DominantDepositorTrigger implements VaultDangerTrigger {
    readonly name = "dominant-depositor";
    check(_rpc: Rpc<SolanaRpcApi>, reserveAddress: Address, reserve: KaminoReserve, context: VaultTriggerContext): Promise<{
        safetyScore: number;
        triggerName: string;
        reserveAddress: Address;
        details: string;
    }>;
}
//# sourceMappingURL=dominantDepositorTrigger.d.ts.map