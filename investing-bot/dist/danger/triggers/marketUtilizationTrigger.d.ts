import { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import { KaminoReserve } from '@kamino-finance/klend-sdk';
import { DangerTrigger, TriggerContext, TriggerResult } from '../dangerTypes.js';
/**
 * Slippery slope trigger: detects a reserve whose utilization leaves no room to withdraw.
 *
 * Utilization is borrowed / supplied, so the un-borrowed remainder is what any depositor can
 * actually exit with. Ordinary demand keeps it below the safe threshold; approaching full
 * utilization means the vault can only leave ahead of the other depositors, and at 100% it cannot
 * leave at all until borrowers repay.
 * Score is 1.0 at or below the safe threshold and decays linearly to 0.0 at 100% utilization:
 * with the 90% default, 95% → 0.5, 97% → 0.3, 99% → 0.1.
 * Not catastrophic: utilization falls back as borrowers repay, so this drives an emergency pull-out
 * and cooldown rather than a permanent blacklist.
 * Reserve-intrinsic and vault-size independent — `exit-liquidity` scores the same squeeze relative
 * to what a specific vault has invested, and the two compound.
 */
export declare class MarketUtilizationTrigger implements DangerTrigger {
    readonly name = "market-utilization";
    private readonly safeUtilization;
    /** @param safeUtilization highest utilization still scored fully safe; must be in [0, 1). */
    constructor(safeUtilization?: number);
    check(_rpc: Rpc<SolanaRpcApi>, reserveAddress: Address, reserve: KaminoReserve, context: TriggerContext): Promise<TriggerResult>;
}
//# sourceMappingURL=marketUtilizationTrigger.d.ts.map