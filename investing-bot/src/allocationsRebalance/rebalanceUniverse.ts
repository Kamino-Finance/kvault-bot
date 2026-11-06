import { KaminoManager, KaminoReserve, KaminoVault, VaultState } from '@kamino-finance/klend-sdk';
import { Address, IInstruction, TransactionSigner } from '@solana/kit';
import { logger } from 'kvaults-investing-bot-logger';
import { RPC_REQUEST_TIMEOUT_MS, withTimeout } from '../utils/timeout.js';
import { getMissingVaultReserves } from '../utils/vaultReserves.js';
import { buildWeightUpdateIx } from './vaultUtils.js';

export interface RebalanceUniverse {
  // Reserves strategies are allowed to optimize over.
  healthyVaultReserves: Map<Address, KaminoReserve>;
  // Blacklisted reserves still in the vault config, kept for logging/visibility.
  blacklistedVaultReserves: Set<string>;
  // Reserves in reinvest cooldown: excluded from the optimizer (no new allocation) but NOT forced to
  // zero — an existing position in another vault is left untouched. Kept for logging/visibility.
  cooldownVaultReserves: Set<string>;
  // On-chain allocation updates needed to remove blacklisted reserves from weight sums.
  forcedZeroIxs: IInstruction[];
}

/** The entries of `map` whose reserve is in `universe`, in `map` order. */
export function filterToUniverse<T>(
  map: ReadonlyMap<Address, T>,
  universe: ReadonlyMap<Address, unknown>
): Map<Address, T> {
  return new Map([...map].filter(([reserve]) => universe.has(reserve)));
}

async function reloadMissingVaultReserves(
  kaminoManager: KaminoManager,
  vaultState: VaultState,
  kaminoVault: KaminoVault,
  vaultReserveAddresses: Address[],
  vaultsReserves: Map<Address, KaminoReserve>
): Promise<void> {
  const missingReserveAddresses = getMissingVaultReserves(vaultReserveAddresses, vaultsReserves);
  if (missingReserveAddresses.length === 0) {
    return;
  }

  logger.warn(
    `[allocation-rebalance-loop] Vault ${kaminoVault.address.toString()} is missing ${
      missingReserveAddresses.length
    } loaded reserve(s), retrying: ${missingReserveAddresses.map((r) => r.toString()).join(', ')}`
  );

  const reloadedReserves = await withTimeout(
    kaminoManager.loadVaultReserves(vaultState),
    RPC_REQUEST_TIMEOUT_MS,
    `[allocation-rebalance-loop] reload missing vault reserves ${kaminoVault.address.toString()}`
  );
  reloadedReserves.forEach((reserve, reserveAddr) => {
    vaultsReserves.set(reserveAddr, reserve);
  });
}

/**
 * Build the canonical reserve universe once, before any strategy logic runs.
 */
export async function buildRebalanceUniverse(
  kaminoManager: KaminoManager,
  kaminoVault: KaminoVault,
  vaultsReserves: Map<Address, KaminoReserve>,
  signer: TransactionSigner,
  blacklistedReserves: ReadonlySet<string>,
  cooldownReserves: ReadonlySet<string> = new Set()
): Promise<RebalanceUniverse> {
  const vaultState = await kaminoVault.getState();
  const healthyVaultReserves = new Map<Address, KaminoReserve>();
  const blacklistedVaultReserves = new Set<string>();
  const cooldownVaultReserves = new Set<string>();
  const forcedZeroIxs: IInstruction[] = [];
  const vaultReserveAddresses = kaminoManager.getVaultReserves(vaultState);

  // Recover from a partial preload once; unresolved misses are logged below.
  await reloadMissingVaultReserves(kaminoManager, vaultState, kaminoVault, vaultReserveAddresses, vaultsReserves);

  for (const reserveAddr of vaultReserveAddresses) {
    const reserveState = vaultsReserves.get(reserveAddr);
    // Reinvest cooldown (transient): exclude from the optimizer so no NEW allocation flows in, but do
    // NOT force-zero — leave any existing position alone (it belongs to a vault that pulled out or is
    // being held; the cooldown only bars fresh reinvestment). A blacklisted reserve takes precedence.
    if (cooldownReserves.has(reserveAddr.toString()) && !blacklistedReserves.has(reserveAddr.toString())) {
      cooldownVaultReserves.add(reserveAddr.toString());
      continue;
    }
    if (blacklistedReserves.has(reserveAddr.toString())) {
      blacklistedVaultReserves.add(reserveAddr.toString());
      // Excluding a reserve from strategy input is not enough; its on-chain weight must be zeroed.
      if (!reserveState) {
        // Log an error instead of throwing so an unresolved reserve load does not crash the bot.
        logger.error(
          `[allocation-rebalance-loop] Blacklisted reserve ${reserveAddr} is in vault ${kaminoVault.address.toString()} but could not be loaded; cannot enforce zero allocation`
        );
        continue;
      }

      const zeroIx = await buildWeightUpdateIx(
        kaminoManager,
        kaminoVault,
        vaultState,
        { address: reserveAddr, state: reserveState.state },
        0,
        signer
      );
      if (zeroIx) {
        logger.warn(
          `[allocation-rebalance-loop] Enforcing zero allocation for blacklisted reserve ${reserveAddr} in vault ${kaminoVault.address.toString()}`
        );
        forcedZeroIxs.push(zeroIx);
      }
      continue;
    }

    if (!reserveState) {
      // Log an error instead of throwing so an unresolved reserve load does not crash the bot.
      logger.error(`[allocation-rebalance-loop] Reserve ${reserveAddr} not found after retrying vault reserve load`);
      continue;
    }
    healthyVaultReserves.set(reserveAddr, reserveState);
  }

  return { healthyVaultReserves, blacklistedVaultReserves, cooldownVaultReserves, forcedZeroIxs };
}
