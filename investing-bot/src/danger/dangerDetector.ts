import { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import { KaminoReserve } from '@kamino-finance/klend-sdk';
import { Decimal } from 'decimal.js';
import { logger } from 'kvaults-investing-bot-logger';
import { DEFAULT_BLACKLIST_PATH } from '../libs/utils/consts.js';
import { TokenFlags } from '../utils/tokenFlags.js';
import { readBlacklistFile, updateBlacklistFile } from './blacklistStore.js';
import {
  BlacklistEntry,
  DangerTrigger,
  ReserveRiskAssessment,
  RiskAppetiteMode,
  RISK_APPETITE_THRESHOLDS,
  TriggerContext,
  TriggerResult,
  VaultDangerTrigger,
  VaultTriggerContext,
} from './dangerTypes.js';
import { ExchangeRateTrigger } from './triggers/exchangeRateTrigger.js';
import { DominantDepositorTrigger } from './triggers/vaultTriggers/dominantDepositorTrigger.js';
import { ExitLiquidityTrigger } from './triggers/vaultTriggers/exitLiquidityTrigger.js';
import { InfiniteMintTrigger } from './triggers/infiniteMintTrigger.js';
import { MarketUtilizationTrigger } from './triggers/marketUtilizationTrigger.js';
import { OracleDivergenceTrigger } from './triggers/oracleDivergenceTrigger.js';
import { SecondaryDepegTrigger } from './triggers/secondaryDepegTrigger.js';
import { SupplyApySpikeTrigger } from './triggers/supplyApySpikeTrigger.js';

/**
 * Default reserve-intrinsic triggers (run once per reserve, results shared across vaults).
 */
export function getDefaultTriggers(): DangerTrigger[] {
  return [
    new InfiniteMintTrigger(),
    new ExchangeRateTrigger(),
    new SupplyApySpikeTrigger(),
    new OracleDivergenceTrigger(),
    new SecondaryDepegTrigger(),
    new MarketUtilizationTrigger(),
  ];
}

/**
 * Default vault-specific triggers (run per (vault, reserve), since the score depends
 * on the vault's exposure to that reserve).
 */
export function getDefaultVaultTriggers(): VaultDangerTrigger[] {
  return [new ExitLiquidityTrigger(), new DominantDepositorTrigger()];
}

/**
 * Fold a trigger's safety score into the running product, failing closed on a malformed score.
 * A NaN, Infinity, or out-of-range value from a (possibly future) trigger must never read as "safe":
 * `NaN < threshold` is false, so an unsanitized NaN would silently mark a reserve safe. Clamp to
 * [0, 1] and treat any non-finite value as 0 (certain danger).
 */
function combineSafetyScore(product: number, score: number): number {
  if (!Number.isFinite(score) || score <= 0) {
    return 0;
  }
  return product * Math.min(score, 1);
}

// Number of danger passes a reserve is barred from receiving new allocation after a TRANSIENT
// (non-catastrophic) pull-out, so a reserve that flaps in and out of danger settles instead of
// thrashing pull-out → reinvest → pull-out. In-memory only: a process restart clears cooldowns,
// which is acceptable (a cleared cooldown at worst permits one earlier reinvest, not a fund risk;
// catastrophic reserves use the persistent blacklist, not this).
const DEFAULT_REINVEST_COOLDOWN_PASSES = 3;

export class DangerDetector {
  private readonly triggers: DangerTrigger[];
  private readonly vaultTriggers: VaultDangerTrigger[];
  private readonly blacklistPath: string;
  private readonly reinvestCooldownPasses: number;
  // reserve address string → remaining passes during which it must not receive new allocation.
  private readonly reinvestCooldownByReserve: Map<string, number> = new Map();

  constructor(
    triggers: DangerTrigger[] = getDefaultTriggers(),
    vaultTriggers: VaultDangerTrigger[] = getDefaultVaultTriggers(),
    blacklistPath: string = DEFAULT_BLACKLIST_PATH,
    reinvestCooldownPasses: number = DEFAULT_REINVEST_COOLDOWN_PASSES
  ) {
    this.triggers = triggers;
    this.vaultTriggers = vaultTriggers;
    this.blacklistPath = blacklistPath;
    this.reinvestCooldownPasses = reinvestCooldownPasses;
  }

  /**
   * Advance all reinvest cooldowns by one pass (call once at the start of each danger pass), dropping
   * any that have elapsed. Returns the set of reserves still in cooldown AFTER the decrement — the
   * reserves that must stay excluded from the rebalance optimizer this pass.
   */
  tickReinvestCooldowns(): Set<string> {
    for (const [reserve, remaining] of this.reinvestCooldownByReserve) {
      if (remaining <= 1) {
        this.reinvestCooldownByReserve.delete(reserve);
      } else {
        this.reinvestCooldownByReserve.set(reserve, remaining - 1);
      }
    }
    return new Set(this.reinvestCooldownByReserve.keys());
  }

  /**
   * Bar a reserve from receiving new allocation for the configured number of passes after a
   * transient pull-out. Resets the window if the reserve is already cooling down (a fresh pull-out
   * restarts the clock).
   */
  recordReinvestCooldown(reserve: string): void {
    this.reinvestCooldownByReserve.set(reserve, this.reinvestCooldownPasses);
  }

  /** Reserves currently in reinvest cooldown (excluded from new allocation). */
  getReinvestCooldownReserves(): Set<string> {
    return new Set(this.reinvestCooldownByReserve.keys());
  }

  /**
   * Mints the configured triggers need priced in `TriggerContext.marketPrices` on top of the
   * universe's own reserve mints (e.g. the asset a pegged token is quoted against).
   */
  getPriceReferenceMints(reserveMints: Address[], tokenFlags?: ReadonlyMap<Address, TokenFlags>): Address[] {
    const referenceMints = new Set<Address>();
    for (const trigger of this.triggers) {
      for (const mint of trigger.priceReferenceMints?.(reserveMints, tokenFlags) ?? []) {
        referenceMints.add(mint);
      }
    }
    return Array.from(referenceMints);
  }

  /**
   * Run all reserve-intrinsic triggers on all reserves and compute combined safety per reserve.
   */
  async assessAllReserves(
    rpc: Rpc<SolanaRpcApi>,
    vaultsReservesMap: Map<Address, KaminoReserve>,
    context: TriggerContext
  ): Promise<Map<Address, ReserveRiskAssessment>> {
    const assessments = new Map<Address, ReserveRiskAssessment>();

    for (const [reserveAddress, reserve] of vaultsReservesMap) {
      const triggerResults: TriggerResult[] = [];
      for (const trigger of this.triggers) {
        const result = await trigger.check(rpc, reserveAddress, reserve, context);
        triggerResults.push(result);
      }

      const combinedSafety = triggerResults.reduce((product, r) => combineSafetyScore(product, r.safetyScore), 1.0);
      assessments.set(reserveAddress, { reserveAddress, combinedSafety, triggerResults });
    }

    return assessments;
  }

  /**
   * Commit staged observations for the selected reserves after the coordinator has completed every
   * required safety side effect. Stateless triggers do not implement commitObservation.
   */
  commitObservations(reserveAddresses: ReadonlySet<string>, reservesMap: Map<Address, KaminoReserve>): void {
    for (const [reserveAddress, reserve] of reservesMap) {
      if (!reserveAddresses.has(reserveAddress.toString())) {
        continue;
      }
      for (const trigger of this.triggers) {
        trigger.commitObservation?.(reserveAddress, reserve);
      }
    }
  }

  /**
   * For a specific vault, run vault-specific triggers on each of its reserves and combine
   * with the intrinsic assessments produced by assessAllReserves (passed in explicitly).
   * Returns dangerous reserves (combined safety below the vault's risk appetite threshold).
   */
  async filterDangerousReservesForVault(
    rpc: Rpc<SolanaRpcApi>,
    reservesMap: Map<Address, KaminoReserve>,
    reserveAssessments: Map<Address, ReserveRiskAssessment>,
    vaultInvestedInReserves: Map<Address, Decimal>,
    riskAppetite: RiskAppetiteMode,
    context: TriggerContext,
    maxVaultDominanceBps?: number
  ): Promise<ReserveRiskAssessment[]> {
    const threshold = RISK_APPETITE_THRESHOLDS[riskAppetite];
    const dangerous: ReserveRiskAssessment[] = [];

    for (const [reserveAddress, vaultInvestedInReserve] of vaultInvestedInReserves) {
      const intrinsic = reserveAssessments.get(reserveAddress);
      const reserve = reservesMap.get(reserveAddress);
      if (!intrinsic || !reserve) continue;

      // Skip vault triggers when intrinsic safety is already 0 — any score multiplied by 0 stays 0,
      // so vault triggers can't change the outcome. This avoids running vault-specific work
      // (e.g., quote fetches) on already-catastrophic reserves.
      let allTriggerResults = intrinsic.triggerResults;
      let combinedSafety = intrinsic.combinedSafety;

      if (combinedSafety > 0) {
        const vaultContext: VaultTriggerContext = {
          ...context,
          vaultInvestedInReserve,
          maxVaultDominanceBps,
        };

        const vaultTriggerResults: TriggerResult[] = [];
        for (const trigger of this.vaultTriggers) {
          const result = await trigger.check(rpc, reserveAddress, reserve, vaultContext);
          vaultTriggerResults.push(result);
        }

        allTriggerResults = [...intrinsic.triggerResults, ...vaultTriggerResults];
        combinedSafety = allTriggerResults.reduce((product, r) => combineSafetyScore(product, r.safetyScore), 1.0);
      }

      if (combinedSafety < threshold) {
        const assessment: ReserveRiskAssessment = {
          reserveAddress,
          combinedSafety,
          triggerResults: allTriggerResults,
        };
        dangerous.push(assessment);

        const triggerDetails = allTriggerResults.map((r) => `${r.triggerName}=${r.safetyScore.toFixed(2)}`).join(', ');
        logger.error(
          `[danger-detection] DANGER for reserve ${reserveAddress}: combined safety ${combinedSafety.toFixed(4)} < threshold ${threshold} (${riskAppetite}). Triggers: [${triggerDetails}]`
        );
      }
    }

    return dangerous;
  }

  /**
   * Read the blacklist file from disk. Returns the set of currently blacklisted reserve addresses.
   */
  getBlacklistedReserves(): Set<string> {
    const blacklist = readBlacklistFile(this.blacklistPath);
    return new Set(blacklist.blacklistedReserves.map((entry) => entry.reserve));
  }

  getPendingEvacuationReserves(vaultAddress?: string): Set<string> {
    const blacklist = readBlacklistFile(this.blacklistPath);
    return new Set(
      blacklist.pendingEvacuations
        .filter((entry) => vaultAddress === undefined || entry.vault === vaultAddress)
        .map((entry) => entry.reserve)
    );
  }

  addPendingEvacuations(vaultAddress: string, assessments: ReserveRiskAssessment[]): string[] {
    const newlyAdded: string[] = [];
    updateBlacklistFile(this.blacklistPath, (blacklist) => {
      const existing = new Set(blacklist.pendingEvacuations.map((entry) => `${entry.vault}:${entry.reserve}`));
      for (const assessment of assessments) {
        if (assessment.triggerResults.some((result) => result.catastrophic)) {
          continue;
        }
        const reserve = assessment.reserveAddress.toString();
        const key = `${vaultAddress}:${reserve}`;
        if (existing.has(key)) {
          continue;
        }
        const triggerSummary = assessment.triggerResults
          .map((result) => `${result.triggerName}=${result.safetyScore.toFixed(2)}: ${result.details}`)
          .join('; ');
        blacklist.pendingEvacuations.push({
          vault: vaultAddress,
          reserve,
          triggerName: assessment.triggerResults.map((result) => result.triggerName).join('+'),
          reason: `combined safety ${assessment.combinedSafety.toFixed(4)} [${triggerSummary}]`,
          timestamp: new Date().toISOString(),
        });
        existing.add(key);
        newlyAdded.push(reserve);
      }
    });
    return newlyAdded;
  }

  clearPendingEvacuations(vaultAddress: string, reserveAddresses: ReadonlySet<string>): void {
    if (reserveAddresses.size === 0) {
      return;
    }
    updateBlacklistFile(this.blacklistPath, (blacklist) => {
      blacklist.pendingEvacuations = blacklist.pendingEvacuations.filter(
        (entry) => entry.vault !== vaultAddress || !reserveAddresses.has(entry.reserve)
      );
    });
  }

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
  addToBlacklist(assessments: ReserveRiskAssessment[]): string[] {
    const newlyAdded: string[] = [];

    updateBlacklistFile(this.blacklistPath, (blacklist) => {
      const existingReserves = new Set(blacklist.blacklistedReserves.map((entry) => entry.reserve));

      for (const assessment of assessments) {
        const catastrophicResults = assessment.triggerResults.filter((r) => r.catastrophic);
        if (catastrophicResults.length === 0) {
          // Transient/appetite-dependent danger — emergency pull-out only, re-evaluated each iteration.
          continue;
        }
        const reserveKey = assessment.reserveAddress.toString();
        if (!existingReserves.has(reserveKey)) {
          const triggerSummary = assessment.triggerResults
            .map((r) => `${r.triggerName}=${r.safetyScore.toFixed(2)}: ${r.details}`)
            .join('; ');
          // Record the catastrophic trigger(s) as the cause — that is what earned the permanent entry.
          const triggerName = catastrophicResults.map((r) => r.triggerName).join('+');
          const entry: BlacklistEntry = {
            reserve: reserveKey,
            triggerName,
            reason: `combined safety ${assessment.combinedSafety.toFixed(4)} [${triggerSummary}]`,
            timestamp: new Date().toISOString(),
          };
          blacklist.blacklistedReserves.push(entry);
          existingReserves.add(reserveKey);
          newlyAdded.push(reserveKey);
          logger.error(`[danger-detection] Added reserve ${reserveKey} to blacklist: ${entry.reason}`);
        }
      }
    });

    return newlyAdded;
  }
}
