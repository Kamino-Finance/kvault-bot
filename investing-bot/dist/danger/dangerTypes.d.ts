import { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import { KaminoReserve, LedgerInstant } from '@kamino-finance/klend-sdk';
import { Decimal } from 'decimal.js';
import { TokenFlags } from '../utils/tokenFlags.js';
/**
 * Result returned by a single trigger check for a single reserve.
 * Uses a safety score model: 1.0 = perfectly safe, 0.0 = certain danger.
 */
export interface TriggerResult {
    safetyScore: number;
    triggerName: string;
    reserveAddress: Address;
    details: string;
    catastrophic?: boolean;
}
/**
 * Context passed to each trigger check, providing shared on-chain state.
 */
export interface TriggerContext {
    currentLedgerInstant: LedgerInstant;
    marketPrices: Map<Address, Decimal>;
    /**
     * Kamino's token-flags feed, keyed by mint: the authoritative answer to "is this a stablecoin / an
     * LST", which the peg check uses instead of inferring token identity for itself. Absent only for
     * direct trigger callers; the coordinator always supplies it.
     */
    tokenFlags?: ReadonlyMap<Address, TokenFlags>;
    /**
     * Stateful triggers stage, rather than commit, their observation when true. The coordinator uses
     * this to commit a catastrophic observation only after its blacklist entry is durably persisted.
     * Direct trigger callers retain the historical immediate-commit behavior when this is omitted.
     */
    deferObservationCommit?: boolean;
}
/**
 * A DangerTrigger checks whether a reserve is exhibiting dangerous behavior.
 *
 * Triggers are stateful — they may track values across invocations
 * (e.g., previous supply). They are instantiated once and called
 * repeatedly each loop iteration.
 */
export interface DangerTrigger {
    readonly name: string;
    check(rpc: Rpc<SolanaRpcApi>, reserveAddress: Address, reserve: KaminoReserve, context: TriggerContext): Promise<TriggerResult>;
    /** Commit the most recently staged observation for this reserve, when the trigger is stateful. */
    commitObservation?(reserveAddress: Address, reserve: KaminoReserve): void;
    /**
     * Mints this trigger needs in `TriggerContext.marketPrices` beyond the universe's own reserve
     * mints, given those reserve mints and the token flags for the pass (e.g. the asset a pegged token
     * is quoted against). The caller fetches them alongside the reserve mints; a trigger that needs no
     * extra price omits this.
     */
    priceReferenceMints?(reserveMints: Address[], tokenFlags?: ReadonlyMap<Address, TokenFlags>): Address[];
}
/**
 * A trigger could not produce a trustworthy safety score. The caller must not interpret this as
 * either safe or dangerous: abort the whole danger pass so the allocation loop performs no rebalance.
 */
export declare class DangerTriggerUnavailableError extends Error {
    constructor(triggerName: string, reserveAddress: Address, cause: unknown);
}
/**
 * Context passed to vault-specific trigger checks. Includes the vault's
 * exposure to a specific reserve, in addition to the shared on-chain state.
 */
export interface VaultTriggerContext extends TriggerContext {
    vaultInvestedInReserve: Decimal;
    /**
     * Resolved `maxVaultDominanceBps` for this vault: the share of a reserve's total supply at or above
     * which dominance alone forces a pull-out, whatever the risk appetite. Undefined leaves the
     * graduated red-flag score to stand on its own (the default).
     */
    maxVaultDominanceBps?: number;
}
/**
 * A VaultDangerTrigger checks whether a (vault, reserve) pair is exhibiting
 * dangerous behavior. Different vaults will get different scores for the
 * same reserve depending on their exposure.
 */
export interface VaultDangerTrigger {
    readonly name: string;
    check(rpc: Rpc<SolanaRpcApi>, reserveAddress: Address, reserve: KaminoReserve, context: VaultTriggerContext): Promise<TriggerResult>;
}
/**
 * Per-reserve aggregation of all trigger results.
 * Combined safety = product of individual safety scores.
 */
export interface ReserveRiskAssessment {
    reserveAddress: Address;
    combinedSafety: number;
    triggerResults: TriggerResult[];
}
/**
 * Risk appetite presets that map to safety thresholds.
 * When a reserve's combined safety drops below the threshold, emergency deinvest fires.
 */
export declare enum RiskAppetiteMode {
    PARANOID = "PARANOID",// pulls out early, low tolerance
    SENSIBLE = "SENSIBLE",// balanced default
    YOLO = "YOLO"
}
export declare const RISK_APPETITE_THRESHOLDS: Record<RiskAppetiteMode, number>;
/**
 * A single entry in the on-disk blacklist file.
 */
export interface BlacklistEntry {
    reserve: string;
    triggerName: string;
    reason: string;
    timestamp: string;
}
/**
 * A vault-specific evacuation that must be retried until both allocation
 * weight and invested tokens reach zero.
 */
export interface PendingEvacuationEntry extends BlacklistEntry {
    vault: string;
}
/**
 * Schema of the danger_blacklist.json file.
 */
export interface BlacklistFile {
    blacklistedReserves: BlacklistEntry[];
    pendingEvacuations: PendingEvacuationEntry[];
}
//# sourceMappingURL=dangerTypes.d.ts.map