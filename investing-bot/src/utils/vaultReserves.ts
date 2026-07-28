import type { KaminoManager, KaminoReserve, VaultState } from '@kamino-finance/klend-sdk';
import type { Address } from '@solana/kit';
import { logger } from 'kvaults-investing-bot-logger';

import { getEnvOrDefaultNum } from '../libs/utils/env.js';
import { RPC_REQUEST_TIMEOUT_MS, withTimeout } from './timeout.js';

const DEFAULT_MAX_UNIQUE_RESERVES_PER_BATCH = 50;

export const VAULT_RESERVES_MAX_UNIQUE_RESERVES_PER_BATCH = getEnvOrDefaultNum(
  'VAULT_RESERVES_MAX_UNIQUE_RESERVES_PER_BATCH',
  DEFAULT_MAX_UNIQUE_RESERVES_PER_BATCH
);

// Keep this sequential: the SDK reserve loader fans out account/oracle reads internally.
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
    const batch = batches[batchIndex];
    const batchReserves = await withTimeout(
      kaminoManager.loadVaultsReserves(batch),
      RPC_REQUEST_TIMEOUT_MS,
      `${label} batch ${batchIndex + 1}/${batches.length}`
    );
    batchReserves.forEach((reserve, reserveAddress) => {
      reserves.set(reserveAddress, reserve);
    });
    await heartbeat?.();
    await new Promise((resolve) => setImmediate(resolve));
  }

  return reserves;
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
