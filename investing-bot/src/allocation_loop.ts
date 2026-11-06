import { KaminoManager, KaminoReserve, KaminoVault, VaultState } from '@kamino-finance/klend-sdk';
import { address, Address, KeyPairSigner } from '@solana/kit';

import { logger } from 'kvaults-investing-bot-logger';
import { ConnectionPool } from 'kvaults-investing-bot-tx/ConnectionPool';
import { Cluster } from 'kvaults-investing-bot-tx/model';
import { loadKeypairSigner } from './libs/utils/secret.js';
import { SETTINGS } from './config/settings.js';
import {
  AllocationsConfig,
  getRebalanceFrequencySeconds,
  getVaultAddress,
  readAllocationsConfig,
} from './allocationsRebalance/rebalanceConfig.js';
import {
  checkAdminVaultTokenBalances,
  DueVault,
  FarmData,
  fetchFarmData,
  selectDueVaults,
  VaultRebalanceSchedule,
} from './allocationsRebalance/dueVaults.js';
import {
  computeVaultRebalanceIxs,
  isRebalanceDone,
  sendVaultRebalance,
} from './allocationsRebalance/vaultRebalance.js';
import { DEFAULT_GRID_SEARCH_BUDGET, GridSearchBudget } from './allocationsRebalance/utils/maxYieldOptimizers.js';
import { DangerDetector } from './danger/dangerDetector.js';
import { DangerAssessmentResult, DangerCoordinator } from './danger/dangerCoordinator.js';
import { depositFreezeVaults, reconcileDepositFreezes } from './danger/depositFreezes.js';
import { RPC_REQUEST_TIMEOUT_MS, withTimeout } from './utils/timeout.js';
import { getMissingVaultReserves, loadVaultsReservesInBatches } from './utils/vaultReserves.js';
import { attempt, interruptibleSleep, LoopHeartbeat, yieldAndBeat } from './utils/loop.js';
import { createLoopContext, KaminoManagerRefreshCoordinator, LoopContext } from './utils/loopContext.js';
import { AllocationLoopConfig, readAllocationLoopConfig } from './config/loopConfig.js';
import { isProcessShuttingDown } from './utils/shutdown.js';
import { fetchConfiguredVaults } from './utils/vaultFetch.js';
import { ReserveInvestCooldowns } from './utils/investReserves.js';
import { getInvestUtilizationCap, readInvestUtilizationCaps } from './investing/utilizationCap.js';

/** The allocation loop's settings, allocation config and key, read before the loop starts. */
export interface AllocationLoopStart {
  config: AllocationLoopConfig;
  allocationsConfig: AllocationsConfig;
  allocationAdmin: KeyPairSigner;
}

/** Reads the allocation loop's settings, config file and key. A bad value throws, so the bot stops at startup. */
export async function loadAllocationLoopStart(): Promise<AllocationLoopStart> {
  const config = readAllocationLoopConfig();
  return {
    config,
    allocationsConfig: readAllocationsConfig(config.allocationConfigPath),
    allocationAdmin: await loadKeypairSigner(SETTINGS.ALLOCATION_ADMIN_SECRET_PATH),
  };
}

export async function runAllocationLoop(
  cluster: Cluster,
  heartbeat?: LoopHeartbeat,
  onNoNewFundsReserves?: (reserves: string[]) => void
) {
  logger.info('[allocation-rebalance-loop] ✅ running allocation loop');
  const { config, allocationsConfig, allocationAdmin } = await loadAllocationLoopStart();
  logger.info(`[allocation-rebalance-loop] allocationAdmin ${allocationAdmin.address.toString()}`);
  const loopContext = await createLoopContext(cluster, config);
  await runAllocationPasses({ ...loopContext, allocationsConfig, allocationAdmin, onNoNewFundsReserves }, heartbeat);
}

/** What the allocation loop runs on. Tests replace the danger coordinator and the sleep. */
export interface AllocationLoopContext extends LoopContext<AllocationLoopConfig> {
  allocationsConfig: AllocationsConfig;
  allocationAdmin: KeyPairSigner;
  dangerCoordinator?: Pick<DangerCoordinator, 'detectAndRespond' | 'updateKaminoManager'>;
  sleep?: typeof interruptibleSleep;
  /** Updates the invest loop's deposit exclusions after each successful danger pass. */
  onNoNewFundsReserves?: (reserves: string[]) => void;
}

/** Runs allocation passes, each a danger pass and then the rebalance of the due vaults, until shutdown. */
export async function runAllocationPasses(
  {
    envConfig,
    connectionPool: c,
    kaminoManager: initialKaminoManager,
    refreshKaminoManager,
    allocationsConfig,
    allocationAdmin,
    dangerCoordinator: injectedDangerCoordinator,
    sleep = interruptibleSleep,
    onNoNewFundsReserves,
  }: AllocationLoopContext,
  heartbeat?: LoopHeartbeat
) {
  const dryRun = envConfig.allocationDryRun;
  const dangerPassIntervalSeconds = envConfig.dangerPassIntervalSeconds;
  const gridSearchBudget: GridSearchBudget = {
    maxCandidates: envConfig.gridSearchMaxCandidates,
    maxMs: envConfig.gridSearchMaxMs,
    now: DEFAULT_GRID_SEARCH_BUDGET.now,
  };

  if (allocationsConfig.allocationsConfig.length === 0) {
    logger.warn('[allocation-rebalance-loop] no allocations config found');
    while (!isProcessShuttingDown()) {
      if (await sleep(60_000, heartbeat)) {
        return;
      }
    }
    return;
  }

  // The smallest rebalance frequency in the config determines how often the loop runs.
  const { vaultAddresses: allVaultsAddresses, minRebalanceFrequencySeconds: minSecondsLoopDuration } =
    summarizeAllocations(allocationsConfig);

  // for the bot all restarts will trigger a rebalance unless blocked from the chain
  const rebalanceSchedule = new VaultRebalanceSchedule(Math.min(minSecondsLoopDuration, dangerPassIntervalSeconds));
  const dangerPasses = new DangerPassTracker(Date.now, (failing) =>
    heartbeat?.(failing ? 'danger-failing' : 'danger-recovered')
  );

  const dangerCoordinator =
    injectedDangerCoordinator ??
    new DangerCoordinator(
      new DangerDetector(undefined, undefined, envConfig.blacklistPath, envConfig.reinvestCooldownSeconds * 1000),
      initialKaminoManager,
      c,
      allocationAdmin,
      {
        marketPriceMaxAgeSeconds: envConfig.marketPriceMaxAgeSeconds,
        maxStalePriceDurationSeconds: envConfig.maxStalePriceDurationSeconds,
        klendProgramId: envConfig.klendProgramId,
      }
    );
  const kaminoManagerRefreshCoordinator = new KaminoManagerRefreshCoordinator(
    initialKaminoManager,
    refreshKaminoManager,
    [dangerCoordinator]
  );
  const sleepUntilNextIteration = () => {
    const sleepMilliseconds = getAllocationPassSleepMs(
      minSecondsLoopDuration,
      dangerPassIntervalSeconds,
      kaminoManagerRefreshCoordinator.millisecondsUntilRefresh()
    );
    logger.info(`[allocation-rebalance-loop] sleeping for ${sleepMilliseconds / 1000} seconds`);
    return sleep(sleepMilliseconds, heartbeat);
  };
  let hasOperationalCheckpoint = false;
  // Own instance: this loop runs in its own worker and cannot share the investing loop's cooldowns.
  const reserveInvestCooldowns = new ReserveInvestCooldowns(
    envConfig.reserveInvestCooldownMs,
    Date.now,
    '[allocation-rebalance-loop]'
  );

  while (!isProcessShuttingDown()) {
    reserveInvestCooldowns.tick();
    await kaminoManagerRefreshCoordinator.refreshIfDue();
    const kaminoManager = kaminoManagerRefreshCoordinator.getKaminoManager();

    // Yield at start of each main loop iteration
    await yieldAndBeat(hasOperationalCheckpoint ? heartbeat : undefined);

    // batch fetch all vaults data and all reserves data. A throw here must not leave the loop: the
    // worker would restart it and rebuild the danger detector, wiping the in-memory trigger baselines.
    const idleHeartbeat = hasOperationalCheckpoint ? heartbeat : undefined;
    const kaminoVaults =
      (await attempt('[allocation-rebalance-loop] failed to fetch vaults data', () =>
        fetchConfiguredVaults(kaminoManager, allVaultsAddresses, '[allocation-rebalance-loop]', idleHeartbeat)
      )) ?? [];
    const kaminoVaultsMap = new Map<Address, KaminoVault>();
    kaminoVaults.forEach((kaminoVault) => {
      if (kaminoVault) {
        kaminoVaultsMap.set(kaminoVault.address, kaminoVault);
      }
    });
    // A vault that does not load (closed, mistyped, or an RPC miss) is skipped for this pass only; the
    // other vaults still get their danger pass and their rebalance.
    const missingVaults = allVaultsAddresses.filter((vaultAddress) => !kaminoVaultsMap.has(vaultAddress));
    if (missingVaults.length > 0) {
      logger.error(
        `[allocation-rebalance-loop] ${missingVaults.length} configured vault(s) could not be loaded and are skipped this pass: ${missingVaults.join(', ')}`
      );
    }
    if (kaminoVaultsMap.size === 0) {
      // Nothing loaded: no vault gets a danger pass, which counts as a failed one. Sleep a while and try again. Before the
      // first assessed pass this stall sends no heartbeat, so a bot that has never worked is not reported healthy.
      dangerPasses.record(undefined);
      if (await sleep(10_000, hasOperationalCheckpoint ? heartbeat : undefined)) {
        return;
      }
      continue;
    }

    // Yield after fetching vaults
    await yieldAndBeat(idleHeartbeat);

    const { vaultStates, vaultsReserves } = await loadPassReserves(
      kaminoManager,
      kaminoVaultsMap,
      idleHeartbeat,
      heartbeat
    );

    // Yield after loading reserves
    await yieldAndBeat(hasOperationalCheckpoint ? heartbeat : undefined);

    // --- DANGER DETECTION ---
    const dangerResult = await attempt(
      '[allocation-rebalance-loop] Danger detection failed; skipping rebalance this iteration',
      () =>
        withTimeout(
          dangerCoordinator.detectAndRespond(allocationsConfig, kaminoVaultsMap, vaultsReserves, dryRun, heartbeat),
          Math.max(allVaultsAddresses.length, 1) * RPC_REQUEST_TIMEOUT_MS * 4,
          '[allocation-rebalance-loop] danger detection pass'
        )
    );
    if (!dangerPasses.record(dangerResult) || dangerResult === undefined) {
      // Fail closed: a danger-pass error or timeout must NOT fall through to a normal rebalance —
      // that could re-expose a vault to an undetected danger. Skip this iteration and retry. The
      // detector is constructed outside this loop, so its in-memory trigger baselines survive; a
      // transient error does not blind the catastrophic triggers on the next pass (a full loop
      // restart would, by reconstructing the detector from scratch).
      if (await sleepUntilNextIteration()) {
        return;
      }
      continue;
    }

    // Danger is scoped per-vault via a directive map: a vault just responded-to carries skip:true and
    // exposes no rebalance sets (so it structurally cannot be rebalanced/re-exposed this pass); every
    // other vault carries the final blacklist (force-zeroed) + cooldown reserves (excluded from new
    // allocation) to rebalance with.
    const { directiveByVault } = dangerResult;
    // The first pass that assesses a vault is the checkpoint from which idle waits beat the heartbeat.
    hasOperationalCheckpoint = true;
    onNoNewFundsReserves?.(Array.from(dangerResult.noNewFundsReserves));
    // Freeze excluded reserves at current holdings to block deposits from any cranker. Restore caps after recovery.
    const staleVaults = await attempt('[allocation-rebalance-loop] error reconciling deposit freezes', () =>
      reconcileDepositFreezes({
        connectionPool: c,
        kaminoManager,
        allocationAdmin,
        blacklistPath: envConfig.blacklistPath,
        kaminoVaults: depositFreezeVaults(allocationsConfig, directiveByVault, kaminoVaultsMap, dryRun),
        noNewFundsReserves: dangerResult.noNewFundsReserves,
        vaultsReserves,
        heartbeat,
      })
    );
    // A vault whose caps changed but whose state could not be reloaded would get its old caps back from a weight update.
    for (const vaultAddress of staleVaults ?? []) {
      kaminoVaultsMap.delete(vaultAddress);
    }
    // --- END DANGER DETECTION ---

    await checkAdminVaultTokenBalances(c, allocationAdmin, vaultStates);
    const dueVaults = await selectDueVaults({
      allocationsConfig,
      directiveByVault,
      kaminoVaultsMap,
      vaultsReserves,
      kaminoManager,
      rebalanceSchedule,
      allocationAdmin: allocationAdmin.address,
      globalDryRun: dryRun,
      heartbeat,
    });

    // Prices and farm states feed only farm-reward APY, so they are read only for due vaults that count some.
    const farmVaults = dueVaults.filter((dueVault) => dueVault.farms.length > 0);
    const farmData: FarmData | undefined =
      farmVaults.length > 0
        ? await fetchFarmData(
            c,
            Array.from(new Set(farmVaults.flatMap((dueVault) => dueVault.farms))),
            Array.from(new Set(farmVaults.map((dueVault) => dueVault.tokenMint)))
          )
        : { farmToFarmStateMap: new Map(), pricesMap: new Map() };

    // Yield after fetching prices
    await yieldAndBeat(heartbeat);

    if (
      (await rebalanceDueVaults(dueVaults, {
        connectionPool: c,
        kaminoManager,
        allocationAdmin,
        vaultsReserves,
        farmData,
        envConfig,
        gridSearchBudget,
        rebalanceSchedule,
        reserveInvestCooldowns,
        heartbeat,
      })) === 'shutdown'
    ) {
      return;
    }
    const recomputedVaultApy = dueVaults.length > 0;

    // Yield before cleanup
    await yieldAndBeat(heartbeat);

    // Force garbage collection after clearing large objects
    if (global.gc) {
      global.gc();
    }

    heartbeat?.('pass-completed');
    await kaminoManagerRefreshCoordinator.completeWorkCycle(recomputedVaultApy);

    if (await sleepUntilNextIteration()) {
      return;
    }
  }
}

/** The configured vault addresses and the smallest rebalance frequency. Logs each entry's vaults and frequency. */
function summarizeAllocations(allocationsConfig: AllocationsConfig): {
  vaultAddresses: Address[];
  minRebalanceFrequencySeconds: number;
} {
  let minRebalanceFrequencySeconds = Number.MAX_VALUE;
  const vaultAddresses: Address[] = [];
  for (const allocation of allocationsConfig.allocationsConfig) {
    for (const vaultEntry of allocation.vaults) {
      vaultAddresses.push(address(getVaultAddress(vaultEntry)));
      minRebalanceFrequencySeconds = Math.min(
        minRebalanceFrequencySeconds,
        getRebalanceFrequencySeconds(allocation, vaultEntry)
      );
    }
  }
  for (const allocation of allocationsConfig.allocationsConfig) {
    logger.info(
      `[allocation-rebalance-loop] ${allocation.strategy}: ${allocation.vaults
        .map((vault) => getVaultAddress(vault))
        .join(', ')} rebalance frequency: ${getRebalanceFrequencySeconds(allocation, allocation.vaults[0])} seconds`
    );
  }
  return { vaultAddresses, minRebalanceFrequencySeconds };
}

/**
 * Reads the states and reserves of the loaded vaults. A vault with a reserve that failed to load cannot be assessed or
 * rebalanced this pass: it is removed from `kaminoVaultsMap`, which keeps it out of the danger pass and, having no
 * directive, out of the rebalance.
 */
async function loadPassReserves(
  kaminoManager: KaminoManager,
  kaminoVaultsMap: Map<Address, KaminoVault>,
  idleHeartbeat: LoopHeartbeat | undefined,
  heartbeat: LoopHeartbeat | undefined
): Promise<{ vaultStates: VaultState[]; vaultsReserves: Map<Address, KaminoReserve> }> {
  // this should not do any RPC call, the vaults are read already above but getState is async as it reads the state if not already fetched
  const vaultStates = await Promise.all(
    Array.from(kaminoVaultsMap.values()).map((kaminoVault) => kaminoVault.getState())
  );

  // Yield after processing vault states
  await yieldAndBeat(idleHeartbeat);

  // load the reserves for all vaults
  const vaultsReserves = await loadVaultsReservesInBatches(
    kaminoManager,
    vaultStates,
    '[allocation-rebalance-loop] load vault reserves',
    // Progress through the first load counts: the startup probe must not kill a slow first pass.
    heartbeat
  );
  const vaultStatesByAddress = new Map(
    Array.from(kaminoVaultsMap.keys(), (vaultAddress, index) => [vaultAddress, vaultStates[index]] as const)
  );
  for (const [vaultAddress, vaultState] of vaultStatesByAddress) {
    const missingReserves = getMissingVaultReserves(kaminoManager.getVaultReserves(vaultState), vaultsReserves);
    if (missingReserves.length > 0) {
      logger.error(
        `[allocation-rebalance-loop] skipping vault ${vaultAddress} this pass: ${missingReserves.length} reserve(s) failed to load: ${missingReserves.join(', ')}`
      );
      kaminoVaultsMap.delete(vaultAddress);
    }
  }
  return { vaultStates, vaultsReserves };
}

/** What `rebalanceDueVaults` needs besides the due vaults. */
interface DueVaultRebalanceInputs {
  connectionPool: ConnectionPool;
  kaminoManager: KaminoManager;
  allocationAdmin: KeyPairSigner;
  vaultsReserves: Map<Address, KaminoReserve>;
  farmData: FarmData | undefined;
  envConfig: AllocationLoopConfig;
  gridSearchBudget: GridSearchBudget;
  rebalanceSchedule: VaultRebalanceSchedule;
  reserveInvestCooldowns: ReserveInvestCooldowns;
  heartbeat: LoopHeartbeat | undefined;
}

/** Computes and sends each due vault's rebalance and records its outcome. Returns 'shutdown' when a shutdown starts. */
async function rebalanceDueVaults(
  dueVaults: DueVault[],
  {
    connectionPool: c,
    kaminoManager,
    allocationAdmin,
    vaultsReserves,
    farmData,
    envConfig,
    gridSearchBudget,
    rebalanceSchedule,
    reserveInvestCooldowns,
    heartbeat,
  }: DueVaultRebalanceInputs
): Promise<'shutdown' | undefined> {
  let processedVaults = 0;
  for (const dueVault of dueVaults) {
    processedVaults++;

    // Yield for each vault entry processing
    await yieldAndBeat(heartbeat);

    // Force garbage collection every 10 processed vaults to prevent memory buildup
    if (processedVaults % 10 === 0 && global.gc) {
      global.gc();
    }

    const { allocation, vaultEntry, vaultAddress, kaminoVault } = dueVault;
    const rebalance = await computeVaultRebalanceIxs({
      kaminoManager,
      kaminoVault,
      allocation,
      vaultEntry,
      allocationAdmin,
      vaultsReserves,
      directive: dueVault.directive,
      includeFarmRewards: dueVault.includeFarmRewards,
      needsFarmData: dueVault.farms.length > 0,
      farmData,
      gridSearchResolution: envConfig.gridSearchResolution,
      gridSearchBudget,
      verbose: envConfig.verbose,
      heartbeat,
    });
    if (rebalance === undefined) {
      continue;
    }
    const rebalanceFrequencySeconds = getRebalanceFrequencySeconds(allocation, vaultEntry);
    // A failed strategy still sends blacklist enforcement. Rejected limits block normal investment and remain retryable.
    const outcome = await sendVaultRebalance({
      connectionPool: c,
      kaminoManager,
      kaminoVault,
      vaultState: rebalance.vaultState,
      allocationAdmin,
      ixs: rebalance.ixs,
      investAllowed: rebalance.investAllowed,
      blacklistedReserves: dueVault.directive.blacklistedReserves,
      noNewFundsReserves: dueVault.directive.cooldownReserves,
      vaultsReserves,
      dryRun: dueVault.vaultDryRun,
      getUtilizationCap: () =>
        envConfig.allocationConfigPath
          ? readInvestUtilizationCaps(envConfig.allocationConfigPath).get(kaminoVault.address)
          : getInvestUtilizationCap(allocation, vaultEntry),
      reserveInvestCooldowns,
      heartbeat,
    });
    if (isRebalanceDone(outcome, rebalance.strategyFailed)) {
      rebalanceSchedule.recordDone(vaultAddress);
    } else {
      rebalanceSchedule.recordFailure(vaultAddress, rebalanceFrequencySeconds);
    }
    if (isProcessShuttingDown()) {
      return 'shutdown';
    }
  }
  return undefined;
}

/**
 * Milliseconds between two allocation passes: the smallest of the danger pass interval, the smallest rebalance
 * frequency, and the time until the next KaminoManager refresh when the loop refreshes it.
 */
export function getAllocationPassSleepMs(
  minRebalanceFrequencySeconds: number,
  dangerPassIntervalSeconds: number,
  millisecondsUntilRefresh: number | undefined
): number {
  const sleepMilliseconds = Math.min(minRebalanceFrequencySeconds, dangerPassIntervalSeconds) * 1000;
  return millisecondsUntilRefresh === undefined
    ? sleepMilliseconds
    : Math.min(sleepMilliseconds, millisecondsUntilRefresh);
}

/**
 * Counts consecutive failed danger passes. A pass that assesses no configured vault also counts as failed.
 */
export class DangerPassTracker {
  private consecutiveFailures = 0;
  private lastSuccessAtMs: number | undefined;
  /** The failing state last reported; undefined before the first report. */
  private reportedFailing: boolean | undefined;

  constructor(
    private readonly nowMs: () => number = Date.now,
    /**
     * Updates readiness after repeated failures and recovery, including the first success after a worker restart.
     */
    private readonly onFailingChange?: (failing: boolean) => void
  ) {}

  /** Records a pass, logs the escalation when it is due, and returns whether the pass assessed a vault. */
  record(result: DangerAssessmentResult | undefined): boolean {
    if (result !== undefined && result.directiveByVault.size > 0) {
      this.consecutiveFailures = 0;
      this.lastSuccessAtMs = this.nowMs();
      this.report(false);
      return true;
    }
    this.consecutiveFailures++;
    const escalation = describeDangerPassFailures(this.consecutiveFailures, this.lastSuccessAtMs, this.nowMs());
    if (escalation !== undefined) {
      logger.error(escalation);
      this.report(true);
    }
    return false;
  }

  private report(failing: boolean): void {
    if (this.reportedFailing === failing) return;
    this.reportedFailing = failing;
    this.onFailingChange?.(failing);
  }
}

/** Failed danger passes in a row from which the loop logs an escalation on every further failure. */
export const DANGER_FAILURE_ESCALATION_PASSES = 3;

/** The escalation line for failed danger passes in a row; undefined below DANGER_FAILURE_ESCALATION_PASSES. */
export function describeDangerPassFailures(
  consecutiveFailures: number,
  lastSuccessAtMs: number | undefined,
  nowMs: number
): string | undefined {
  if (consecutiveFailures < DANGER_FAILURE_ESCALATION_PASSES) {
    return undefined;
  }
  const lastSuccess =
    lastSuccessAtMs === undefined
      ? 'none has succeeded since the loop started'
      : `the last one succeeded ${Math.round((nowMs - lastSuccessAtMs) / 60_000)} min ago`;
  return `[allocation-rebalance-loop] danger detection failed ${consecutiveFailures} passes in a row; ${lastSuccess}. No vault is assessed or rebalanced until it succeeds`;
}
