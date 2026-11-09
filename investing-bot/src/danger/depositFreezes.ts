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
import { DepositFreezeEntry, UnresolvedCapUpdate } from './dangerTypes.js';

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
 * Saves original and sent caps before sending and removes records only after confirmed restoration. Ends no freeze while
 * a cap it sent may still land. Keeps a cap that an operator changed, up or down: any cap other than the original cap and
 * the bot's caps. Reloads changed vaults. Returns vaults whose reload failed, which must skip rebalancing. Failures affect
 * only that vault.
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

  const readBlockHeight = () =>
    withTimeout(
      kaminoManager.getRpc().getBlockHeight().send(),
      RPC_REQUEST_TIMEOUT_MS,
      '[deposit-freeze] get block height'
    );
  let settleBlockHeight: bigint | undefined;

  const newFreezes: DepositFreezeEntry[] = [];
  const droppedFreezes = new Set<string>();
  /** Recorded freezes to replace, saved before any update is sent. */
  const changedFreezes = new Map<string, DepositFreezeEntry>();
  const updates: CapUpdate[] = [];
  for (const [reserve, allocation] of allocations) {
    const reserveKey = reserve.toString();
    const capLamports = allocation.tokenAllocationCapLamports;
    let freeze = freezes.get(reserveKey);
    if (freeze?.unresolvedCaps !== undefined) {
      // A cap on chain that the bot sent is the frozen cap now. It does not tell which send set it, so every send stays
      // unresolved until it is confirmed or passes its expiry height.
      const frozenCapLamports =
        freeze.unresolvedCaps.find((sent) => capLamports.eq(sent.capLamports))?.capLamports ?? freeze.frozenCapLamports;
      const blockHeight = (settleBlockHeight ??= await readBlockHeight());
      const unresolvedCaps = freeze.unresolvedCaps.filter((sent) => BigInt(sent.expiresAtBlockHeight) >= blockHeight);
      if (frozenCapLamports !== freeze.frozenCapLamports || unresolvedCaps.length < freeze.unresolvedCaps.length) {
        freeze = withUnresolvedCaps({ ...freeze, frozenCapLamports }, unresolvedCaps);
        changedFreezes.set(reserveKey, freeze);
      }
    }
    // A cap that lands after the freeze ends would stay, so the freeze waits for every send that may still land.
    const awaitingSends = freeze?.unresolvedCaps !== undefined;
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
      } else if (capLamports.eq(freeze.frozenCapLamports)) {
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
      } else if (awaitingSends) {
        logAwaitingSends(vaultAddress, freeze);
      } else {
        logOperatorCap(vaultAddress, reserveKey, capLamports);
        droppedFreezes.add(reserveKey);
      }
    } else if (freeze !== undefined) {
      if (awaitingSends) {
        logAwaitingSends(vaultAddress, freeze);
      } else if (capLamports.eq(freeze.frozenCapLamports)) {
        updates.push({ kind: 'restore', reserve, capLamports: new Decimal(freeze.originalCapLamports) });
      } else {
        // At the original cap, the restore already landed.
        if (!capLamports.eq(freeze.originalCapLamports)) {
          logOperatorCap(vaultAddress, reserveKey, capLamports);
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
  if (newFreezes.length > 0 || droppedFreezes.size > 0 || changedFreezes.size > 0) {
    updateBlacklistFile(blacklistPath, (blacklist) => {
      blacklist.depositFreezes = blacklist.depositFreezes.flatMap((freeze) => {
        if (freeze.vault !== vaultAddress) return [freeze];
        if (droppedFreezes.has(freeze.reserve)) return [];
        return [changedFreezes.get(freeze.reserve) ?? freeze];
      });
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
    /** The entry of this send's latest transaction. */
    const latest: { sent?: UnresolvedCapUpdate } = {};
    // Saved before each transaction leaves the process, with the block height after which it cannot land, so a send
    // whose result the bot does not see keeps the cap the bot's and the freeze open until then, even after a crash. Its
    // own entry: an earlier send of the same cap stays tracked. The sender signs a retry only after the previous
    // transaction expired, so the retry's entry replaces it.
    const recordTransaction = ({ lastValidBlockHeight }: { lastValidBlockHeight: bigint }): void => {
      const sent = { capLamports: update.capLamports.toFixed(), expiresAtBlockHeight: lastValidBlockHeight.toString() };
      const previous = latest.sent;
      updateFreeze(blacklistPath, vaultAddress, update.reserve, (freeze) =>
        withUnresolvedCaps(freeze, [
          ...(previous === undefined ? (freeze.unresolvedCaps ?? []) : withoutSend(freeze.unresolvedCaps, previous)),
          sent,
        ])
      );
      latest.sent = sent;
    };
    try {
      await whileBeating(heartbeat, () =>
        send(
          c,
          allocationAdmin,
          [ix],
          lookupTables,
          [],
          `deposit cap ${update.kind} vault ${vaultAddress}`,
          update.kind === 'restore' ? {} : { onBlockhash: recordTransaction }
        )
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
    // A confirmed cap is the frozen cap, and this send cannot land again. A confirmed restore ends the freeze.
    const confirmed = latest.sent;
    updateFreeze(blacklistPath, vaultAddress, update.reserve, (freeze) =>
      update.kind === 'restore'
        ? undefined
        : withUnresolvedCaps(
            { ...freeze, frozenCapLamports: update.capLamports.toFixed() },
            confirmed === undefined ? (freeze.unresolvedCaps ?? []) : withoutSend(freeze.unresolvedCaps, confirmed)
          )
    );
  }
}

/** Replaces the record of one freeze in the file with `change(freeze)`, or removes it when that returns undefined. */
function updateFreeze(
  blacklistPath: string,
  vaultAddress: string,
  reserve: Address,
  change: (freeze: DepositFreezeEntry) => DepositFreezeEntry | undefined
): void {
  updateBlacklistFile(blacklistPath, (blacklist) => {
    blacklist.depositFreezes = blacklist.depositFreezes.flatMap((freeze) => {
      if (freeze.vault !== vaultAddress || freeze.reserve !== reserve.toString()) return [freeze];
      const changed = change(freeze);
      return changed === undefined ? [] : [changed];
    });
  });
}

/** The unresolved caps without the one entry of `sent`; other sends of the same cap stay. */
function withoutSend(unresolvedCaps: UnresolvedCapUpdate[] = [], sent: UnresolvedCapUpdate): UnresolvedCapUpdate[] {
  const index = unresolvedCaps.findIndex(
    (entry) => entry.capLamports === sent.capLamports && entry.expiresAtBlockHeight === sent.expiresAtBlockHeight
  );
  return unresolvedCaps.filter((_, entryIndex) => entryIndex !== index);
}

/** The freeze with `unresolvedCaps`, or without the field when none is left. */
function withUnresolvedCaps(freeze: DepositFreezeEntry, unresolvedCaps: UnresolvedCapUpdate[]): DepositFreezeEntry {
  return {
    vault: freeze.vault,
    reserve: freeze.reserve,
    originalCapLamports: freeze.originalCapLamports,
    frozenCapLamports: freeze.frozenCapLamports,
    ...(unresolvedCaps.length > 0 ? { unresolvedCaps } : {}),
    timestamp: freeze.timestamp,
  };
}

/** Logs a freeze the bot keeps because a cap it sent may still land. */
function logAwaitingSends(vaultAddress: string, freeze: DepositFreezeEntry): void {
  const unresolved = (freeze.unresolvedCaps ?? [])
    .map((sent) => `${sent.capLamports} lamports until block height ${sent.expiresAtBlockHeight}`)
    .join(', ');
  logger.warn(
    `[deposit-freeze] vault ${vaultAddress} reserve ${freeze.reserve}: keeping the freeze until these sent caps land or expire: ${unresolved}`
  );
}

/** Logs a cap that matches neither the bot's caps nor the original cap: an operator set it, and the bot keeps it. */
function logOperatorCap(vaultAddress: string, reserveKey: string, capLamports: Decimal): void {
  logger.warn(
    `[deposit-freeze] vault ${vaultAddress} reserve ${reserveKey}: the cap was changed to ${capLamports.toFixed()} lamports while frozen; keeping it and forgetting the freeze`
  );
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
