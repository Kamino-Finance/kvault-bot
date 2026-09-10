import { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import { KaminoReserve } from '@kamino-finance/klend-sdk';
import { Decimal } from 'decimal.js';
import { TokenFlags } from '../utils/tokenFlags.js';
import { DangerTrigger, ReserveRiskAssessment, RiskAppetiteMode, TriggerContext, VaultDangerTrigger } from './dangerTypes.js';
/**
 * Default reserve-intrinsic triggers (run once per reserve, results shared across vaults).
 */
export declare function getDefaultTriggers(): DangerTrigger[];
/**
 * Default vault-specific triggers (run per (vault, reserve), since the score depends
 * on the vault's exposure to that reserve).
 */
export declare function getDefaultVaultTriggers(): VaultDangerTrigger[];
export declare class DangerDetector {
    private readonly triggers;
    private readonly vaultTriggers;
    private readonly blacklistPath;
    private readonly reinvestCooldownPasses;
    private readonly reinvestCooldownByReserve;
    constructor(triggers?: DangerTrigger[], vaultTriggers?: VaultDangerTrigger[], blacklistPath?: string, reinvestCooldownPasses?: number);
    /**
     * Advance all reinvest cooldowns by one pass (call once at the start of each danger pass), dropping
     * any that have elapsed. Returns the set of reserves still in cooldown AFTER the decrement — the
     * reserves that must stay excluded from the rebalance optimizer this pass.
     */
    tickReinvestCooldowns(): Set<string>;
    /**
     * Bar a reserve from receiving new allocation for the configured number of passes after a
     * transient pull-out. Resets the window if the reserve is already cooling down (a fresh pull-out
     * restarts the clock).
     */
    recordReinvestCooldown(reserve: string): void;
    /** Reserves currently in reinvest cooldown (excluded from new allocation). */
    getReinvestCooldownReserves(): Set<string>;
    /**
     * Mints the configured triggers need priced in `TriggerContext.marketPrices` on top of the
     * universe's own reserve mints (e.g. the asset a pegged token is quoted against).
     */
    getPriceReferenceMints(reserveMints: Address[], tokenFlags?: ReadonlyMap<Address, TokenFlags>): Address[];
    /**
     * Run all reserve-intrinsic triggers on all reserves and compute combined safety per reserve.
     */
    assessAllReserves(rpc: Rpc<SolanaRpcApi>, vaultsReservesMap: Map<Address, KaminoReserve>, context: TriggerContext): Promise<Map<Address, ReserveRiskAssessment>>;
    /**
     * Commit staged observations for the selected reserves after the coordinator has completed every
     * required safety side effect. Stateless triggers do not implement commitObservation.
     */
    commitObservations(reserveAddresses: ReadonlySet<string>, reservesMap: Map<Address, KaminoReserve>): void;
    /**
     * For a specific vault, run vault-specific triggers on each of its reserves and combine
     * with the intrinsic assessments produced by assessAllReserves (passed in explicitly).
     * Returns dangerous reserves (combined safety below the vault's risk appetite threshold).
     */
    filterDangerousReservesForVault(rpc: Rpc<SolanaRpcApi>, reservesMap: Map<Address, KaminoReserve>, reserveAssessments: Map<Address, ReserveRiskAssessment>, vaultInvestedInReserves: Map<Address, Decimal>, riskAppetite: RiskAppetiteMode, context: TriggerContext, maxVaultDominanceBps?: number): Promise<ReserveRiskAssessment[]>;
    /**
     * Read the blacklist file from disk. Returns the set of currently blacklisted reserve addresses.
     */
    getBlacklistedReserves(): Set<string>;
    getPendingEvacuationReserves(vaultAddress?: string): Set<string>;
    addPendingEvacuations(vaultAddress: string, assessments: ReserveRiskAssessment[]): string[];
    clearPendingEvacuations(vaultAddress: string, reserveAddresses: ReadonlySet<string>): void;
    /**
     * Persist irreversibly-compromised reserves to the blacklist file.
     * Deduplicates — won't add a reserve already present.
     *
     * Only reserves flagged CATASTROPHIC by an intrinsic trigger (infinite mint or a collateral
     * exchange-rate increase — i.e. lost funds) are persisted. Those conditions are irreversible and
     * dangerous independent of any vault's risk appetite, so a single global permanent blacklist is
     * the correct scope. Transient/market conditions (oracle divergence, thin exit liquidity, elevated
     * APY) can also drive combinedSafety to 0 for a pass, but they recover — they trigger an emergency
     * pull-out via the caller without a permanent blacklist entry, so the reserve re-enters the healthy
     * universe once the condition clears. Keying off `combinedSafety === 0` here (the previous
     * behavior) permanently banned reserves for transient dips and could blacklist the whole universe.
     * Transient flapping is dampened separately by the caller via `recordReinvestCooldown`.
     *
     * Returns the reserve keys newly added this call, so the caller can keep its own current-blacklist
     * view in sync with what was persisted without re-reading the file or re-deriving the classification.
     */
    addToBlacklist(assessments: ReserveRiskAssessment[]): string[];
}
//# sourceMappingURL=dangerDetector.d.ts.map