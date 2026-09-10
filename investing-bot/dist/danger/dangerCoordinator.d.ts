import { KaminoManager, KaminoReserve, KaminoVault } from '@kamino-finance/klend-sdk';
import { Address, KeyPairSigner } from '@solana/kit';
import { ConnectionPool } from 'kvaults-investing-bot-tx/ConnectionPool';
import { AllocationsConfig } from '../allocationsRebalance/rebalanceConfig.js';
import { getTokensBatchPrice } from '../utils/price.js';
import { fetchTokenFlags } from '../utils/tokenFlags.js';
import { DangerDetector } from './dangerDetector.js';
import { executeDangerResponse } from './dangerResponse.js';
/**
 * Per-vault instruction to the allocation loop, modeled as a discriminated union so the rebalance
 * parameters are STRUCTURALLY unavailable for a vault that must be skipped. A vault just responded to
 * this pass carries `skip: true` and exposes no blacklist/cooldown sets, so the loop cannot rebalance
 * (and therefore cannot immediately re-expose) it — that is a compile error, not a convention. Only
 * the `skip: false` variant carries the sets needed to rebalance, and they are the final post-pass
 * sets (grown in place during the pass, so every clear directive observes the same finished view).
 */
export type VaultRebalanceDirective = {
    readonly skip: true;
} | {
    readonly skip: false;
    readonly blacklistedReserves: ReadonlySet<string>;
    readonly cooldownReserves: ReadonlySet<string>;
};
/**
 * Outcome of one danger-detection pass: a per-vault directive. Danger is scoped per vault rather than
 * as a single global verdict, so one dangerous vault no longer stalls the rebalance of every healthy
 * vault. A vault danger detection could not assess is simply absent from the map (the loop skips it).
 */
export interface DangerAssessmentResult {
    readonly directiveByVault: ReadonlyMap<string, VaultRebalanceDirective>;
}
/**
 * Coordinates the safety-critical danger-detection flow for the allocation loop: detection,
 * blacklist persistence, blacklist enforcement, and emergency response.
 */
/**
 * Side-effecting collaborators, injectable so the orchestration contract can be unit-tested without
 * real on-chain sends or network price fetches. Default to the real implementations.
 */
export interface DangerCoordinatorDeps {
    respond?: typeof executeDangerResponse;
    fetchPrices?: typeof getTokensBatchPrice;
    fetchTokenFlags?: typeof fetchTokenFlags;
    marketPriceMaxAgeSeconds?: number;
}
export declare class DangerCoordinator {
    private readonly dangerDetector;
    private kaminoManager;
    private readonly c;
    private readonly allocationAdmin;
    private readonly respond;
    private readonly fetchPrices;
    private readonly fetchTokenFlags;
    private readonly marketPriceMaxAgeSeconds;
    private lastTokenFlags;
    constructor(dangerDetector: DangerDetector, kaminoManager: KaminoManager, c: ConnectionPool, allocationAdmin: KeyPairSigner, deps?: DangerCoordinatorDeps);
    updateKaminoManager(kaminoManager: KaminoManager): void;
    /**
     * Token flags for this pass, falling back to the previous snapshot when the feed is unreachable.
     * Throws when there is no snapshot to fall back to: without flags the peg check silently applies to
     * nothing, which would read as "no token has a peg" rather than "the feed is down".
     */
    private loadTokenFlags;
    /**
     * Run a full danger pass over all vaults for one loop iteration:
     * 1. read the existing blacklist;
     * 2. assess every reserve's intrinsic risk once;
     * 3. for each vault, combine with vault-specific risk and, if dangerous, blacklist + emergency-respond;
     * 4. otherwise re-enforce zero allocation for any already-blacklisted reserves the vault holds.
     *
     * @param vaultsReservesMap reserves keyed by address (for risk assessment and response)
     * @param vaultsReserves reserves as loaded for the loop (passed to getVaultHoldings)
     * @param dryRun when true, detect/log danger but skip blacklist writes and response transactions
     *   for EVERY vault. It is OR-ed with each vault's own allocation/vault-level dry-run flag, so a
     *   vault configured for observation only never receives real emergency transactions.
     * @param heartbeat optional liveness callback beaten once per vault so the loop's readiness probe
     *   does not go stale during a long danger pass
     */
    detectAndRespond(allocationsConfig: AllocationsConfig, kaminoVaultsMap: Map<Address, KaminoVault>, vaultsReservesMap: Map<Address, KaminoReserve>, vaultsReserves: Map<Address, KaminoReserve>, dryRun?: boolean, heartbeat?: () => void): Promise<DangerAssessmentResult>;
    private clearCompletedPendingEvacuations;
}
//# sourceMappingURL=dangerCoordinator.d.ts.map