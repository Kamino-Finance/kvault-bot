import {
  getCurrentLedgerInstant,
  KaminoManager,
  KaminoReserve,
  KaminoVault,
  LedgerInstant,
  PROGRAM_ID,
  VaultState,
} from '@kamino-finance/klend-sdk';
import { Decimal } from 'decimal.js';
import { address, Address, KeyPairSigner, Rpc, SolanaRpcApi } from '@solana/kit';
import { logger } from 'kvaults-investing-bot-logger';
import { ConnectionPool } from 'kvaults-investing-bot-tx/ConnectionPool';
import {
  AllocationConfig,
  AllocationsConfig,
  getAllocationDryRun,
  getMaxVaultDominanceBps,
  getRiskAppetiteMode,
  getVaultAddress,
} from '../allocationsRebalance/rebalanceConfig.js';
import { DEFAULT_MARKET_PRICE_MAX_AGE_SECONDS, getTokensBatchPrice } from '../utils/price.js';
import { SETTINGS } from '../config/settings.js';
import { fetchTokenFlags, TokenFlags } from '../utils/tokenFlags.js';
import { IntervalTimers, whileBeating } from '../utils/loop.js';
import { DangerDetector } from './dangerDetector.js';
import { DangerResponseDeps, executeDangerResponse } from './dangerResponse.js';
import { ReserveDeinvestFailures } from './deinvestFailures.js';
import { MarketCollateralAssessment, ReserveRiskAssessment, TriggerContext } from './dangerTypes.js';
import {
  committableMarketCollateral,
  loadMarketCollateral,
  MarketCollateralSnapshot,
  marketCollateralNoNewFunds,
  vaultReservesByMarket,
} from './marketCollateral.js';
import { fetchScopeOracleSnapshot } from './scopeOracleMonitor.js';
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
  /**
   * The reserves that get no new funds after this pass: a stale or zero Scope price, or a reinvest cooldown. The clear
   * directives carry the same set as their cooldown reserves.
   */
  readonly noNewFundsReserves: ReadonlySet<string>;
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
  fetchOracleSnapshot?: typeof fetchScopeOracleSnapshot;
  respond?: typeof executeDangerResponse;
  fetchPrices?: typeof getTokensBatchPrice;
  fetchTokenFlags?: typeof fetchTokenFlags;
  marketPriceMaxAgeSeconds?: number;
  maxStalePriceDurationSeconds?: number;
  deinvestFailures?: ReserveDeinvestFailures;
  /** Times the heartbeat while a response runs. */
  intervalTimers?: IntervalTimers;
  /** Reads the market collateral of the vault reserves. */
  loadMarketCollateral?: typeof loadMarketCollateral;
  /** The klend program that owns the markets' reserves. */
  klendProgramId?: Address;
}

/** Thrown once a newer pass has started; detectAndRespond catches it in one place and abandons the pass. */
class PassSupersededError extends Error {
  constructor(
    readonly where: string,
    readonly newerGeneration: number
  ) {
    super(`danger pass superseded at ${where}`);
  }
}

/** Per-pass state a vault response needs, including the generation that must still be current. */
interface ResponsePass {
  readonly generation: number;
  readonly responseDeps: DangerResponseDeps;
  readonly vaultsReserves: Map<Address, KaminoReserve>;
  readonly currentLedgerInstant: LedgerInstant;
  readonly heartbeat: (() => void) | undefined;
}

/** The state one danger pass shares across its vaults. The sets grow in place as the pass responds. */
interface DangerPass extends ResponsePass {
  readonly dryRun: boolean;
  readonly dangerContext: TriggerContext;
  readonly reserveAssessments: Map<Address, ReserveRiskAssessment>;
  readonly blacklistedReserves: Set<string>;
  readonly cooldownReserves: Set<string>;
  readonly clearDirective: VaultRebalanceDirective;
  readonly directiveByVault: Map<string, VaultRebalanceDirective>;
  readonly observationsToCommit: Set<string>;
  readonly assessedReserves: Set<string>;
  readonly marketCollateral: MarketCollateralSnapshot;
}

/** The two responses that evacuate a vault and then clear its completed pending evacuations. */
type EvacuatingResponseKind = 'danger' | 'evacuation';

/** Per kind: supersession points and failure log label (each suffixed with the vault), and whether to log leftovers. */
const EVACUATING_RESPONSES = {
  danger: {
    respond: 'danger response',
    cleanup: 'post-response cleanup',
    failure: 'error executing danger response',
    logIncomplete: false,
  },
  evacuation: {
    respond: 'pending evacuation',
    cleanup: 'post-evacuation cleanup',
    failure: 'error retrying pending evacuation',
    logIncomplete: true,
  },
} as const satisfies Record<
  EvacuatingResponseKind,
  { respond: string; cleanup: string; failure: string; logIncomplete: boolean }
>;

export class DangerCoordinator {
  private readonly respond: typeof executeDangerResponse;
  private readonly fetchPrices: typeof getTokensBatchPrice;
  private readonly fetchTokenFlags: typeof fetchTokenFlags;
  private readonly fetchOracleSnapshot: typeof fetchScopeOracleSnapshot;
  private readonly loadMarketCollateral: typeof loadMarketCollateral;
  private readonly klendProgramId: Address;
  private readonly marketPriceMaxAgeSeconds: number;
  private readonly maxStalePriceDurationSeconds: number;
  private readonly intervalTimers: IntervalTimers | undefined;
  private readonly deinvestFailures: ReserveDeinvestFailures;
  // Last successfully fetched token flags. A feed outage must not stall every rebalance, so a pass
  // reuses the previous snapshot; only a cold start with no snapshot at all fails closed.
  private lastTokenFlags: ReadonlyMap<Address, TokenFlags> | undefined;
  /** Incremented at the start of every pass; a pass that outlives its watchdog stops once a newer pass has started. */
  private passGeneration = 0;
  /** In-flight emergency responses by vault: a later pass must not start a second response for the same vault. */
  private readonly activeResponses = new Map<string, Promise<void>>();

  constructor(
    private readonly dangerDetector: DangerDetector,
    private kaminoManager: KaminoManager,
    private readonly c: ConnectionPool,
    private readonly allocationAdmin: KeyPairSigner,
    deps: DangerCoordinatorDeps = {}
  ) {
    this.respond = deps.respond ?? executeDangerResponse;
    this.fetchPrices = deps.fetchPrices ?? getTokensBatchPrice;
    this.fetchTokenFlags = deps.fetchTokenFlags ?? fetchTokenFlags;
    this.fetchOracleSnapshot = deps.fetchOracleSnapshot ?? fetchScopeOracleSnapshot;
    this.loadMarketCollateral = deps.loadMarketCollateral ?? loadMarketCollateral;
    this.klendProgramId = deps.klendProgramId ?? PROGRAM_ID;
    this.marketPriceMaxAgeSeconds = deps.marketPriceMaxAgeSeconds ?? DEFAULT_MARKET_PRICE_MAX_AGE_SECONDS;
    this.maxStalePriceDurationSeconds =
      deps.maxStalePriceDurationSeconds ?? SETTINGS.MAX_STALE_PRICE_DURATION_SECONDS.default;
    this.deinvestFailures = deps.deinvestFailures ?? new ReserveDeinvestFailures();
    this.intervalTimers = deps.intervalTimers;
  }

  updateKaminoManager(kaminoManager: KaminoManager): void {
    this.kaminoManager = kaminoManager;
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
   * @param vaultsReserves the reserves of the configured vaults, keyed by address
   * @param dryRun when true, detect/log danger but skip blacklist writes and response transactions
   *   for EVERY vault. It is OR-ed with each vault's own allocation/vault-level dry-run flag, so a
   *   vault configured for observation only never receives real emergency transactions.
   * @param heartbeat optional liveness callback beaten for each reserve assessed, each vault, and during each response,
   *   so the loop's readiness probe
   *   does not go stale during a long danger pass
   */
  async detectAndRespond(
    allocationsConfig: AllocationsConfig,
    kaminoVaultsMap: Map<Address, KaminoVault>,
    vaultsReserves: Map<Address, KaminoReserve>,
    dryRun: boolean = false,
    heartbeat?: () => void
  ): Promise<DangerAssessmentResult> {
    // The loop's withTimeout rejects the caller but cannot cancel this promise. Once the loop has started a
    // newer pass, this one must not mutate safety state or send anything more.
    const generation = ++this.passGeneration;
    const pass = await this.startPass(generation, vaultsReserves, dryRun, heartbeat);
    try {
      // For each vault, compare its reserves' risk profiles against the allocation's risk appetite
      for (const allocation of allocationsConfig.allocationsConfig) {
        for (const vaultEntry of allocation.vaults) {
          heartbeat?.();
          const kaminoVault = kaminoVaultsMap.get(address(getVaultAddress(vaultEntry)));
          if (!kaminoVault) continue;
          await this.assessVault(pass, allocation, vaultEntry, kaminoVault);
        }
      }
      this.commitPassObservations(pass);
    } catch (e) {
      if (!(e instanceof PassSupersededError)) throw e;
      logger.error(
        `[danger-coordinator] danger pass ${generation} outlived its watchdog and pass ${e.newerGeneration} has started; abandoning it at ${e.where}`
      );
    }
    return { directiveByVault: pass.directiveByVault, noNewFundsReserves: pass.cooldownReserves };
  }

  /** Reads the pass's exclusion sets, prices and Scope data, and scores every reserve once for all vaults. */
  private async startPass(
    generation: number,
    vaultsReserves: Map<Address, KaminoReserve>,
    dryRun: boolean,
    heartbeat: (() => void) | undefined
  ): Promise<DangerPass> {
    const isSuperseded = (): boolean => generation !== this.passGeneration;
    const responseDeps = { deinvestFailures: this.deinvestFailures, shouldAbort: isSuperseded };
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
    // by identity; those grow in place as the vaults are assessed and responded to,
    // so by the time this pass returns every clear directive observes the same final exclusion sets.
    const clearDirective: VaultRebalanceDirective = { skip: false, blacklistedReserves, cooldownReserves };

    // Build the trigger context once: shared on-chain state for all reserve checks this iteration.
    // Priced mints are the vault and collateral mints plus whatever extra references the triggers need
    // (e.g. the asset a pegged token is quoted against).
    const reserveMints = Array.from(
      new Set(Array.from(vaultsReserves.values()).map((r) => r.state.liquidity.mintPubkey))
    );
    const rpc = this.c.getRpc() as Rpc<SolanaRpcApi>;
    const marketCollateral = await this.loadMarketCollateral(
      rpc,
      vaultReservesByMarket(vaultsReserves),
      this.klendProgramId,
      heartbeat
    );
    const collateralReserves = new Map(
      Array.from(marketCollateral.collateralByMarket.values()).flatMap((collateral) => Array.from(collateral))
    );
    const tokenFlags = await this.loadTokenFlags();
    const pricedMints = new Set([
      ...reserveMints,
      ...Array.from(collateralReserves.values(), (reserve) => reserve.state.liquidity.mintPubkey),
      ...this.dangerDetector.getPriceReferenceMints(reserveMints, tokenFlags),
    ]);
    const currentLedgerInstant = await getCurrentLedgerInstant(this.kaminoManager.getRpc());
    const marketPrices = await this.fetchPrices(Array.from(pricedMints), {
      requireAll: true,
      maxAgeSeconds: this.marketPriceMaxAgeSeconds,
    });
    const oracleSnapshot = await this.fetchOracleSnapshot(
      rpc,
      new Map([...collateralReserves, ...vaultsReserves]),
      marketPrices
    );
    // Block deposits for stale, zero or near-zero Scope prices. The stale-price trigger decides whether to evacuate.
    const stalePriceReserves = Array.from(oracleSnapshot.observations)
      .filter(
        ([reserve, observation]) =>
          vaultsReserves.has(reserve) &&
          (observation.kind === 'zero' || (observation.kind === 'healthy' && observation.stale))
      )
      .map(([reserve]) => reserve.toString());
    if (stalePriceReserves.length > 0) {
      logger.warn(
        `[danger-coordinator] ${stalePriceReserves.length} reserve(s) have a stale or zero Scope price and get no new allocation this pass: ${stalePriceReserves.join(', ')}`
      );
      for (const reserve of stalePriceReserves) cooldownReserves.add(reserve);
    }
    const dangerContext: TriggerContext = {
      currentLedgerInstant,
      marketPrices,
      scopeOracleObservations: oracleSnapshot.observations,
      tokenFlags,
      observationStaging: { generation },
      maxStalePriceDurationSeconds: this.maxStalePriceDurationSeconds,
    };
    const pass: ResponsePass = {
      generation,
      responseDeps,
      vaultsReserves,
      currentLedgerInstant: dangerContext.currentLedgerInstant,
      heartbeat,
    };

    const collateralAssessments =
      collateralReserves.size > 0
        ? await this.dangerDetector.assessMarketCollateral(
            rpc,
            marketCollateral.collateralByMarket,
            dangerContext,
            heartbeat
          )
        : new Map<Address, MarketCollateralAssessment>();
    // Unreadable or broken collateral blocks deposits. Collateral trigger scores determine evacuation separately.
    const collateralNoNewFunds = marketCollateralNoNewFunds(
      marketCollateral,
      oracleSnapshot.observations,
      collateralAssessments
    );
    for (const [reserve, reason] of collateralNoNewFunds) {
      logger.warn(`[danger-coordinator] reserve ${reserve} gets no new allocation this pass: ${reason}`);
      cooldownReserves.add(reserve.toString());
    }

    // Compute the intrinsic risk profile for each reserve once, then reuse it for every vault below.
    const reserveAssessments = await this.dangerDetector.assessAllReserves(
      rpc,
      vaultsReserves,
      dangerContext,
      heartbeat,
      collateralAssessments
    );
    // All staged observations are safe to commit unless a catastrophic result is only observed in a
    // dry-run vault. A live catastrophic result is removed after addToBlacklist durably persists it.
    const observationsToCommit = new Set(Array.from(vaultsReserves.keys(), (reserve) => reserve.toString()));
    // Reserves of vaults this pass actually assessed. A reserve held only by a skipped vault keeps its
    // staged observation: a catastrophic change there has not been acted on, so its baseline must not move.
    const assessedReserves = new Set<string>();

    return {
      ...pass,
      dryRun,
      dangerContext,
      reserveAssessments,
      blacklistedReserves,
      cooldownReserves,
      clearDirective,
      directiveByVault: new Map<string, VaultRebalanceDirective>(),
      observationsToCommit,
      assessedReserves,
      marketCollateral,
    };
  }

  /** Scores one vault's reserves against its risk appetite and responds when one is dangerous or an evacuation is pending. */
  private async assessVault(
    pass: DangerPass,
    allocation: AllocationConfig,
    vaultEntry: AllocationConfig['vaults'][number],
    kaminoVault: KaminoVault
  ): Promise<void> {
    const {
      generation,
      dryRun,
      dangerContext,
      reserveAssessments,
      blacklistedReserves,
      cooldownReserves,
      clearDirective,
      directiveByVault,
      observationsToCommit,
      assessedReserves,
      vaultsReserves,
    } = pass;
    const riskAppetite = getRiskAppetiteMode(allocation);
    const vaultAddress = getVaultAddress(vaultEntry);
    this.assertPassCurrent(generation, `vault ${vaultAddress}`);
    if (this.activeResponses.has(vaultAddress)) {
      // An earlier pass's response is still sending (it outlived its watchdog). A second response would
      // double the emergency action; keep the vault out of rebalancing and try again next pass.
      logger.error(
        `[danger-coordinator] an emergency response for vault ${vaultAddress} is still in flight from an earlier pass; skipping the vault this pass`
      );
      directiveByVault.set(vaultAddress, { skip: true });
      return;
    }

    // A vault marked dry-run (globally, or at its allocation/vault level) must never receive real
    // emergency transactions — detect and log only.
    const effectiveDryRun = dryRun || getAllocationDryRun(allocation, vaultEntry);

    const vaultState = await kaminoVault.getState();
    const vaultHoldings = await this.kaminoManager.getVaultHoldings(
      vaultState,
      dangerContext.currentLedgerInstant,
      vaultsReserves,
      dangerContext.currentLedgerInstant
    );
    const pendingEvacuations = this.dangerDetector.getPendingEvacuationReserves(vaultAddress);

    const flaggedAssessments = await this.dangerDetector.filterDangerousReservesForVault(
      this.c.getRpc() as Rpc<SolanaRpcApi>,
      vaultsReserves,
      reserveAssessments,
      vaultHoldings.investedInReserves,
      riskAppetite,
      dangerContext,
      getMaxVaultDominanceBps(allocation, vaultEntry)
    );
    // A transient flag on a reserve this vault neither weights nor holds needs no response and must not
    // keep the vault in skip pass after pass. A catastrophic flag is kept regardless: the blacklist is
    // global and its one-shot observation must still be committed.
    const dangerousAssessments = flaggedAssessments.filter(
      (assessment) =>
        assessment.triggerResults.some((result) => result.catastrophic) ||
        vaultHasExposureToReserves(
          this.kaminoManager,
          vaultState,
          vaultHoldings.investedInReserves,
          new Set([assessment.reserveAddress.toString()])
        )
    );
    // No vault may put new funds into a flagged reserve while the danger lasts, so an unexposed transient flag
    // still starts the reserve's reinvest cooldown again. The cooldown sends nothing, so dry run does not matter.
    for (const assessment of flaggedAssessments) {
      if (!dangerousAssessments.includes(assessment)) {
        const reserve = assessment.reserveAddress.toString();
        this.dangerDetector.recordReinvestCooldown(reserve);
        cooldownReserves.add(reserve);
      }
    }
    for (const reserve of this.kaminoManager.getVaultReserves(vaultState)) {
      assessedReserves.add(reserve.toString());
    }
    for (const assessment of flaggedAssessments) {
      assessedReserves.add(assessment.reserveAddress.toString());
    }
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
      this.assertPassCurrent(generation, `${EVACUATING_RESPONSES.danger.respond} for vault ${vaultAddress}`);
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
      await this.respondAndClearEvacuations(
        vaultAddress,
        kaminoVault,
        dangerousAddresses,
        pendingEvacuations,
        pass,
        'danger'
      );
      return;
    }

    if (pendingEvacuations.size > 0 && !effectiveDryRun) {
      this.assertPassCurrent(generation, `${EVACUATING_RESPONSES.evacuation.respond} for vault ${vaultAddress}`);
      directiveByVault.set(vaultAddress, { skip: true });
      await this.respondAndClearEvacuations(
        vaultAddress,
        kaminoVault,
        new Set([...blacklistedReserves, ...pendingEvacuations]),
        pendingEvacuations,
        pass,
        'evacuation'
      );
      return;
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
      await this.enforceBlacklist(
        pass,
        vaultAddress,
        kaminoVault,
        vaultState,
        vaultHoldings.investedInReserves,
        effectiveDryRun
      );
    }
  }

  /**
   * No new danger, but enforce zero allocation for previously blacklisted reserves — only when there is actually
   * something to enforce (this vault still holds a blacklisted reserve with a nonzero weight or nonzero invested
   * amount). Skipping the no-op case avoids the per-iteration settle-sleep + invest-crank fee burn on already-exited
   * reserves.
   */
  private async enforceBlacklist(
    { generation, blacklistedReserves, vaultsReserves, responseDeps, heartbeat }: DangerPass,
    vaultAddress: string,
    kaminoVault: KaminoVault,
    vaultState: VaultState,
    investedInReserves: Map<Address, Decimal>,
    effectiveDryRun: boolean
  ): Promise<void> {
    if (!vaultHasExposureToReserves(this.kaminoManager, vaultState, investedInReserves, blacklistedReserves)) {
      return;
    }
    if (effectiveDryRun) {
      logger.warn(
        `[danger-coordinator] Dry run: would enforce ${blacklistedReserves.size} blacklisted reserve(s) for vault ${vaultAddress}`
      );
      return;
    }

    try {
      await this.respondExclusively(
        vaultAddress,
        generation,
        `blacklist enforcement for vault ${vaultAddress}`,
        blacklistedReserves,
        kaminoVault,
        vaultsReserves,
        responseDeps,
        heartbeat
      );
    } catch (e) {
      logUnlessSuperseded(e, `[danger-coordinator] error enforcing blacklist for vault ${vaultAddress}`);
    }
  }

  /** Commits the staged trigger observations of the reserves this pass assessed, unless a newer pass has started. */
  private commitPassObservations({
    generation,
    observationsToCommit,
    assessedReserves,
    vaultsReserves,
    marketCollateral,
  }: DangerPass): void {
    for (const reserve of observationsToCommit) {
      if (!assessedReserves.has(reserve)) observationsToCommit.delete(reserve);
    }
    this.assertPassCurrent(generation, 'observation commit');
    this.dangerDetector.commitObservations(observationsToCommit, vaultsReserves, generation);
    const collateral = committableMarketCollateral(marketCollateral, observationsToCommit);
    if (collateral.length > 0) {
      this.dangerDetector.commitMarketCollateralObservations(collateral, generation);
    }
  }

  /** Throws PassSupersededError when a newer pass has started since `generation` began. */
  private assertPassCurrent(generation: number, where: string): void {
    if (generation !== this.passGeneration) throw new PassSupersededError(where, this.passGeneration);
  }

  /**
   * Responds to `reserves` for a vault already marked skip, then clears the pending evacuations the
   * response completed. Failures are logged and swallowed; supersession propagates to detectAndRespond.
   */
  private async respondAndClearEvacuations(
    vaultAddress: string,
    kaminoVault: KaminoVault,
    reserves: Set<string>,
    pendingEvacuations: ReadonlySet<string>,
    pass: ResponsePass,
    kind: EvacuatingResponseKind
  ): Promise<void> {
    const row = EVACUATING_RESPONSES[kind];
    try {
      await this.respondExclusively(
        vaultAddress,
        pass.generation,
        `${row.respond} for vault ${vaultAddress}`,
        reserves,
        kaminoVault,
        pass.vaultsReserves,
        pass.responseDeps,
        pass.heartbeat
      );
      const completedEvacuations = await this.clearCompletedPendingEvacuations(
        vaultAddress,
        pass.generation,
        `${row.cleanup} for vault ${vaultAddress}`,
        kaminoVault,
        pendingEvacuations,
        pass.vaultsReserves,
        pass.currentLedgerInstant
      );
      if (!row.logIncomplete) return;
      const incompleteEvacuations = [...pendingEvacuations].filter((reserve) => !completedEvacuations.has(reserve));
      if (incompleteEvacuations.length > 0) {
        logger.error(
          `[danger-coordinator] vault ${vaultAddress} remains blocked by pending evacuation(s) for ${incompleteEvacuations.join(', ')}; operator intervention may be required if exposure cannot be withdrawn`
        );
      }
    } catch (e) {
      logUnlessSuperseded(e, `[danger-coordinator] ${row.failure} for vault ${vaultAddress}`);
    }
  }

  /** Runs one vault's response and keeps it registered until it settles, so passes cannot overlap it. */
  private async respondExclusively(
    vaultAddress: string,
    generation: number,
    where: string,
    reserves: Set<string>,
    kaminoVault: KaminoVault,
    vaultsReserves: Map<Address, KaminoReserve>,
    deps: DangerResponseDeps,
    heartbeat: (() => void) | undefined
  ): Promise<void> {
    this.assertPassCurrent(generation, where);
    // Emergency confirmation and reloads can exceed the heartbeat timeout.
    const response = whileBeating(
      heartbeat,
      () => this.respond(reserves, this.kaminoManager, kaminoVault, vaultsReserves, this.allocationAdmin, this.c, deps),
      this.intervalTimers
    ).finally(() => {
      if (this.activeResponses.get(vaultAddress) === response) this.activeResponses.delete(vaultAddress);
    });
    this.activeResponses.set(vaultAddress, response);
    await response;
  }

  private async clearCompletedPendingEvacuations(
    vaultAddress: string,
    generation: number,
    where: string,
    kaminoVault: KaminoVault,
    pendingEvacuations: ReadonlySet<string>,
    vaultsReserves: Map<Address, KaminoReserve>,
    currentLedgerInstant: LedgerInstant
  ): Promise<ReadonlySet<string>> {
    this.assertPassCurrent(generation, where);
    if (pendingEvacuations.size === 0) {
      return new Set();
    }
    const refreshedState = await kaminoVault.getState();
    // The reserve map may predate the response, but completion only depends on refreshed allocation
    // weights and whether the refreshed cToken balance converts to zero versus a positive amount.
    const refreshedHoldings = await this.kaminoManager.getVaultHoldings(
      refreshedState,
      currentLedgerInstant,
      vaultsReserves,
      currentLedgerInstant
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
    // The refresh above awaited; a pass superseded meanwhile must not clear anything.
    this.assertPassCurrent(generation, where);
    this.dangerDetector.clearPendingEvacuations(vaultAddress, completed);
    return completed;
  }
}

/** Logs a per-vault response failure and keeps the pass going; a superseded pass propagates instead. */
function logUnlessSuperseded(error: unknown, message: string): void {
  if (error instanceof PassSupersededError) throw error;
  logger.error(`${message}: ${error}`);
}
