import { KaminoManager, KaminoVault } from '@kamino-finance/klend-sdk';
import { Address } from '@solana/kit';
import { logger } from 'kvaults-investing-bot-logger';
import { LoopHeartbeat } from './loop.js';
import { RPC_REQUEST_TIMEOUT_MS, withTimeout } from './timeout.js';

/**
 * The configured vaults, with null for an address that holds no vault. The SDK decodes the list as one batch and throws
 * when one address is another program's account or another account type. That batch is then fetched one address at a
 * time, so one bad entry does not stop every vault. Any other error, such as an RPC outage, propagates.
 */
export async function fetchConfiguredVaults(
  kaminoManager: Pick<KaminoManager, 'getVaults'>,
  addresses: Address[],
  logPrefix: string,
  heartbeat?: LoopHeartbeat
): Promise<Array<KaminoVault | null>> {
  const fetch = (vaults: Address[]) =>
    withTimeout(kaminoManager.getVaults(vaults), RPC_REQUEST_TIMEOUT_MS, `${logPrefix} fetch vaults`);
  try {
    return await fetch(addresses);
  } catch (error) {
    if (!isNotAVaultAccountError(error)) throw error;
    logger.error(`${logPrefix} a configured vault address holds no vault (${error}); fetching each alone`);
  }
  const vaults: Array<KaminoVault | null> = [];
  for (const address of addresses) {
    heartbeat?.();
    try {
      vaults.push((await fetch([address]))[0] ?? null);
    } catch (error) {
      if (!isNotAVaultAccountError(error)) throw error;
      logger.error(`${logPrefix} configured vault ${address} is not a vault account: ${error}`);
      vaults.push(null);
    }
  }
  return vaults;
}

/** The SDK's errors for an account of another program or another type, as `VaultState.fetchMultiple` throws them. */
function isNotAVaultAccountError(error: unknown): boolean {
  return error instanceof Error && /belongs to wrong program|invalid account discriminator/.test(error.message);
}
