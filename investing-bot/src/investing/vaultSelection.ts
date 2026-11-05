import { KaminoManager, KaminoVault } from '@kamino-finance/klend-sdk';
import { Address } from '@solana/kit';
import { logger } from 'kvaults-investing-bot-logger';
import { ConnectionPool } from 'kvaults-investing-bot-tx/ConnectionPool';
import { chunks } from '../libs/utils/batch.js';
import { getAllUIEnabledVaults } from '../libs/utils/kaminoResources.js';
import { LoopHeartbeat } from '../utils/loop.js';
import { RPC_REQUEST_TIMEOUT_MS, withTimeout } from '../utils/timeout.js';
import { fetchConfiguredVaults } from '../utils/vaultFetch.js';

const VAULT_FETCH_BATCH_SIZE = 25;

/**
 * Returns the vault pubkeys to pass to getVaultsData: the configured ones, followed by the UI-enabled ones when
 * `includeUiVaults` is set. Returns undefined when the UI list fails to load and nothing is configured, so the
 * caller skips the pass instead of letting an empty selection widen the universe.
 */
export async function selectVaultPubkeys(
  baseVaultsPubkeys: Address[],
  vaultOwnersPubkeys: Address[],
  includeUiVaults: boolean,
  fetchUiEnabledVaults: () => Promise<Address[]> = getAllUIEnabledVaults
): Promise<Address[] | undefined> {
  if (!includeUiVaults) {
    return baseVaultsPubkeys;
  }
  try {
    const uiEnabledVaults = await fetchUiEnabledVaults();
    return [...baseVaultsPubkeys, ...uiEnabledVaults];
  } catch (e) {
    // A CDN outage must not stop the configured vaults; the UI list is retried next pass.
    logger.error(
      `[investing-loop] could not load the UI-enabled vault list; investing only the configured vaults this pass: ${e}`
    );
    if (baseVaultsPubkeys.length === 0 && vaultOwnersPubkeys.length === 0) {
      // An empty selection means "every vault" to getVaultsData: an outage must never widen the universe.
      logger.error('[investing-loop] no explicitly configured vaults to fall back to; skipping this pass');
      return undefined;
    }
    return baseVaultsPubkeys;
  }
}

export async function getVaultsData(
  c: ConnectionPool,
  vaultsPubkeys: Address[],
  ownersPubkeys: Address[],
  kaminoManager: KaminoManager,
  heartbeat?: LoopHeartbeat
): Promise<KaminoVault[]> {
  const shouldUseOverrides = vaultsPubkeys.length > 0 || ownersPubkeys.length > 0;

  let uniqueVaults: KaminoVault[] = [];

  if (shouldUseOverrides) {
    const vaults = new Map<Address, KaminoVault>();
    if (vaultsPubkeys.length > 0) {
      const uniqueVaultPubkeys = uniqueAddresses(vaultsPubkeys);
      for (const vault of await getVaultsInBatches(kaminoManager, uniqueVaultPubkeys, heartbeat)) {
        vaults.set(vault.address, vault);
      }
    }
    if (ownersPubkeys.length > 0) {
      const ownerBatches = chunks(ownersPubkeys, VAULT_FETCH_BATCH_SIZE);
      const vaultStates: KaminoVault[] = [];
      for (let batchIndex = 0; batchIndex < ownerBatches.length; batchIndex += 1) {
        const batchVaultStates = await withTimeout(
          Promise.all(ownerBatches[batchIndex].map((owner) => kaminoManager.getAllVaultsForOwner(owner))),
          RPC_REQUEST_TIMEOUT_MS,
          `[investing-loop] fetch vaults for ${ownersPubkeys.length} owners batch ${batchIndex + 1}/${ownerBatches.length}`
        );
        vaultStates.push(...batchVaultStates.flat());
        heartbeat?.();
      }
      for (const vault of vaultStates) {
        vaults.set(vault.address, vault);
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
  const vaultBatches = chunks(uniqueVaults, VAULT_FETCH_BATCH_SIZE);
  for (let batchIndex = 0; batchIndex < vaultBatches.length; batchIndex += 1) {
    await withTimeout(
      Promise.all(vaultBatches[batchIndex].map((vault) => vault.getState())),
      RPC_REQUEST_TIMEOUT_MS,
      `[investing-loop] load vault states batch ${batchIndex + 1}/${vaultBatches.length}`
    );
    heartbeat?.();
  }
  return uniqueVaults;
}

/** Fetches vaults in batches. Logs and skips addresses without a vault. */
async function getVaultsInBatches(
  kaminoManager: KaminoManager,
  vaultPubkeys: Address[],
  heartbeat?: LoopHeartbeat
): Promise<KaminoVault[]> {
  const vaults: KaminoVault[] = [];
  for (const batch of chunks(vaultPubkeys, VAULT_FETCH_BATCH_SIZE)) {
    for (const vault of await fetchConfiguredVaults(kaminoManager, batch, '[investing-loop]', heartbeat)) {
      if (vault) vaults.push(vault);
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
