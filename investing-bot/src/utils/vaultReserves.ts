import type { KaminoManager, KaminoReserve, VaultState } from '@kamino-finance/klend-sdk';
import { isSolanaError, type Address } from '@solana/kit';
import { logger } from 'kvaults-investing-bot-logger';
import { RpcRequestError } from 'kvaults-investing-bot-tx/model';

import { readNumber } from '../config/schema.js';
import { SETTINGS } from '../config/settings.js';
import { RPC_REQUEST_TIMEOUT_MS, withTimeout } from './timeout.js';

export const VAULT_RESERVES_MAX_UNIQUE_RESERVES_PER_BATCH = readNumber(
  SETTINGS.VAULT_RESERVES_MAX_UNIQUE_RESERVES_PER_BATCH
);

// Keep this sequential: the SDK reserve loader fans out account/oracle reads internally.
// A batch that fails to load is left out of the result; callers skip the vaults whose reserves are absent.
export async function loadVaultsReservesInBatches(
  kaminoManager: KaminoManager,
  vaultStates: VaultState[],
  label: string,
  heartbeat?: () => void | Promise<void>,
  maxUniqueReservesPerBatch: number = VAULT_RESERVES_MAX_UNIQUE_RESERVES_PER_BATCH
): Promise<Map<Address, KaminoReserve>> {
  if (maxUniqueReservesPerBatch <= 0) {
    throw new Error('VAULT_RESERVES_MAX_UNIQUE_RESERVES_PER_BATCH must be greater than 0');
  }

  const batches = buildVaultStateReserveBatches(kaminoManager, vaultStates, maxUniqueReservesPerBatch);
  const reserves = new Map<Address, KaminoReserve>();

  if (batches.length > 1) {
    logger.info(`${label} in ${batches.length} sequential batches`);
  }

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batchReserves = await loadBatchIsolatingFailures(
      kaminoManager,
      batches[batchIndex],
      `${label} batch ${batchIndex + 1}/${batches.length}`,
      heartbeat
    );
    batchReserves.forEach((reserve, reserveAddress) => {
      reserves.set(reserveAddress, reserve);
    });
    await heartbeat?.();
    await new Promise((resolve) => setImmediate(resolve));
  }

  return reserves;
}

/**
 * The SDK loads a batch as one unit, so one reserve with a broken oracle fails the whole call. A failed
 * batch of several vaults is retried in halves, down to single vaults, so only the vaults holding the
 * broken reserve stay unloaded; those are logged and left out for the callers to skip. An RPC failure is not about
 * one vault: the batch is not split, because each retry would hit the same failure.
 */
async function loadBatchIsolatingFailures(
  kaminoManager: KaminoManager,
  vaults: VaultState[],
  label: string,
  heartbeat?: () => void | Promise<void>
): Promise<Map<Address, KaminoReserve>> {
  try {
    return await withTimeout(kaminoManager.loadVaultsReserves(vaults), RPC_REQUEST_TIMEOUT_MS, label);
  } catch (error) {
    if (vaults.length === 1 || isRpcFailure(error)) {
      logger.error(`${label} failed; the reserves of ${vaults.length} vault(s) stay unloaded this pass: ${error}`);
      return new Map();
    }
    logger.warn(`${label} failed for ${vaults.length} vaults; retrying in halves to isolate the failure: ${error}`);
    const middle = Math.ceil(vaults.length / 2);
    const merged = new Map<Address, KaminoReserve>();
    for (const half of [vaults.slice(0, middle), vaults.slice(middle)]) {
      // Each retry can take one RPC timeout.
      await heartbeat?.();
      const loaded = await loadBatchIsolatingFailures(
        kaminoManager,
        half,
        `${label} (${half.length} vault(s))`,
        heartbeat
      );
      loaded.forEach((reserve, reserveAddress) => merged.set(reserveAddress, reserve));
    }
    return merged;
  }
}

/** A deadline, an abort, an RPC error or a failed fetch: the endpoint failed, not the data of one vault. */
function isRpcFailure(error: unknown): boolean {
  return (
    error instanceof RpcRequestError ||
    isSolanaError(error) ||
    (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) ||
    (error instanceof TypeError && error.message === 'fetch failed')
  );
}

export function getMissingVaultReserves(
  vaultReserveAddresses: Address[],
  vaultsReserves: Map<Address, KaminoReserve>
): Address[] {
  return vaultReserveAddresses.filter((reserveAddr) => !vaultsReserves.has(reserveAddr));
}

function buildVaultStateReserveBatches(
  kaminoManager: KaminoManager,
  vaultStates: VaultState[],
  maxUniqueReservesPerBatch: number
): VaultState[][] {
  const batches: VaultState[][] = [];
  let currentBatch: VaultState[] = [];
  let currentReserveKeys = new Set<string>();

  for (const vaultState of vaultStates) {
    const vaultReserveKeys = uniqueReserveKeys(kaminoManager.getVaultReserves(vaultState));
    let newReserveKeysCount = 0;
    for (const reserveKey of vaultReserveKeys) {
      if (!currentReserveKeys.has(reserveKey)) {
        newReserveKeysCount += 1;
      }
    }

    if (currentBatch.length > 0 && currentReserveKeys.size + newReserveKeysCount > maxUniqueReservesPerBatch) {
      batches.push(currentBatch);
      currentBatch = [];
      currentReserveKeys = new Set<string>();
    }

    currentBatch.push(vaultState);
    for (const reserveKey of vaultReserveKeys) {
      currentReserveKeys.add(reserveKey);
    }
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

function uniqueReserveKeys(reserves: Address[]): string[] {
  return [...new Set(reserves.map((reserve) => reserve.toString()))];
}
