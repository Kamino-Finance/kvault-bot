import { Decimal } from 'decimal.js';
import {
  getCurrentLedgerInstant,
  KaminoManager,
  KaminoReserve,
  KaminoVault,
  LedgerInstant,
  numberToLamportsDecimal,
} from '@kamino-finance/klend-sdk';
import { address, Address, TransactionSigner } from '@solana/kit';
import { logger } from 'kvaults-investing-bot-logger';
import { ConnectionPool } from 'kvaults-investing-bot-tx/ConnectionPool';
import { sendAndConfirmTransactionV0 } from 'kvaults-investing-bot-tx/instruction';
import { AllocationsConfig, getAllocationDryRun, getVaultAddress } from '../allocationsRebalance/rebalanceConfig.js';
import { buildCapUpdateIx } from '../allocationsRebalance/vaultUtils.js';
import { loadVaultLookupTables, withVaultLookupTableRecovery } from '../libs/lut.js';
import { LoopHeartbeat, whileBeating } from '../utils/loop.js';
import { RPC_REQUEST_TIMEOUT_MS, withTimeout } from '../utils/timeout.js';
import type { VaultRebalanceDirective } from './dangerCoordinator.js';
import { readBlacklistFile, updateBlacklistFile } from './blacklistStore.js';
import { DepositFreezeEntry } from './dangerTypes.js';

/**
 * Deposit freezes cap excluded reserves at current holdings, blocking deposits from any cranker while preserving weights.
 */

export interface DepositFreezeRequest {
  connectionPool: ConnectionPool;
  kaminoManager: KaminoManager;
  allocationAdmin: TransactionSigner;
  blacklistPath: string;
  /** The vaults the pass may send to: a clear danger directive and no dry run. */
  kaminoVaults: KaminoVault[];
  noNewFundsReserves: ReadonlySet<string>;
  vaultsReserves: Map<Address, KaminoReserve>;
  heartbeat?: LoopHeartbeat;
  sendTx?: typeof sendAndConfirmTransactionV0;
  nowIso?: () => string;
}

/**
 * Freezes excluded reserves, lowers frozen caps as holdings fall, and restores caps after recovery.
 * Saves original caps before sending and removes records only after confirmed restoration. Preserves operator cap increases.
 * Reloads changed vaults. Returns vaults whose reload failed, which must skip rebalancing. Failures affect only that vault.
 */
export async function reconcileDepositFreezes(request: DepositFreezeRequest): Promise<Address[]> {
  let ledgerInstant: LedgerInstant | undefined;
  const getLedgerInstant = async () =>
    (ledgerInstant ??= await withTimeout(
      getCurrentLedgerInstant(request.kaminoManager.getRpc()),
      RPC_REQUEST_TIMEOUT_MS,
      '[deposit-freeze] get ledger instant'
    ));
  const staleVaults: Address[] = [];
  for (const kaminoVault of request.kaminoVaults) {
    request.heartbeat?.();
    let capChanged = false;
    try {
      await reconcileVault(request, kaminoVault, getLedgerInstant, () => {
        capChanged = true;
      });
    } catch (error) {
      logger.error(`[deposit-freeze] error reconciling the deposit freezes of vault ${kaminoVault.address}: ${error}`);
    }
    if (!capChanged) continue;
    try {
      await withTimeout(
        kaminoVault.reloadState(),
        RPC_REQUEST_TIMEOUT_MS,
        `[deposit-freeze] reload vault ${kaminoVault.address}`
      );
    } catch (error) {
      logger.error(
        `[deposit-freeze] vault ${kaminoVault.address}: its caps changed but its state could not be reloaded; it is not rebalanced this pass: ${error}`
      );
      staleVaults.push(kaminoVault.address);
    }
  }
  return staleVaults;
}

/** A cap to send. After a restore lands, its freeze is removed from the file; after a lower, the cap is the frozen cap. */
type CapUpdate = { kind: 'freeze' | 'lower' | 'restore'; reserve: Address; capLamports: Decimal };

const CAP_UPDATE_LOG: Record<CapUpdate['kind'], string> = {
  freeze: 'frozen at',
  lower: 'lowered to',
  restore: 'restored to',
};

async function reconcileVault(
  {
    connectionPool: c,
    kaminoManager,
    allocationAdmin,
    blacklistPath,
    noNewFundsReserves,
    vaultsReserves,
    heartbeat,
    sendTx = sendAndConfirmTransactionV0,
    nowIso = () => new Date().toISOString(),
  }: DepositFreezeRequest,
  kaminoVault: KaminoVault,
  getLedgerInstant: () => Promise<LedgerInstant>,
  onCapChanged: () => void
): Promise<void> {
  const vaultAddress = kaminoVault.address.toString();
  const vaultState = await kaminoVault.getState();
  const freezes = new Map(
    readBlacklistFile(blacklistPath)
      .depositFreezes.filter((freeze) => freeze.vault === vaultAddress)
      .map((freeze) => [freeze.reserve, freeze])
  );
  const allocations = kaminoManager.getVaultAllocations(vaultState);
  let heldTokens: Map<Address, Decimal> | undefined;
  const heldLamportsOf = async (reserve: Address) => {
    heldTokens ??= (
      await kaminoManager.getVaultHoldings(
        vaultState,
        await getLedgerInstant(),
        vaultsReserves,
        await getLedgerInstant()
      )
    ).investedInReserves;
    return numberToLamportsDecimal(
      heldTokens.get(reserve) ?? new Decimal(0),
      vaultState.tokenMintDecimals.toNumber()
    ).floor();
  };

  const newFreezes: DepositFreezeEntry[] = [];
  const droppedFreezes = new Set<string>();
  const updates: CapUpdate[] = [];
  for (const [reserve, allocation] of allocations) {
    const reserveKey = reserve.toString();
    const capLamports = allocation.tokenAllocationCapLamports;
    const freeze = freezes.get(reserveKey);
    if (noNewFundsReserves.has(reserveKey)) {
      // Nothing flows into a reserve the vault does not weight.
      if (!allocation.targetWeight.gt(0)) continue;
      if (freeze === undefined) {
        const heldLamports = await heldLamportsOf(reserve);
        // A cap at or below the holding already lets no deposit in.
        if (heldLamports.gte(capLamports)) continue;
        newFreezes.push({
          vault: vaultAddress,
          reserve: reserveKey,
          originalCapLamports: capLamports.toFixed(),
          frozenCapLamports: heldLamports.toFixed(),
          timestamp: nowIso(),
        });
        updates.push({ kind: 'freeze', reserve, capLamports: heldLamports });
      } else if (capLamports.lte(freeze.frozenCapLamports)) {
        // Frozen. A withdrawal lowered the holding: lower the cap with it, or anyone could deposit up to the old cap.
        const heldLamports = await heldLamportsOf(reserve);
        if (heldLamports.lt(capLamports)) {
          updates.push({ kind: 'lower', reserve, capLamports: heldLamports });
        }
      } else if (capLamports.eq(freeze.originalCapLamports)) {
        // The freeze did not land: send it again, at the holding if that fell meanwhile.
        const heldLamports = await heldLamportsOf(reserve);
        const frozenLamports = new Decimal(freeze.frozenCapLamports);
        updates.push(
          heldLamports.lt(frozenLamports)
            ? { kind: 'lower', reserve, capLamports: heldLamports }
            : { kind: 'freeze', reserve, capLamports: frozenLamports }
        );
      } else {
        logger.warn(
          `[deposit-freeze] vault ${vaultAddress} reserve ${reserveKey}: the cap was raised to ${capLamports.toFixed()} lamports while frozen; keeping it`
        );
        droppedFreezes.add(reserveKey);
      }
    } else if (freeze !== undefined) {
      if (capLamports.lte(freeze.frozenCapLamports)) {
        updates.push({ kind: 'restore', reserve, capLamports: new Decimal(freeze.originalCapLamports) });
      } else {
        if (!capLamports.eq(freeze.originalCapLamports)) {
          logger.warn(
            `[deposit-freeze] vault ${vaultAddress} reserve ${reserveKey}: the cap was raised to ${capLamports.toFixed()} lamports while frozen; keeping it`
          );
        }
        droppedFreezes.add(reserveKey);
      }
    }
  }
  // A reserve that left the vault has no cap to restore.
  for (const reserveKey of freezes.keys()) {
    if (!Array.from(allocations.keys()).some((reserve) => reserve.toString() === reserveKey)) {
      droppedFreezes.add(reserveKey);
    }
  }

  // The original cap is saved before the freeze is sent, so a crash after the send can still restore it.
  if (newFreezes.length > 0 || droppedFreezes.size > 0) {
    updateBlacklistFile(blacklistPath, (blacklist) => {
      blacklist.depositFreezes = blacklist.depositFreezes.filter(
        (freeze) => freeze.vault !== vaultAddress || !droppedFreezes.has(freeze.reserve)
      );
      blacklist.depositFreezes.push(...newFreezes);
    });
  }
  if (updates.length === 0) {
    return;
  }

  const lookupTables = await loadVaultLookupTables(c.getRpc(), kaminoVault.address, vaultState, '[deposit-freeze]');
  const send = withVaultLookupTableRecovery(sendTx);
  // One update per transaction, so each restore is removed only when its own update lands.
  for (const update of updates) {
    heartbeat?.();
    const reserve = vaultsReserves.get(update.reserve);
    if (reserve === undefined) {
      logger.error(`[deposit-freeze] vault ${vaultAddress}: reserve ${update.reserve} is not loaded; skipping its cap`);
      continue;
    }
    const ix = await buildCapUpdateIx(
      kaminoManager,
      kaminoVault,
      vaultState,
      reserve,
      update.capLamports,
      allocationAdmin
    );
    if (ix === undefined) {
      continue;
    }
    try {
      await whileBeating(heartbeat, () =>
        send(c, allocationAdmin, [ix], lookupTables, [], `deposit cap ${update.kind} vault ${vaultAddress}`)
      );
    } catch (error) {
      logger.error(
        `[deposit-freeze] vault ${vaultAddress} reserve ${update.reserve}: the cap ${update.kind} failed; retrying next pass: ${error}`
      );
      continue;
    }
    onCapChanged();
    logger.warn(
      `[deposit-freeze] vault ${vaultAddress} reserve ${update.reserve}: cap ${CAP_UPDATE_LOG[update.kind]} ${update.capLamports.toFixed()} lamports`
    );
    // Recorded after the update lands: until then the cap on chain is at or below the recorded frozen cap, which marks
    // it as the bot's, so a crash in between still restores the original cap.
    if (update.kind !== 'freeze') {
      updateBlacklistFile(blacklistPath, (blacklist) => {
        blacklist.depositFreezes = blacklist.depositFreezes.flatMap((freeze) => {
          if (freeze.vault !== vaultAddress || freeze.reserve !== update.reserve.toString()) return [freeze];
          return update.kind === 'restore' ? [] : [{ ...freeze, frozenCapLamports: update.capLamports.toFixed() }];
        });
      });
    }
  }
}

/** The vaults a pass may freeze caps in: loaded, with a clear danger directive, and not in dry run. */
export function depositFreezeVaults(
  allocationsConfig: AllocationsConfig,
  directiveByVault: ReadonlyMap<string, VaultRebalanceDirective>,
  kaminoVaultsMap: ReadonlyMap<Address, KaminoVault>,
  globalDryRun: boolean
): KaminoVault[] {
  return allocationsConfig.allocationsConfig.flatMap((allocation) =>
    allocation.vaults.flatMap((vaultEntry) => {
      const vaultAddress = getVaultAddress(vaultEntry);
      const kaminoVault = kaminoVaultsMap.get(address(vaultAddress));
      const directive = directiveByVault.get(vaultAddress);
      const dryRun = globalDryRun || getAllocationDryRun(allocation, vaultEntry);
      return kaminoVault !== undefined && directive !== undefined && !directive.skip && !dryRun ? [kaminoVault] : [];
    })
  );
}
