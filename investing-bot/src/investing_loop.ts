import { Decimal } from 'decimal.js';
import {
  getAtasWithCreateIxsIfMissing,
  getCurrentLedgerInstant,
  KaminoManager,
  KaminoVault,
  lamportsToDecimal,
} from '@kamino-finance/klend-sdk';
import { Address, createKeyPairSignerFromBytes, lamports } from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { logger } from 'kvaults-investing-bot-logger';
import { ConnectionPool } from 'kvaults-investing-bot-tx/ConnectionPool';
import { Cluster } from 'kvaults-investing-bot-tx/model';
import { DEFAULT_PUBLIC_KEY, WRAPPED_SOL_MINT } from 'kvaults-investing-bot-tx/instruction';
import { SwapMode, wrapOrSwap } from './libs/actions/swap.js';
import { getLut } from './libs/lut.js';
import { readSecret } from './libs/utils/secret.js';
import { getWalletBalances, MintWithDecimalsAndTokenProgram } from './libs/utils/wallet.js';
import { getAllUIEnabledVaults } from './libs/utils/kaminoResources.js';
import { KSwapConfig, KSwapWrapper } from './services/kSwapWrapper.js';
import { wrapSol } from './libs/rebalanceWallet.js';
import { getAssociatedTokenAddress } from './libs/tokenOperations.js';
import { DangerDetector } from './danger/dangerDetector.js';
import { isProcessShuttingDown } from './utils/shutdown.js';
import { RPC_REQUEST_TIMEOUT_MS, withTimeout } from './utils/timeout.js';
import { loadVaultsReservesInBatches } from './utils/vaultReserves.js';
import { getTokensBatchPrice } from './utils/price.js';
import { interruptibleSleep, LoopHeartbeat } from './utils/loop.js';
import { createLoopContext, KaminoManagerRefreshCoordinator } from './utils/loopContext.js';
import { sendInstructionBatches } from './utils/sendInstructionBatches.js';
import { shouldBlockVaultInvestmentForDanger } from './danger/vaultExposure.js';
import { getMinimumSlotsForDurationSeconds } from './utils/solanaUtils.js';

const VAULT_FETCH_BATCH_SIZE = 25;
const CONFIG_MIN_SLOT_BYPASS_VAULT = '4TwKA9JXEGeLEpAPLoarhSQoQwoiu12dkDCjSuVvHQUf';
export async function runInvestLoop(cluster: Cluster, heartbeat?: LoopHeartbeat) {
  logger.info('✅ running investing loop');
  const {
    envConfig,
    connectionPool: c,
    kaminoManager: initialKaminoManager,
    refreshKaminoManager,
  } = await createLoopContext(cluster);
  const kaminoManagerRefreshCoordinator = new KaminoManagerRefreshCoordinator(
    initialKaminoManager,
    refreshKaminoManager
  );

  const investor = await createKeyPairSignerFromBytes(
    Buffer.from(JSON.parse(readSecret('investor_keypair', 'INVESTOR_SECRET_PATH')))
  );
  logger.info(`[investing-loop] investor ${investor.address.toString()}`);
  // Instantiate detector for blacklist reads only (triggers run in the allocation loop).
  const dangerDetector = new DangerDetector([], [], envConfig.blacklistPath);

  const baseVaultsPubkeys: Address[] = envConfig.investVaultKeyOverrides;

  let vaults: KaminoVault[] = [];
  const vaultOwnersPubkeys = envConfig.investVaultOwners;

  for (let i = 0; ; i += 1) {
    let recomputedVaultAllocation = false;

    // Check for shutdown at the beginning of each iteration
    if (isProcessShuttingDown()) {
      logger.info('[investing-loop] Shutdown requested, exiting loop...');
      return;
    }
    await kaminoManagerRefreshCoordinator.refreshIfDue();
    const kaminoManager = kaminoManagerRefreshCoordinator.getKaminoManager();

    // reload vaults every loop as the owners may have new vaults
    let vaultsPubkeys = [...baseVaultsPubkeys];
    if (envConfig.investUIVaults) {
      const uiEnabledVaults = await getAllUIEnabledVaults();
      vaultsPubkeys = [...vaultsPubkeys, ...uiEnabledVaults];
    }
    vaultsPubkeys = uniqueAddresses(vaultsPubkeys);
    vaults = await getVaultsData(c, vaultsPubkeys, vaultOwnersPubkeys, kaminoManager);
    heartbeat?.();

    // 1. ensure the investor has token account for all tokens of the vaults
    const tokenMintsWithProgramAndDecimalsMap = new Map<Address, { program: Address; decimals: number }>();
    const tokensToVaultsCount = new Map<Address, number>(); // for a token mint how many vaults we have with that mint
    vaults.forEach((vault) => {
      const tokenProgram = vault.state!.tokenProgram;
      const tokenMint = vault.state!.tokenMint;
      if (!tokenMintsWithProgramAndDecimalsMap.has(tokenMint)) {
        tokenMintsWithProgramAndDecimalsMap.set(tokenMint, {
          program: tokenProgram,
          decimals: vault.state!.tokenMintDecimals.toNumber(),
        });
      }

      if (!tokensToVaultsCount.has(tokenMint)) {
        tokensToVaultsCount.set(tokenMint, 1);
      } else {
        tokensToVaultsCount.set(tokenMint, tokensToVaultsCount.get(tokenMint)! + 1);
      }
    });

    const mintsWithDecimalsAndTokenProgram: Array<MintWithDecimalsAndTokenProgram> = Array.from(
      tokenMintsWithProgramAndDecimalsMap.entries()
    ).map(([mint, { program, decimals }]) => ({
      mint,
      tokenProgram: program,
      decimals,
    }));
    const { createAtaIxs } = await withTimeout(
      getAtasWithCreateIxsIfMissing(
        c.getRpc(),
        investor,
        mintsWithDecimalsAndTokenProgram.map(({ mint, tokenProgram }) => ({
          mint,
          tokenProgram,
        }))
      ),
      RPC_REQUEST_TIMEOUT_MS,
      '[investing-loop] get investor token accounts'
    );

    // send txs to create token accounts if missing, in batch of 4
    await sendInstructionBatches({
      connectionPool: c,
      payer: investor,
      instructions: createAtaIxs,
      lookupTables: [],
      signers: [investor],
      description: 'investing-loop create investor atas',
      batchSize: 4,
      options: { reportSample: false },
      heartbeat,
    });

    // 2. Ensure the investor has enough base units of each vault token to pay invest-crank fees.
    const kSwapWrapper = new KSwapWrapper(investor, c, envConfig.kswapApiBaseUrl, envConfig.kswapApiKey, []);
    const walletBalances = await withTimeout(
      getWalletBalances(c, mintsWithDecimalsAndTokenProgram, investor),
      RPC_REQUEST_TIMEOUT_MS,
      '[investing-loop] get wallet balances'
    );

    const nonSolFundingNeeds: Array<{ mint: Address; outputBaseUnitsNeeded: Decimal }> = [];
    let solBaseUnitsToWrap = new Decimal(0);
    for (const [mint, count] of tokensToVaultsCount.entries()) {
      const baseUnitsNeededForInvest = count * 10;

      const balance = walletBalances.liquidityBalances.find((balance) => balance.mint === mint);
      if (!balance) {
        logger.debug('[investing-loop] no balance for ', mint);
      }

      const balanceInLamports = balance ? new Decimal(balance.balanceBase.toString()) : new Decimal(0);
      const outputBaseUnitsNeeded = new Decimal(baseUnitsNeededForInvest).minus(balanceInLamports);
      if (outputBaseUnitsNeeded.lte(0)) {
        continue;
      }

      // Request at least 1,000 base units of the OUTPUT token so tiny crank-fee deficits still get a
      // viable route. This amount is not a WSOL input amount.
      const roundedOutputBaseUnitsNeeded = Decimal.max(outputBaseUnitsNeeded, new Decimal(1_000)).ceil();
      if (mint === WRAPPED_SOL_MINT) {
        solBaseUnitsToWrap = solBaseUnitsToWrap.plus(roundedOutputBaseUnitsNeeded);
      } else {
        nonSolFundingNeeds.push({ mint, outputBaseUnitsNeeded: roundedOutputBaseUnitsNeeded });
      }
    }

    if (nonSolFundingNeeds.length > 0) {
      const priceMints = [WRAPPED_SOL_MINT, ...nonSolFundingNeeds.map(({ mint }) => mint)];
      let referencePrices: Map<Address, Decimal> | undefined;
      try {
        referencePrices = await getTokensBatchPrice(priceMints, {
          requireAll: true,
          maxAgeSeconds: envConfig.marketPriceMaxAgeSeconds,
        });
      } catch (error) {
        // Funding swaps are optional housekeeping. Without a trustworthy independent price, skip
        // them and continue the invest pass with existing balances.
        logger.error(`[investing-loop] skipping crank-funding swaps: could not load fresh reference prices: ${error}`);
      }

      if (referencePrices) {
        for (const { mint, outputBaseUnitsNeeded } of nonSolFundingNeeds) {
          const outputToken = tokenMintsWithProgramAndDecimalsMap.get(mint)!;
          const swapConfig: KSwapConfig = {
            swapMode: SwapMode.ExactOut,
            slippageBps: envConfig.defaultSwapSlippageBps,
            wrapAndUnwrapSol: true,
            filterFailedSimulations: true,
            priceGuard: {
              inputTokenPriceUsd: referencePrices.get(WRAPPED_SOL_MINT)!,
              outputTokenPriceUsd: referencePrices.get(mint)!,
              inputTokenDecimals: 9,
              outputTokenDecimals: outputToken.decimals,
              maxSlippageBps: envConfig.defaultPriceSlippageBps,
            },
            balanceGuard: {
              inputTokenProgramOwner: TOKEN_PROGRAM_ADDRESS,
              outputTokenProgramOwner: outputToken.program,
            },
          };
          try {
            await wrapOrSwap(
              c,
              kSwapWrapper,
              investor,
              WRAPPED_SOL_MINT,
              mint,
              lamports(BigInt(outputBaseUnitsNeeded.toString())),
              swapConfig,
              [],
              'investing-loop KSwap exact-output swap for crank funds'
            );
            const shouldExit = await interruptibleSleep(10000, heartbeat);
            if (shouldExit) {
              logger.info('[investing-loop] Shutdown requested during swap delay, exiting...');
              return;
            }
          } catch (e) {
            logger.error(`[investing-loop] error swapping in ${mint.toString()}; error: ${e}`);
          }
        }
      }
    }

    if (solBaseUnitsToWrap.gt(0)) {
      const wsolAta = await getAssociatedTokenAddress(WRAPPED_SOL_MINT, investor.address);
      await wrapSol(c, investor, wsolAta, lamportsToDecimal(solBaseUnitsToWrap, 9));
    }

    // 3. For each vault check if we should invest. To do so all these conditions must be met:
    // - we have at least the min number of tokens to be invested (move into/from a reserve) as requested in the env
    // - the min requested time since previous invest has passed

    // read the reserves states as we need them multiple times
    const vaultsStates = vaults.map((vault) => vault.state!);
    const vaultsReserves = await loadVaultsReservesInBatches(
      kaminoManager,
      vaultsStates,
      '[investing-loop] load vault reserves',
      heartbeat
    );
    const currentLedgerInstant = await withTimeout(
      getCurrentLedgerInstant(c.getRpc()),
      RPC_REQUEST_TIMEOUT_MS,
      '[investing-loop] get current ledger instant'
    );
    heartbeat?.();

    // Read danger blacklist to skip vaults with compromised reserves
    const blacklistedReserves = dangerDetector.getBlacklistedReserves();

    // Yield to event loop before processing vaults
    await new Promise((resolve) => setImmediate(resolve));

    for (const vault of vaults) {
      // Yield to event loop for each vault processing
      await new Promise((resolve) => setImmediate(resolve));
      heartbeat?.();
      const vaultState = vault.state!;
      const shouldBypassConfigMinSlot = vault.address.toString() === CONFIG_MIN_SLOT_BYPASS_VAULT;
      let shouldInvestAmountBased = false;
      let shouldInvestTimeBased = false;

      const vaultReservesPubkeys = kaminoManager.getVaultReserves(vaultState);

      const vaultHoldings = await withTimeout(
        kaminoManager.getVaultHoldings(vaultState, currentLedgerInstant, vaultsReserves, currentLedgerInstant),
        RPC_REQUEST_TIMEOUT_MS,
        `[investing-loop] get vault holdings ${vault.address}`
      );
      const pendingEvacuations = dangerDetector.getPendingEvacuationReserves(vault.address.toString());
      if (
        shouldBlockVaultInvestmentForDanger(
          kaminoManager,
          vaultState,
          vaultHoldings.investedInReserves,
          blacklistedReserves,
          pendingEvacuations
        )
      ) {
        logger.warn(
          `[investing-loop] skipping vault ${vault.address}: it has a pending evacuation or remaining blacklisted exposure`
        );
        continue;
      }
      // TODO: also consider amount to remain uninvested after it is released
      const theoreticalComputedAllocation = await withTimeout(
        kaminoManager.getVaultComputedReservesAllocation(
          vaultState,
          currentLedgerInstant,
          vaultsReserves,
          currentLedgerInstant
        ),
        RPC_REQUEST_TIMEOUT_MS,
        `[investing-loop] get computed allocation ${vault.address}`
      );
      recomputedVaultAllocation = true;

      // for each reserve compute the diffTokens between holdings and theoretical allocation and sum the net diffTokens
      let totalDiffTokens = new Decimal(0);
      // if there are no reserves or all have weight 0 everything should be available
      const allAllocationsZero = Array.from(theoreticalComputedAllocation.targetReservesAllocation.values()).every(
        (allocation) => allocation.eq(0)
      );

      let shouldSkipVault = false;
      if (vaultReservesPubkeys.length === 0 || allAllocationsZero) {
        // totalDiffTokens is the total tokens that are invested as we need to disinvest everything
        totalDiffTokens = vaultHoldings.invested;
      } else {
        const availableTokens = vaultHoldings.available.sub(vaultHoldings.pendingFees);
        theoreticalComputedAllocation.targetReservesAllocation.forEach((allocation, reserve) => {
          const currentHoldingForReserveTokens = vaultHoldings.investedInReserves.get(reserve)!;
          // if it is negative we need to disinvest and invest in another reserve but as we count what we will invest (positive) we don't also count the disinvested
          const diffTokens = allocation.minus(currentHoldingForReserveTokens);
          const reserveState = vaultsReserves.get(reserve)!;
          const reserveAvailableLiquidityLamports = reserveState.getFreelyAvailableLiquidityAmount(
            currentLedgerInstant,
            0
          );
          const reserveAvailableLiquidityTokens = reserveAvailableLiquidityLamports.div(
            new Decimal(10).pow(reserveState.state.liquidity.mintDecimals.toNumber())
          );
          // if diffTokens is negative it means we need to witthdraw, but if we need to withdraw more than avaialble in the reserve this will fail and we can skip the investing if there aren't tokens available
          if (
            diffTokens.lt(0) &&
            Decimal.abs(diffTokens).gt(reserveAvailableLiquidityTokens) &&
            availableTokens.lte(envConfig.minInvestTokens)
          ) {
            shouldSkipVault = true;
            return;
          }

          // we only count positive diffs as if we were to count negative (disinvest) we would double count
          const countedDiffTokens = Decimal.max(new Decimal(0), allocation.minus(currentHoldingForReserveTokens));
          totalDiffTokens = totalDiffTokens.plus(countedDiffTokens);
        });
      }

      if (shouldSkipVault) {
        logger.info(
          `[investing-loop] skipping vault ${vault.address} as necessary tokens cannot be withdrawn from reserves and there are not enough tokens available to trigger an invest`
        );
        continue;
      }

      if (totalDiffTokens.gt(envConfig.minInvestTokens)) {
        shouldInvestAmountBased = true;
      } else {
        // if we cannot invest based on amount there is no reason to check time
        continue;
      }

      // check if we should invest based on time
      let latestInvestedSlot = new Decimal(0);
      vaultState.vaultAllocationStrategy.forEach((allocation) => {
        const allocationLastInvestSlot = new Decimal(allocation.lastInvestSlot.toString());
        if (allocationLastInvestSlot.gt(latestInvestedSlot)) {
          latestInvestedSlot = allocationLastInvestSlot;
        }
      });
      const slotsFromLastInvest = new Decimal(currentLedgerInstant.slot.toString()).minus(latestInvestedSlot);
      const configMinSlotsSinceLastInvest = getMinimumSlotsForDurationSeconds(
        envConfig.minSecondsSinceLastInvest,
        kaminoManager.recentSlotDurationMs
      );
      const vaultMinInvestDelaySlots = new Decimal(vaultState.minInvestDelaySlots.toString());

      if (slotsFromLastInvest.lessThan(configMinSlotsSinceLastInvest) && !shouldBypassConfigMinSlot) {
        continue;
      }

      if (slotsFromLastInvest.gt(vaultMinInvestDelaySlots)) {
        shouldInvestTimeBased = true;
      }

      if (shouldInvestAmountBased && shouldInvestTimeBased) {
        logger.info(`[investing-loop] investing in vault ${vault.address}`);
        const luts = [];
        if (vaultState.vaultLookupTable !== DEFAULT_PUBLIC_KEY) {
          try {
            const lut = await withTimeout(
              getLut(c.getRpc(), vaultState.vaultLookupTable),
              RPC_REQUEST_TIMEOUT_MS,
              `[investing-loop] get lut ${vaultState.vaultLookupTable}`
            );
            luts.push(lut);
          } catch (e) {
            logger.warn(`[investing-loop] error getting lut for vault ${vault.address}; error: ${e}`);
            continue;
          }
        }
        const investIxs = await withTimeout(
          kaminoManager.investAllReservesIxs(investor, vault, currentLedgerInstant),
          RPC_REQUEST_TIMEOUT_MS,
          `[investing-loop] build invest instructions ${vault.address}`
        );
        // send invest ixs in batches of 2, in the order from the sdk as we need to ensure the disinvests (if any) are done first
        try {
          await sendInstructionBatches({
            connectionPool: c,
            payer: investor,
            instructions: investIxs,
            lookupTables: luts,
            signers: [investor],
            description: `investing-loop invest in vault ${vault.address}`,
            batchSize: 2,
            options: { reportSample: true },
            heartbeat,
          });
        } catch (e) {
          logger.error(`[investing-loop] error investing in vault ${vault.address}; error: ${e}`);
          continue;
        }
      }
    }

    await kaminoManagerRefreshCoordinator.completeWorkCycle(recomputedVaultAllocation);

    // Yield to event loop before sleeping
    await new Promise((resolve) => setImmediate(resolve));

    // sleep
    const sleepMilliseconds = Math.min(
      envConfig.loopIntervalMs,
      kaminoManagerRefreshCoordinator.millisecondsUntilRefresh()
    );
    logger.info(`[investing-loop] sleeping for ${sleepMilliseconds / 1000} seconds`);
    const shouldExit = await interruptibleSleep(sleepMilliseconds, heartbeat);
    if (shouldExit) {
      logger.info('[investing-loop] Shutdown requested during loop sleep, exiting...');
      return;
    }
  }
}

async function getVaultsData(
  c: ConnectionPool,
  vaultsPubkeys: Address[],
  ownersPubkeys: Address[],
  kaminoManager: KaminoManager
): Promise<KaminoVault[]> {
  const shouldUseOverrides = vaultsPubkeys.length > 0 || ownersPubkeys.length > 0;

  let uniqueVaults: KaminoVault[] = [];

  if (shouldUseOverrides) {
    const vaults = new Map<Address, KaminoVault>();
    if (vaultsPubkeys.length > 0) {
      const uniqueVaultPubkeys = uniqueAddresses(vaultsPubkeys);
      const vaultStates = await getVaultsInBatches(kaminoManager, uniqueVaultPubkeys);
      for (const vaultState of vaultStates) {
        if (!vaultState) {
          continue;
        }
        vaults.set(vaultState.address, vaultState);
      }
    }
    if (ownersPubkeys.length > 0) {
      const vaultsPromises = [];
      for (const owner of ownersPubkeys) {
        vaultsPromises.push(kaminoManager.getAllVaultsForOwner(owner));
      }
      const vaultStates = (
        await withTimeout(
          Promise.all(vaultsPromises),
          RPC_REQUEST_TIMEOUT_MS,
          `[investing-loop] fetch vaults for ${ownersPubkeys.length} owners`
        )
      ).flat();
      for (const vaultState of vaultStates) {
        if (!vaultState) {
          continue;
        }
        vaults.set(vaultState.address, vaultState);
      }
    }
    uniqueVaults = Array.from(vaults.values());
  } else {
    uniqueVaults = await withTimeout(
      kaminoManager.getAllVaults(),
      RPC_REQUEST_TIMEOUT_MS,
      '[investing-loop] fetch all vaults'
    );
  }

  // read all states of the vaults (the states should be already loaded)
  const getStatesPromises = uniqueVaults.map((vault) => vault.getState());
  await withTimeout(Promise.all(getStatesPromises), RPC_REQUEST_TIMEOUT_MS, '[investing-loop] load vault states');
  return uniqueVaults;
}

async function getVaultsInBatches(kaminoManager: KaminoManager, vaultPubkeys: Address[]): Promise<KaminoVault[]> {
  const batches = chunks(vaultPubkeys, VAULT_FETCH_BATCH_SIZE);
  const vaults: KaminoVault[] = [];
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex];
    const vaultStates = await withTimeout(
      kaminoManager.getVaults(batch),
      RPC_REQUEST_TIMEOUT_MS,
      `[investing-loop] fetch vault batch ${batchIndex + 1}/${batches.length}`
    );

    for (let i = 0; i < batch.length; i += 1) {
      const vaultState = vaultStates[i];
      if (!vaultState) {
        continue;
      }
      vaults.push(vaultState);
    }

    await new Promise((resolve) => setImmediate(resolve));
  }

  return vaults;
}

function uniqueAddresses(addresses: Address[]): Address[] {
  const seen = new Set<string>();
  return addresses.filter((address) => {
    const key = address.toString();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function chunks<T>(items: T[], size: number): T[][] {
  if (size <= 0) {
    throw new Error('chunk size must be greater than 0');
  }

  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}
