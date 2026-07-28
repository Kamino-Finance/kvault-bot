import { KaminoManager, KaminoReserve, KaminoVault } from '@kamino-finance/klend-sdk';
import { address, Address, KeyPairSigner, Rpc, Slot, SolanaRpcApi } from '@solana/kit';
import { logger } from 'kvaults-investing-bot-logger';
import { ConnectionPool } from 'kvaults-investing-bot-tx/ConnectionPool';
import {
  AllocationsConfig,
  getAllocationDryRun,
  getMaxVaultDominanceBps,
  getRiskAppetiteMode,
  getVaultAddress,
} from '../allocationsRebalance/rebalanceConfig.js';
import { DEFAULT_MARKET_PRICE_MAX_AGE_SECONDS, getTokensBatchPrice } from '../utils/price.js';
import { fetchTokenFlags, TokenFlags } from '../utils/tokenFlags.js';
import { DangerDetector } from './dangerDetector.js';
import { executeDangerResponse } from './dangerResponse.js';
import { TriggerContext } from './dangerTypes.js';
import { vaultHasExposureToReserves } from './vaultExposure.js';

/**
 * Per-vault instruction to the allocation loop, modeled as a discriminated union so the rebalance
 * parameters are STRUCTURALLY unavailable for a vault that must be skipped. A vault just responded to
 * this pass carries `skip: true` and exposes no blacklist/cooldown sets, so the loop cannot rebalance
 * (and therefore cannot immediately re-expose) it — that is a compile error, not a convention. Only
 * the `skip: false` variant carries the sets needed to rebalance, and they are the final post-pass
 * sets (grown in place during the pass, so every clear directive observes the same finished view).
 */
export type VaultRebalanceDirective =
  | { readonly skip: true }
  | {
      readonly skip: false;
      // Force-zeroed in the rebalance universe. ReadonlySet: the loop must not mutate the shared set.
      readonly blacklistedReserves: ReadonlySet<string>;
      // Excluded from the optimizer (no new allocation) but NOT force-zeroed.
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

export class DangerCoordinator {
  private readonly respond: typeof executeDangerResponse;
  private readonly fetchPrices: typeof getTokensBatchPrice;
  private readonly fetchTokenFlags: typeof fetchTokenFlags;
  private readonly marketPriceMaxAgeSeconds: number;
  // Last successfully fetched token flags. A feed outage must not stall every rebalance, so a pass
  // reuses the previous snapshot; only a cold start with no snapshot at all fails closed.
  private lastTokenFlags: ReadonlyMap<Address, TokenFlags> | undefined;

  constructor(
    private readonly dangerDetector: DangerDetector,
    private readonly kaminoManager: KaminoManager,
    private readonly c: ConnectionPool,
    private readonly allocationAdmin: KeyPairSigner,
    deps: DangerCoordinatorDeps = {}
  ) {
    this.respond = deps.respond ?? executeDangerResponse;
    this.fetchPrices = deps.fetchPrices ?? getTokensBatchPrice;
    this.fetchTokenFlags = deps.fetchTokenFlags ?? fetchTokenFlags;
    this.marketPriceMaxAgeSeconds = deps.marketPriceMaxAgeSeconds ?? DEFAULT_MARKET_PRICE_MAX_AGE_SECONDS;
  }

  /**
   * Token flags for this pass, falling back to the previous snapshot when the feed is unreachable.
   * Throws when there is no snapshot to fall back to: without flags the peg check silently applies to
   * nothing, which would read as "no token has a peg" rather than "the feed is down".
   */
  private async loadTokenFlags(): Promise<ReadonlyMap<Address, TokenFlags>> {
    try {
      const flags = await this.fetchTokenFlags();
      this.lastTokenFlags = flags;
      return flags;
    } catch (error) {
      if (!this.lastTokenFlags) {
        throw new Error(`[danger-coordinator] token flags unavailable and no previous snapshot: ${error}`, {
          cause: error,
        });
      }
      logger.error(
        `[danger-coordinator] token flags fetch failed, reusing the previous snapshot of ${this.lastTokenFlags.size} token(s): ${error}`
      );
      return this.lastTokenFlags;
    }
  }

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
  async detectAndRespond(
    allocationsConfig: AllocationsConfig,
    kaminoVaultsMap: Map<Address, KaminoVault>,
    vaultsReservesMap: Map<Address, KaminoReserve>,
    vaultsReserves: Map<Address, KaminoReserve>,
    dryRun: boolean = false,
    heartbeat?: () => void
  ): Promise<DangerAssessmentResult> {
    const blacklistedReserves = this.dangerDetector.getBlacklistedReserves();
    if (blacklistedReserves.size > 0) {
      logger.warn(
        `[danger-coordinator] ${blacklistedReserves.size} reserve(s) currently blacklisted: ${Array.from(blacklistedReserves).join(', ')}`
      );
    }

    // Advance reinvest cooldowns once per pass; the returned set is barred from new allocation this
    // pass (transient dampening, separate from the permanent blacklist).
    const cooldownReserves = this.dangerDetector.tickReinvestCooldowns();
    if (cooldownReserves.size > 0) {
      logger.warn(
        `[danger-coordinator] ${cooldownReserves.size} reserve(s) in reinvest cooldown: ${Array.from(cooldownReserves).join(', ')}`
      );
    }
    // Directive for every vault NOT responded to this pass. It references the blacklist/cooldown sets
    // by identity; those grow in place as the loop below responds to catastrophic/transient reserves,
    // so by the time this pass returns every clear directive observes the same final exclusion sets.
    const clearDirective: VaultRebalanceDirective = { skip: false, blacklistedReserves, cooldownReserves };
    const directiveByVault = new Map<string, VaultRebalanceDirective>();

    // Build the trigger context once: shared on-chain state for all reserve checks this iteration.
    // Priced mints are the universe's reserve mints plus whatever extra references the triggers need
    // (e.g. the asset a pegged token is quoted against).
    const reserveMints = Array.from(
      new Set(Array.from(vaultsReservesMap.values()).map((r) => r.state.liquidity.mintPubkey))
    );
    const tokenFlags = await this.loadTokenFlags();
    const pricedMints = new Set([
      ...reserveMints,
      ...this.dangerDetector.getPriceReferenceMints(reserveMints, tokenFlags),
    ]);
    const dangerContext: TriggerContext = {
      currentSlot: await this.kaminoManager.getRpc().getSlot().send(),
      marketPrices: await this.fetchPrices(Array.from(pricedMints), {
        requireAll: true,
        maxAgeSeconds: this.marketPriceMaxAgeSeconds,
      }),
      tokenFlags,
      deferObservationCommit: true,
    };

    // Compute the intrinsic risk profile for each reserve once, then reuse it for every vault below.
    const reserveAssessments = await this.dangerDetector.assessAllReserves(
      this.c.getRpc() as Rpc<SolanaRpcApi>,
      vaultsReservesMap,
      dangerContext
    );
    // All staged observations are safe to commit unless a catastrophic result is only observed in a
    // dry-run vault. A live catastrophic result is removed after addToBlacklist durably persists it.
    const observationsToCommit = new Set(Array.from(vaultsReservesMap.keys(), (reserve) => reserve.toString()));

    // For each vault, compare its reserves' risk profiles against the allocation's risk appetite
    for (const allocation of allocationsConfig.allocationsConfig) {
      const riskAppetite = getRiskAppetiteMode(allocation);
      for (const vaultEntry of allocation.vaults) {
        heartbeat?.();
        const vaultAddress = getVaultAddress(vaultEntry);
        const kaminoVault = kaminoVaultsMap.get(address(vaultAddress));
        if (!kaminoVault) continue;

        // A vault marked dry-run (globally, or at its allocation/vault level) must never receive real
        // emergency transactions — detect and log only.
        const effectiveDryRun = dryRun || getAllocationDryRun(allocation, vaultEntry);

        const vaultState = await kaminoVault.getState();
        const vaultHoldings = await this.kaminoManager.getVaultHoldings(
          vaultState,
          dangerContext.currentSlot,
          vaultsReserves,
          dangerContext.currentSlot
        );
        const pendingEvacuations = this.dangerDetector.getPendingEvacuationReserves(vaultAddress);

        const dangerousAssessments = await this.dangerDetector.filterDangerousReservesForVault(
          this.c.getRpc() as Rpc<SolanaRpcApi>,
          vaultsReservesMap,
          reserveAssessments,
          vaultHoldings.investedInReserves,
          riskAppetite,
          dangerContext,
          getMaxVaultDominanceBps(allocation, vaultEntry)
        );
        const catastrophicAddresses = dangerousAssessments
          .filter((assessment) => assessment.triggerResults.some((result) => result.catastrophic))
          .map((assessment) => assessment.reserveAddress.toString());
        for (const reserveAddress of catastrophicAddresses) {
          // A dry-run observation must remain staged until a live vault durably blacklists the same
          // globally-catastrophic reserve. Once persisted, later dry-run vaults must not undo that
          // commit decision merely because vault iteration order differs.
          if (!blacklistedReserves.has(reserveAddress)) {
            observationsToCommit.delete(reserveAddress);
          }
        }

        if (dangerousAssessments.length > 0 && !effectiveDryRun) {
          // Live danger: respond and mark this vault skip — the loop must not rebalance (re-expose) it.
          // Emitting no rebalance sets for it makes that a compile-time guarantee (see the union type).
          directiveByVault.set(vaultAddress, { skip: true });

          // Catastrophic reserves are permanently blacklisted; transient ones get a reinvest cooldown
          // so a flapping reserve does not thrash pull-out → reinvest → pull-out.
          const newlyBlacklisted = this.dangerDetector.addToBlacklist(dangerousAssessments);
          for (const reserve of newlyBlacklisted) {
            blacklistedReserves.add(reserve);
          }
          // addToBlacklist completed atomically. Existing and newly-added catastrophic entries are
          // now durable, so their staged one-shot observations may become the next baseline.
          for (const reserveAddress of catastrophicAddresses) {
            observationsToCommit.add(reserveAddress);
          }
          for (const assessment of dangerousAssessments) {
            const reserve = assessment.reserveAddress.toString();
            const isCatastrophic = assessment.triggerResults.some((r) => r.catastrophic);
            if (!isCatastrophic) {
              this.dangerDetector.recordReinvestCooldown(reserve);
              cooldownReserves.add(reserve);
            }
          }
          for (const reserve of this.dangerDetector.addPendingEvacuations(vaultAddress, dangerousAssessments)) {
            pendingEvacuations.add(reserve);
          }

          const dangerousAddresses = new Set([
            ...blacklistedReserves,
            ...pendingEvacuations,
            ...dangerousAssessments.map((a) => a.reserveAddress.toString()),
          ]);

          try {
            await this.respond(
              dangerousAddresses,
              this.kaminoManager,
              kaminoVault,
              vaultsReservesMap,
              this.allocationAdmin,
              this.c
            );
            await this.clearCompletedPendingEvacuations(
              vaultAddress,
              kaminoVault,
              pendingEvacuations,
              vaultsReserves,
              dangerContext.currentSlot
            );
          } catch (e) {
            logger.error(`[danger-coordinator] error executing danger response for vault ${vaultAddress}: ${e}`);
          }
          continue;
        }

        if (pendingEvacuations.size > 0 && !effectiveDryRun) {
          directiveByVault.set(vaultAddress, { skip: true });
          const reservesToEvacuate = new Set([...blacklistedReserves, ...pendingEvacuations]);
          try {
            await this.respond(
              reservesToEvacuate,
              this.kaminoManager,
              kaminoVault,
              vaultsReservesMap,
              this.allocationAdmin,
              this.c
            );
            const completedEvacuations = await this.clearCompletedPendingEvacuations(
              vaultAddress,
              kaminoVault,
              pendingEvacuations,
              vaultsReserves,
              dangerContext.currentSlot
            );
            const incompleteEvacuations = [...pendingEvacuations].filter(
              (reserve) => !completedEvacuations.has(reserve)
            );
            if (incompleteEvacuations.length > 0) {
              logger.error(
                `[danger-coordinator] vault ${vaultAddress} remains blocked by pending evacuation(s) for ${incompleteEvacuations.join(', ')}; operator intervention may be required if exposure cannot be withdrawn`
              );
            }
          } catch (e) {
            logger.error(`[danger-coordinator] error retrying pending evacuation for vault ${vaultAddress}: ${e}`);
          }
          continue;
        }

        // Not responded this pass → the loop may rebalance this vault with the final exclusion sets.
        directiveByVault.set(vaultAddress, clearDirective);

        if (dangerousAssessments.length > 0) {
          // Observe-only (global or per-vault dry-run) vault with danger: log only. It is marked clear
          // above so it never stalls other vaults; being dry-run, its rebalance emits no transactions.
          logger.warn(
            `[danger-coordinator] Dry run: would blacklist/respond to ${dangerousAssessments.length} dangerous reserve(s) for vault ${vaultAddress}`
          );
        } else if (pendingEvacuations.size > 0) {
          logger.warn(
            `[danger-coordinator] Dry run: would retry ${pendingEvacuations.size} pending evacuation(s) for vault ${vaultAddress}`
          );
        } else if (blacklistedReserves.size > 0) {
          // No new danger, but enforce zero allocation for previously blacklisted reserves — only when
          // there is actually something to enforce (this vault still holds a blacklisted reserve with a
          // nonzero weight or nonzero invested amount). Skipping the no-op case avoids the per-iteration
          // settle-sleep + invest-crank fee burn on already-exited reserves.
          if (
            !vaultHasExposureToReserves(
              this.kaminoManager,
              vaultState,
              vaultHoldings.investedInReserves,
              blacklistedReserves
            )
          ) {
            continue;
          }
          if (effectiveDryRun) {
            logger.warn(
              `[danger-coordinator] Dry run: would enforce ${blacklistedReserves.size} blacklisted reserve(s) for vault ${vaultAddress}`
            );
            continue;
          }

          try {
            await this.respond(
              blacklistedReserves,
              this.kaminoManager,
              kaminoVault,
              vaultsReservesMap,
              this.allocationAdmin,
              this.c
            );
          } catch (e) {
            logger.error(`[danger-coordinator] error enforcing blacklist for vault ${vaultAddress}: ${e}`);
          }
        }
      }
    }

    this.dangerDetector.commitObservations(observationsToCommit, vaultsReservesMap);
    return { directiveByVault };
  }

  private async clearCompletedPendingEvacuations(
    vaultAddress: string,
    kaminoVault: KaminoVault,
    pendingEvacuations: ReadonlySet<string>,
    vaultsReserves: Map<Address, KaminoReserve>,
    currentSlot: Slot
  ): Promise<ReadonlySet<string>> {
    if (pendingEvacuations.size === 0) {
      return new Set();
    }
    const refreshedState = await kaminoVault.getState();
    // The reserve map may predate the response, but completion only depends on refreshed allocation
    // weights and whether the refreshed cToken balance converts to zero versus a positive amount.
    const refreshedHoldings = await this.kaminoManager.getVaultHoldings(
      refreshedState,
      currentSlot,
      vaultsReserves,
      currentSlot
    );
    const completed = new Set<string>();
    for (const reserveAddress of pendingEvacuations) {
      if (
        !vaultHasExposureToReserves(
          this.kaminoManager,
          refreshedState,
          refreshedHoldings.investedInReserves,
          new Set([reserveAddress])
        )
      ) {
        completed.add(reserveAddress);
      }
    }
    this.dangerDetector.clearPendingEvacuations(vaultAddress, completed);
    return completed;
  }
}
