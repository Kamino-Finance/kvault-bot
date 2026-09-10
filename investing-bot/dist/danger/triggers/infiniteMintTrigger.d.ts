import { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import { KaminoReserve } from '@kamino-finance/klend-sdk';
import { DangerTrigger, TriggerContext, TriggerResult } from '../dangerTypes.js';
/**
 * Fetches the on-chain total supply for a mint. Injectable so the trigger's detection logic can be
 * unit-tested without RPC; defaults to reading it via `fetchMint`.
 */
export type MintSupplyFetcher = (rpc: Rpc<SolanaRpcApi>, mint: Address) => Promise<bigint>;
/**
 * Catastrophic trigger: detects abnormal token supply growth (infinite mint attack).
 *
 * Tracks the supply of each underlying token mint across iterations.
 * If supply increases by more than the configured threshold between checks, it indicates
 * someone is minting tokens out of thin air.
 * Binary: below threshold → 1.0 (safe), above threshold → 0.0 (danger).
 */
export declare class InfiniteMintTrigger implements DangerTrigger {
    readonly name = "infinite-mint";
    private readonly thresholdPercent;
    private readonly previousSupplyByMint;
    private readonly pendingSupplyByMint;
    private readonly fetchSupply;
    constructor(thresholdPercent?: number, fetchSupply?: MintSupplyFetcher);
    check(rpc: Rpc<SolanaRpcApi>, reserveAddress: Address, reserve: KaminoReserve, context: TriggerContext): Promise<TriggerResult>;
    commitObservation(_reserveAddress: Address, reserve: KaminoReserve): void;
}
//# sourceMappingURL=infiniteMintTrigger.d.ts.map