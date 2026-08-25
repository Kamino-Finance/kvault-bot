import { getCurrentLedgerInstant, KaminoManager, KaminoReserve, KaminoVault } from '@kamino-finance/klend-sdk';
import { address, Address, createKeyPairSignerFromBytes, IInstruction, KeyPairSigner } from '@solana/kit';

import { logger } from 'kvaults-investing-bot-logger';
import { ConnectionPool } from 'kvaults-investing-bot-tx/ConnectionPool';
import { Cluster } from 'kvaults-investing-bot-tx/model';
import { DEFAULT_PUBLIC_KEY } from 'kvaults-investing-bot-tx/instruction';
import { FarmState, fetchAllMaybeFarmState } from '@kamino-finance/farms-sdk';
import { getLut } from './libs/lut.js';
import { readSecret } from './libs/utils/secret.js';
import {
  AllocationsConfig,
  getAllocationDryRun,
  getDrippingRatePercent,
  getEnforceUtilizationCap,
  getMaxUtilizationChangeBps,
  getFixedReservesWithConfig,
  getIncludeReservesSupplyFarmRewardsApy,
  getRebalanceFrequencySeconds,
  getReserveAddresses,
  getReserveWeights,
  getVaultAddress,
  getVaultStrategy,
  printAllocationsConfig,
  readAllocationsConfig,
  ReserveWeight,
  validateConfiguredReserveMembership,
} from './allocationsRebalance/rebalanceConfig.js';
import { rebalanceAllocation, RebalanceStrategy } from './allocationsRebalance/rebalanceTypes.js';
import { buildBlacklistEnforcementIxs } from './allocationsRebalance/rebalanceUniverse.js';
import { getTokensBatchPrice } from './utils/price.js';
import { DangerDetector } from './danger/dangerDetector.js';
import { DangerAssessmentResult, DangerCoordinator } from './danger/dangerCoordinator.js';
import { RPC_REQUEST_TIMEOUT_MS, withTimeout } from './utils/timeout.js';
import { loadVaultsReservesInBatches } from './utils/vaultReserves.js';
import { interruptibleSleep, LoopHeartbeat } from './utils/loop.js';
import { createLoopContext, KaminoManagerRefreshCoordinator } from './utils/loopContext.js';
import { isProcessShuttingDown } from './utils/shutdown.js';
import { sendInstructionBatches } from './utils/sendInstructionBatches.js';

async function heartbeatSleepSeconds(seconds: number, heartbeat?: LoopHeartbeat) {
  return interruptibleSleep(seconds * 1000, heartbeat);
}

export async function runAllocationLoop(cluster: Cluster, heartbeat?: LoopHeartbeat) {
  logger.info('[allocation-rebalance-loop] ✅ running allocation loop');
  const { envConfig, connectionPool: c, kaminoManager, refreshKaminoManager } = await createLoopContext(cluster);

  const allocationsConfig: AllocationsConfig = readAllocationsConfig(envConfig.allocationConfigPath);
  printAllocationsConfig(allocationsConfig);

  const allocationAdmin = await createKeyPairSignerFromBytes(
    Buffer.from(JSON.parse(readSecret('allocation_admin', 'ALLOCATION_ADMIN_SECRET_PATH')))
  );
  logger.info(`[allocation-rebalance-loop] allocationAdmin ${allocationAdmin.address.toString()}`);
  await runAllocationRebalanceLoop(
    allocationsConfig,
    c,
    kaminoManager,
    allocationAdmin,
    envConfig.gridSearchResolution,
    envConfig.verbose,
    envConfig.allocationDryRun,
    envConfig.blacklistPath,
    envConfig.marketPriceMaxAgeSeconds,
    heartbeat,
    refreshKaminoManager
  );
}

export async function runAllocationRebalanceLoop(
  allocationsConfig: AllocationsConfig,
  c: ConnectionPool,
  initialKaminoManager: KaminoManager,
  allocationAdmin: KeyPairSigner,
  gridSearchResolution: number,
  verbose: boolean,
  dryRun: boolean,
  blacklistPath: string,
  marketPriceMaxAgeSeconds: number,
  heartbeat?: LoopHeartbeat,
  refreshKaminoManager?: () => Promise<KaminoManager>
) {
  // the min loop duration in the config which will determine how often the loop will run
  let minSecondsLoopDuration = Number.MAX_VALUE;
  const allVaultsAddresses: Address[] = [];
  // a set of all tokens relevant for all vaults in allocations, including farm rewards; will be used to fetch prices for all tokens and compute the farm APYs
  const allTokensMintsIncludingFarms: Set<Address> = new Set();
  const farmToFarmStateMap = new Map<Address, FarmState>();

  if (!allocationsConfig || !allocationsConfig.allocationsConfig || allocationsConfig.allocationsConfig.length === 0) {
    logger.warn('[allocation-rebalance-loop] no allocations config found');
    while (!isProcessShuttingDown()) {
      if (await heartbeatSleepSeconds(60, heartbeat)) {
        return;
      }
    }
    return;
  } else {
    // for the bot all restarts will trigger a rebalance unless blocked from the chain
    const lastRebalanceTimestampInSecondsPerVault = new Map<string, number>();
    allocationsConfig.allocationsConfig.forEach((allocation) => {
      allocation.vaults.forEach((vaultEntry) => {
        // Handle both string vault addresses and complex vault objects
        const vaultAddress = getVaultAddress(vaultEntry);

        allVaultsAddresses.push(address(vaultAddress));
        lastRebalanceTimestampInSecondsPerVault.set(vaultAddress, 0);

        const rebalanceFrequencySeconds = getRebalanceFrequencySeconds(allocation, vaultEntry);
        if (rebalanceFrequencySeconds < minSecondsLoopDuration) {
          minSecondsLoopDuration = rebalanceFrequencySeconds;
        }
      });
    });

    // print the vaults to alloc and the rebalance frequency
    allocationsConfig.allocationsConfig.forEach((allocation) => {
      logger.info(
        `[allocation-rebalance-loop] ${allocation.strategy}: ${allocation.vaults
          .map((vault) => getVaultAddress(vault))
          .join(', ')} rebalance frequency: ${getRebalanceFrequencySeconds(allocation, allocation.vaults[0])} seconds`
      );
    });

    const dangerDetector = new DangerDetector(undefined, undefined, blacklistPath);
    const dangerCoordinator = new DangerCoordinator(dangerDetector, initialKaminoManager, c, allocationAdmin, {
      marketPriceMaxAgeSeconds,
    });
    const kaminoManagerRefreshCoordinator = refreshKaminoManager
      ? new KaminoManagerRefreshCoordinator(initialKaminoManager, refreshKaminoManager, [dangerCoordinator])
      : undefined;
    const sleepUntilNextIteration = () => {
      const configuredSleepMilliseconds = minSecondsLoopDuration * 1000;
      const sleepMilliseconds = kaminoManagerRefreshCoordinator
        ? Math.min(configuredSleepMilliseconds, kaminoManagerRefreshCoordinator.millisecondsUntilRefresh())
        : configuredSleepMilliseconds;
      logger.info(`[allocation-rebalance-loop] sleeping for ${sleepMilliseconds / 1000} seconds`);
      return interruptibleSleep(sleepMilliseconds, heartbeat);
    };
    let hasOperationalCheckpoint = false;

    while (!isProcessShuttingDown()) {
      let recomputedVaultApy = false;
      await kaminoManagerRefreshCoordinator?.refreshIfDue();
      const kaminoManager = kaminoManagerRefreshCoordinator?.getKaminoManager() ?? initialKaminoManager;

      // Yield at start of each main loop iteration
      await new Promise((resolve) => setImmediate(resolve));
      if (hasOperationalCheckpoint) {
        heartbeat?.();
      }

      // batch fetch all vaults data and all reserves data
      const kaminoVaults = await withTimeout(
        kaminoManager.getVaults(allVaultsAddresses),
        RPC_REQUEST_TIMEOUT_MS,
        '[allocation-rebalance-loop] fetch vaults'
      );
      if (!kaminoVaults.every((kaminoVault) => kaminoVault !== null)) {
        logger.error('[allocation-rebalance-loop] failed to fetch all vaults data');

        // if we can't fetch the vaults we sleep a while and try again
        if (await interruptibleSleep(10_000, heartbeat)) {
          return;
        }
        continue;
      }

      // Yield after fetching vaults
      await new Promise((resolve) => setImmediate(resolve));
      if (hasOperationalCheckpoint) {
        heartbeat?.();
      }

      const kaminoVaultsMap = new Map<Address, KaminoVault>();
      kaminoVaults.forEach((kaminoVault) => {
        if (kaminoVault) {
          kaminoVaultsMap.set(kaminoVault.address, kaminoVault);
        }
      });

      // Yield after creating vaults map
      await new Promise((resolve) => setImmediate(resolve));
      if (hasOperationalCheckpoint) {
        heartbeat?.();
      }

      // this should not do any RPC call, the vaults are read already above but getState is async as it reads the state if not already fetched
      const vaultStates = await Promise.all(kaminoVaults.map((kaminoVault) => kaminoVault!.getState()));
      // add all vault tokens to the set of all tokens relevant for APY computation
      vaultStates.forEach((vaultState) => {
        allTokensMintsIncludingFarms.add(vaultState.tokenMint);
      });

      // Yield after processing vault states
      await new Promise((resolve) => setImmediate(resolve));
      if (hasOperationalCheckpoint) {
        heartbeat?.();
      }

      // load the reserves for all vaults
      const vaultsReserves = await loadVaultsReservesInBatches(
        kaminoManager,
        vaultStates,
        '[allocation-rebalance-loop] load vault reserves',
        hasOperationalCheckpoint ? heartbeat : undefined
      );
      const vaultsReservesMap = new Map<Address, KaminoReserve>();
      vaultsReserves.forEach((vaultReserve) => {
        if (vaultReserve) {
          vaultsReservesMap.set(vaultReserve.address, vaultReserve);
        }
      });

      // Yield after loading reserves
      await new Promise((resolve) => setImmediate(resolve));
      hasOperationalCheckpoint = true;
      heartbeat?.();

      // --- DANGER DETECTION ---
      let dangerResult: DangerAssessmentResult;
      try {
        dangerResult = await withTimeout(
          dangerCoordinator.detectAndRespond(
            allocationsConfig,
            kaminoVaultsMap,
            vaultsReservesMap,
            vaultsReserves,
            dryRun,
            heartbeat
          ),
          Math.max(allVaultsAddresses.length, 1) * RPC_REQUEST_TIMEOUT_MS * 4,
          '[allocation-rebalance-loop] danger detection pass'
        );
      } catch (e) {
        // Fail closed: a danger-pass error or timeout must NOT fall through to a normal rebalance —
        // that could re-expose a vault to an undetected danger. Skip this iteration and retry. The
        // detector is constructed outside this loop, so its in-memory trigger baselines survive; a
        // transient error does not blind the catastrophic triggers on the next pass (a full loop
        // restart would, by reconstructing the detector from scratch).
        logger.error(`[allocation-rebalance-loop] Danger detection failed; skipping rebalance this iteration: ${e}`);
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
      // --- END DANGER DETECTION ---

      // iterate to all allocations and read the supply farm tokens and the farm rewards if farm APY should be considered
      let reservesSupplyFarms = new Set<Address>();
      for (const allocation of allocationsConfig.allocationsConfig) {
        const vaultEntries = allocation.vaults;
        for (const vaultEntry of vaultEntries) {
          // Yield for each vault entry to prevent blocking
          await new Promise((resolve) => setImmediate(resolve));
          heartbeat?.();
          if (getIncludeReservesSupplyFarmRewardsApy(allocation, vaultEntry)) {
            const vaultAddress = getVaultAddress(vaultEntry);
            const kaminoVault = kaminoVaultsMap.get(address(vaultAddress))!;
            const reservesInAllocStates = kaminoManager.getVaultReserves(await kaminoVault.getState());

            for (const reserve of reservesInAllocStates) {
              const reserveState = vaultsReservesMap.get(reserve);
              // this if should always be true as we loaded the reserves above
              if (reserveState) {
                const farm = reserveState.state.farmCollateral;
                if (farm !== DEFAULT_PUBLIC_KEY) {
                  reservesSupplyFarms = reservesSupplyFarms.add(farm);
                }
              }
            }
          }
        }
      }

      // Yield after processing farms
      await new Promise((resolve) => setImmediate(resolve));
      heartbeat?.();

      if (reservesSupplyFarms.size > 0) {
        const farmsList = Array.from(reservesSupplyFarms);
        const farmsStates = await withTimeout(
          fetchAllMaybeFarmState(c.getRpc(), farmsList),
          RPC_REQUEST_TIMEOUT_MS,
          '[allocation-rebalance-loop] fetch farm states'
        );
        // zip the farms states with the farms list
        farmsStates.forEach((maybeFarmState, index) => {
          if (maybeFarmState.exists) {
            farmToFarmStateMap.set(farmsList[index], maybeFarmState.data);

            // add reward tokens to the set of all tokens relevant for APY computation
            maybeFarmState.data.rewardInfos.forEach((rewardInfo) => {
              if (rewardInfo.token.mint !== DEFAULT_PUBLIC_KEY) {
                allTokensMintsIncludingFarms.add(rewardInfo.token.mint);
              }
            });
          }
        });
      }

      // Yield after processing farms
      await new Promise((resolve) => setImmediate(resolve));
      heartbeat?.();

      // read the prices for all the relevant tokens
      const pricesMap = await getTokensBatchPrice(Array.from(allTokensMintsIncludingFarms));

      // Yield after fetching prices
      await new Promise((resolve) => setImmediate(resolve));
      heartbeat?.();

      // Clear temporary arrays to save memory
      let processedVaults = 0;

      for (const allocation of allocationsConfig.allocationsConfig) {
        const vaultEntries = allocation.vaults;
        const timestampInSeconds = Math.floor(Date.now() / 1000);
        for (const vaultEntry of vaultEntries) {
          processedVaults++;

          // Yield for each vault entry processing
          await new Promise((resolve) => setImmediate(resolve));
          heartbeat?.();

          // Force garbage collection every 10 processed vaults to prevent memory buildup
          if (processedVaults % 10 === 0 && global.gc) {
            global.gc();
          }

          // Handle different vault entry types
          const vaultAddress = getVaultAddress(vaultEntry);
          const vaultStrategy = getVaultStrategy(vaultEntry, allocation.strategy);
          const shouldIncludeFarmRewards = getIncludeReservesSupplyFarmRewardsApy(allocation, vaultEntry);
          logger.info(`[allocation-rebalance-loop] processing vault ${vaultAddress.toString()}`);

          // Skip vaults the danger pass responded to (or could not assess): their directive carries no
          // rebalance sets, so the type system prevents rebalancing them below. Rebalancing a
          // just-responded vault could immediately re-expose it.
          const dangerDirective = directiveByVault.get(vaultAddress);
          if (!dangerDirective || dangerDirective.skip) {
            logger.warn(
              `[allocation-rebalance-loop] Skipping rebalance for vault ${vaultAddress} — danger response executed or vault not assessed this iteration`
            );
            continue;
          }

          let lastRebalanceTimestamp = 0;
          if (lastRebalanceTimestampInSecondsPerVault.has(vaultAddress)) {
            lastRebalanceTimestamp = lastRebalanceTimestampInSecondsPerVault.get(vaultAddress)!;
          } else {
            lastRebalanceTimestampInSecondsPerVault.set(vaultAddress, timestampInSeconds);
          }
          const rebalanceFrequencySeconds = getRebalanceFrequencySeconds(allocation, vaultEntry);
          const shouldRebalance = timestampInSeconds - lastRebalanceTimestamp > rebalanceFrequencySeconds;

          if (shouldRebalance || dryRun || getAllocationDryRun(allocation, vaultEntry)) {
            recomputedVaultApy = true;
            const kaminoVault = kaminoVaultsMap.get(address(vaultAddress))!;
            const vaultState = await kaminoVault.getState();

            // Yield before heavy rebalance operation
            await new Promise((resolve) => setImmediate(resolve));

            // Call rebalanceAllocation with the appropriate parameters based on vault type
            const currentLedgerInstant = await withTimeout(
              getCurrentLedgerInstant(kaminoManager.getRpc()),
              RPC_REQUEST_TIMEOUT_MS,
              `[allocation-rebalance-loop] get current ledger instant ${vaultAddress}`
            );

            // Extract fixed reserves weights for FIXED_WEIGHTS strategy
            let fixedReservesWeights: ReserveWeight[] | undefined;
            if (vaultStrategy === RebalanceStrategy.FIXED_WEIGHTS) {
              fixedReservesWeights = getReserveWeights(vaultEntry) || undefined;
            }
            let rebalanceIxs: IInstruction[];
            try {
              if (typeof vaultEntry !== 'string') {
                validateConfiguredReserveMembership(
                  vaultAddress,
                  getReserveAddresses(vaultEntry.fixedReserves),
                  kaminoManager.getVaultReserves(vaultState)
                );
              }
              rebalanceIxs = await rebalanceAllocation({
                kaminoManager,
                kaminoVault,
                vaultsReserves,
                strategy: vaultStrategy,
                signer: allocationAdmin,
                currentLedgerInstant,
                gridSearchResolution,
                shouldIncludeFarmRewards,
                fixedReservesConfig: getFixedReservesWithConfig(vaultEntry),
                fixedReservesWeights,
                drippingRatePercent: getDrippingRatePercent(allocation, vaultEntry),
                farmsToFarmStateMap: farmToFarmStateMap,
                pricesMap,
                verbose,
                blacklistedReserves: dangerDirective.blacklistedReserves,
                cooldownReserves: dangerDirective.cooldownReserves,
                enforceUtilizationCap: getEnforceUtilizationCap(allocation, vaultEntry),
                maxUtilizationChangeBps: getMaxUtilizationChangeBps(allocation, vaultEntry),
              });
            } catch (error) {
              logger.error(`[allocation-rebalance-loop] error computing rebalance for vault ${vaultAddress}: ${error}`);
              try {
                rebalanceIxs = await buildBlacklistEnforcementIxs(
                  kaminoManager,
                  kaminoVault,
                  vaultsReserves,
                  allocationAdmin,
                  dangerDirective.blacklistedReserves,
                  dangerDirective.cooldownReserves
                );
              } catch (enforcementError) {
                logger.error(
                  `[allocation-rebalance-loop] could not build blacklist enforcement for vault ${vaultAddress}: ${enforcementError}`
                );
                continue;
              }
              if (rebalanceIxs.length === 0) {
                continue;
              }
            }

            if (dryRun || getAllocationDryRun(allocation, vaultEntry)) {
              logger.info(`[allocation-rebalance-loop] Dry run rebalancing vault ${vaultAddress}`);
              continue;
            }

            // Yield before transaction operations
            await new Promise((resolve) => setImmediate(resolve));
            heartbeat?.();

            // batch every 2 ixs to avoid tx size limit
            try {
              logger.info(`[allocation-rebalance-loop] Send tx rebalancing vault ${vaultAddress}`);

              const luts = [];
              const hasLut = vaultState.vaultLookupTable !== DEFAULT_PUBLIC_KEY;
              if (hasLut) {
                const lutState = await withTimeout(
                  getLut(c.getRpc(), vaultState.vaultLookupTable),
                  RPC_REQUEST_TIMEOUT_MS,
                  `[allocation-rebalance-loop] get lut ${vaultState.vaultLookupTable}`
                );
                luts.push(lutState);
              }
              const batchSize = 2;
              await sendInstructionBatches({
                connectionPool: c,
                payer: allocationAdmin,
                instructions: rebalanceIxs,
                lookupTables: luts,
                signers: [allocationAdmin],
                description: `allocation-rebalance-loop update weight allocation vault ${vaultAddress}`,
                batchSize,
                options: { reportSample: true },
                heartbeat,
              });
              // Update the last rebalance timestamp after successful rebalance
              lastRebalanceTimestampInSecondsPerVault.set(vaultAddress, timestampInSeconds);

              // after we updated the allocation we need to invest so the assets are matching the allocation
              if (await heartbeatSleepSeconds(5, heartbeat)) {
                return;
              }
              await withTimeout(
                kaminoVault.reloadState(),
                RPC_REQUEST_TIMEOUT_MS,
                `[allocation-rebalance-loop] reload vault ${vaultAddress}`
              );
              const investLedgerInstant = await withTimeout(
                getCurrentLedgerInstant(kaminoManager.getRpc()),
                RPC_REQUEST_TIMEOUT_MS,
                `[allocation-rebalance-loop] get invest ledger instant ${vaultAddress}`
              );
              const investIxs = await withTimeout(
                kaminoManager.investAllReservesIxs(allocationAdmin, kaminoVault, investLedgerInstant),
                RPC_REQUEST_TIMEOUT_MS,
                `[allocation-rebalance-loop] build invest instructions ${vaultAddress}`
              );
              await sendInstructionBatches({
                connectionPool: c,
                payer: allocationAdmin,
                instructions: investIxs,
                lookupTables: luts,
                signers: [allocationAdmin],
                description: `allocation-rebalance-loop invest after weight update vault ${vaultAddress}`,
                batchSize,
                options: { reportSample: true },
                heartbeat,
              });
            } catch (e) {
              logger.error(`[allocation-rebalance-loop] error rebalancing vault ${vaultAddress}: ${e}`);
              continue;
            }
          }
        }
      }

      // Yield before cleanup
      await new Promise((resolve) => setImmediate(resolve));
      heartbeat?.();

      // Clear memory-intensive objects before sleeping to prevent memory leaks
      allTokensMintsIncludingFarms.clear();
      farmToFarmStateMap.clear();

      // Force garbage collection after clearing large objects
      if (global.gc) {
        global.gc();
      }

      await kaminoManagerRefreshCoordinator?.completeWorkCycle(recomputedVaultApy);

      if (await sleepUntilNextIteration()) {
        return;
      }
    }
  }
}
