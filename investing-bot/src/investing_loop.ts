import { Decimal } from 'decimal.js';
import {
  getCurrentLedgerInstant,
  KaminoManager,
  KaminoReserve,
  KaminoVault,
  LedgerInstant,
} from '@kamino-finance/klend-sdk';
import { Address, KeyPairSigner, TransactionSigner } from '@solana/kit';
import { logger } from 'kvaults-investing-bot-logger';
import { ConnectionPool } from 'kvaults-investing-bot-tx/ConnectionPool';
import { Cluster } from 'kvaults-investing-bot-tx/model';
import { sendAndConfirmTransactionV0 } from 'kvaults-investing-bot-tx/instruction';
import { loadVaultLookupTables } from './libs/lut.js';
import { loadKeypairSigner } from './libs/utils/secret.js';
import { SETTINGS } from './config/settings.js';
import { InvestConfig, readInvestConfig } from './config/loopConfig.js';
import { getVaultTokenMints } from './libs/utils/wallet.js';
import { isProcessShuttingDown } from './utils/shutdown.js';
import { RPC_REQUEST_TIMEOUT_MS, withTimeout } from './utils/timeout.js';
import { loadVaultsReservesInBatches } from './utils/vaultReserves.js';
import { attempt, interruptibleSleep, LoopHeartbeat, yieldAndBeat } from './utils/loop.js';
import { createLoopContext, KaminoManagerRefreshCoordinator } from './utils/loopContext.js';
import { investVaultReserves, ReserveInvestCooldowns } from './utils/investReserves.js';
import { ensureInvestorTokenAccounts, fundCrankFees } from './investing/crankFunding.js';
import { decideVaultInvest, isVaultInvestDue } from './investing/investDecision.js';
import { getVaultsData, selectVaultPubkeys } from './investing/vaultSelection.js';
import { readInvestUtilizationCaps } from './investing/utilizationCap.js';

/** The invest loop's settings and key, read before the loop starts. */
export interface InvestLoopStart {
  config: InvestConfig;
  investor: KeyPairSigner;
}

/** Validates invest settings and loads the signer before startup. */
export async function loadInvestLoopStart(): Promise<InvestLoopStart> {
  const config = readInvestConfig();
  readInvestUtilizationCaps(config.allocationConfigPath);
  return { config, investor: await loadKeypairSigner(SETTINGS.INVESTOR_SECRET_PATH) };
}

export async function runInvestLoop(
  cluster: Cluster,
  { config, investor }: InvestLoopStart,
  heartbeat?: LoopHeartbeat,
  getNoNewFundsReserves?: () => ReadonlySet<string>
) {
  logger.info('✅ running investing loop');
  const {
    connectionPool: c,
    kaminoManager: initialKaminoManager,
    refreshKaminoManager,
  } = await createLoopContext(cluster, config);
  const kaminoManagerRefreshCoordinator = new KaminoManagerRefreshCoordinator(
    initialKaminoManager,
    refreshKaminoManager
  );
  await runInvestPasses(
    { envConfig: config, connectionPool: c, kaminoManagerRefreshCoordinator, investor, getNoNewFundsReserves },
    heartbeat
  );
}

export interface InvestLoopContext {
  envConfig: InvestConfig;
  connectionPool: ConnectionPool;
  kaminoManagerRefreshCoordinator: KaminoManagerRefreshCoordinator;
  investor: TransactionSigner;
  /** Deposit exclusions from this process's last successful danger pass. */
  getNoNewFundsReserves?: () => ReadonlySet<string>;
}

/** Runs invest passes until shutdown, with the context that runInvestLoop reads from the environment. */
export async function runInvestPasses(
  { envConfig, connectionPool: c, kaminoManagerRefreshCoordinator, investor, getNoNewFundsReserves }: InvestLoopContext,
  heartbeat?: LoopHeartbeat
) {
  logger.info(`[investing-loop] investor ${investor.address.toString()}`);
  // Reserves whose invest ix failed on-chain are dropped from invests for a while instead of being
  // retried every loop (e.g. a reserve whose refresh is rejected while its oracle is paused).
  const reserveInvestCooldowns = new ReserveInvestCooldowns(envConfig.reserveInvestCooldownMs);
  // Ledger slot of the pass in which this loop last landed an invest for each vault (see isInvestDueBySlots).
  const lastSentInvestSlots = new Map<Address, Decimal>();

  const baseVaultsPubkeys: Address[] = envConfig.investVaultKeyOverrides;

  const vaultOwnersPubkeys = envConfig.investVaultOwners;

  for (;;) {
    let recomputedVaultAllocation = false;

    // Check for shutdown at the beginning of each iteration
    if (isProcessShuttingDown()) {
      logger.info('[investing-loop] Shutdown requested, exiting loop...');
      return;
    }
    await kaminoManagerRefreshCoordinator.refreshIfDue();
    const kaminoManager = kaminoManagerRefreshCoordinator.getKaminoManager();

    // reload vaults every loop as the owners may have new vaults
    const selectedVaultsPubkeys = await selectVaultPubkeys(
      baseVaultsPubkeys,
      vaultOwnersPubkeys,
      envConfig.investUIVaults
    );
    if (selectedVaultsPubkeys === undefined) {
      if (await interruptibleSleep(envConfig.loopIntervalMs, heartbeat)) {
        return;
      }
      continue;
    }
    const fetchedVaults = await attempt('[investing-loop] error fetching vaults; skipping this pass', () =>
      getVaultsData(c, selectedVaultsPubkeys, vaultOwnersPubkeys, kaminoManager, heartbeat)
    );
    if (fetchedVaults === undefined) {
      if (await interruptibleSleep(envConfig.loopIntervalMs, heartbeat)) {
        return;
      }
      continue;
    }
    const vaults = fetchedVaults;
    heartbeat?.();

    // 1. ensure the investor has token account for all tokens of the vaults
    const vaultsStates = vaults.map((vault) => vault.state!);
    const vaultTokenMints = getVaultTokenMints(vaultsStates);
    await ensureInvestorTokenAccounts(c, investor, vaultTokenMints, heartbeat);

    // 2. Ensure the investor has enough base units of each vault token to pay invest-crank fees.
    if ((await fundCrankFees(c, investor, envConfig, vaults, vaultTokenMints, heartbeat)) === 'shutdown') {
      return;
    }

    // Check invest delays before loading reserves. The movement threshold is checked after reserves load.
    const currentLedgerInstant = await attempt(
      '[investing-loop] error reading the current ledger instant; skipping this pass',
      () =>
        withTimeout(
          getCurrentLedgerInstant(c.getRpc()),
          RPC_REQUEST_TIMEOUT_MS,
          '[investing-loop] get current ledger instant'
        )
    );
    if (currentLedgerInstant === undefined) {
      // A restart would also clear the in-memory cooldowns and last invest slots.
      if (await interruptibleSleep(envConfig.loopIntervalMs, heartbeat)) {
        return;
      }
      continue;
    }
    heartbeat?.();
    const dueVaults = vaults.filter((vault) =>
      isVaultInvestDue(vault, {
        kaminoManager,
        currentLedgerInstant,
        lastSentInvestSlot: lastSentInvestSlots.get(vault.address),
        minSecondsSinceLastInvest: envConfig.minSecondsSinceLastInvest,
        bypassConfigMinSlots: envConfig.investMinSlotBypassVaults.includes(vault.address),
      })
    );

    // read the reserves states as we need them multiple times
    const vaultsReserves = await loadVaultsReservesInBatches(
      kaminoManager,
      dueVaults.map((vault) => vault.state!),
      '[investing-loop] load vault reserves',
      heartbeat
    );

    reserveInvestCooldowns.tick();

    // Yield to event loop before processing vaults
    await new Promise((resolve) => setImmediate(resolve));

    for (const vault of dueVaults) {
      // Yield to event loop for each vault processing
      await yieldAndBeat(heartbeat);
      const vaultState = vault.state!;
      const vaultReservesPubkeys = kaminoManager.getVaultReserves(vaultState);
      const decision = await decideVaultInvest(vault, vaultReservesPubkeys, {
        kaminoManager,
        blacklistPath: envConfig.blacklistPath,
        reserveInvestCooldowns,
        vaultsReserves,
        currentLedgerInstant,
        minInvestTokens: envConfig.minInvestTokens,
        // Read for each vault: a danger pass can end while an earlier vault is invested.
        noNewFundsReserves: getNoNewFundsReserves?.() ?? new Set<string>(),
      });
      if (decision.allocationComputed) {
        recomputedVaultAllocation = true;
      }

      if (decision.skip === undefined) {
        await investVault(vault, {
          connectionPool: c,
          investor,
          kaminoManager,
          currentLedgerInstant,
          reserveInvestCooldowns,
          getNoNewFundsReserves,
          vaultsReserves,
          allocationConfigPath: envConfig.allocationConfigPath,
          lastSentInvestSlots,
          heartbeat,
        });
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

export interface VaultInvestInputs {
  /** The shared allocation file is reread after the SDK reloads the vault. */
  allocationConfigPath?: string;
  connectionPool: ConnectionPool;
  investor: TransactionSigner;
  kaminoManager: KaminoManager;
  currentLedgerInstant: LedgerInstant;
  reserveInvestCooldowns: ReserveInvestCooldowns;
  /** Gets the pass's ledger slot for the vault when an invest lands (see isInvestDueBySlots). */
  lastSentInvestSlots: Map<Address, Decimal>;
  /** Deposit exclusions read after instruction construction. */
  getNoNewFundsReserves?: () => ReadonlySet<string>;
  vaultsReserves: Map<Address, KaminoReserve>;
  heartbeat?: LoopHeartbeat;
  sendTx?: typeof sendAndConfirmTransactionV0;
}

/** Sends the vault's invest instructions and records the pass slot when one lands. An error skips only this vault. */
export async function investVault(
  vault: KaminoVault,
  {
    connectionPool: c,
    investor,
    kaminoManager,
    currentLedgerInstant,
    reserveInvestCooldowns,
    lastSentInvestSlots,
    heartbeat,
    sendTx,
    getNoNewFundsReserves,
    vaultsReserves,
    allocationConfigPath,
  }: VaultInvestInputs
): Promise<void> {
  logger.info(`[investing-loop] investing in vault ${vault.address}`);
  try {
    await investVaultReserves({
      connectionPool: c,
      kaminoManager,
      payer: investor,
      kaminoVault: vault,
      ledgerInstant: currentLedgerInstant,
      lookupTables: await loadVaultLookupTables(c.getRpc(), vault.address, vault.state!, '[investing-loop]'),
      cooldowns: reserveInvestCooldowns,
      logPrefix: '[investing-loop]',
      description: `investing-loop invest in vault ${vault.address}`,
      heartbeat,
      sendTx,
      // Record each confirmed batch even if a later batch fails.
      onInvestLanded: () => lastSentInvestSlots.set(vault.address, new Decimal(currentLedgerInstant.slot.toString())),
      getNoNewFundsReserves,
      vaultsReserves,
      getUtilizationCap: allocationConfigPath
        ? () => readInvestUtilizationCaps(allocationConfigPath).get(vault.address)
        : undefined,
    });
  } catch (e) {
    // One vault's error must not abort the pass for the vaults after it.
    logger.error(`[investing-loop] error investing in vault ${vault.address}; skipping it this pass: ${e}`);
  }
}
