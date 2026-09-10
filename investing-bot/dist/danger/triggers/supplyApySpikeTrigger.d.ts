import { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import { KaminoReserve } from '@kamino-finance/klend-sdk';
import { DangerTrigger, TriggerContext, TriggerResult } from '../dangerTypes.js';
/**
 * Transient trigger: detects a supply APY spike above a sane ceiling.
 *
 * No legitimate lending market sustains 20%+ supply APY on its own — values above the
 * ceiling indicate rate model manipulation, oracle issues, or an exploited reserve
 * inflating apparent yields.
 * Binary: APY ≤ ceiling → 1.0 (safe), APY > ceiling → 0.0 (danger).
 */
export declare class SupplyApySpikeTrigger implements DangerTrigger {
    readonly name = "supply-apy-spike";
    private readonly apyCeiling;
    constructor(apyCeiling?: number);
    check(_rpc: Rpc<SolanaRpcApi>, reserveAddress: Address, reserve: KaminoReserve, context: TriggerContext): Promise<TriggerResult>;
}
//# sourceMappingURL=supplyApySpikeTrigger.d.ts.map