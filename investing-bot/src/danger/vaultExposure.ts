import { Decimal } from 'decimal.js';
import { KaminoManager, VaultState } from '@kamino-finance/klend-sdk';
import { Address } from '@solana/kit';
import { readBlacklistFile } from './blacklistStore.js';

export function vaultHasExposureToReserves(
  kaminoManager: KaminoManager,
  vaultState: VaultState,
  investedInReservesTokens: Map<Address, Decimal>,
  reserveAddresses: ReadonlySet<string>
): boolean {
  for (const [reserve, allocation] of kaminoManager.getVaultAllocations(vaultState)) {
    if (!reserveAddresses.has(reserve.toString())) {
      continue;
    }
    const investedTokens = investedInReservesTokens.get(reserve);
    if (allocation.targetWeight.gt(0) || (investedTokens !== undefined && investedTokens.gt(0))) {
      return true;
    }
  }
  return false;
}

export function shouldBlockVaultInvestmentForDanger(
  kaminoManager: KaminoManager,
  vaultState: VaultState,
  investedInReservesTokens: Map<Address, Decimal>,
  blacklistedReserves: ReadonlySet<string>,
  pendingEvacuations: ReadonlySet<string>
): boolean {
  return (
    pendingEvacuations.size > 0 ||
    vaultHasExposureToReserves(kaminoManager, vaultState, investedInReservesTokens, blacklistedReserves)
  );
}

/**
 * Reads the blacklist file once on every call. The danger coordinator saves a blacklisted reserve before it zeroes
 * the vault weights one vault at a time, so a blacklist read once per pass misses a reserve blacklisted mid-pass.
 */
export function shouldBlockVaultInvestmentForDangerNow(
  blacklistPath: string,
  kaminoManager: KaminoManager,
  vaultAddress: Address,
  vaultState: VaultState,
  investedInReservesTokens: Map<Address, Decimal>
): boolean {
  const blacklist = readBlacklistFile(blacklistPath);
  return shouldBlockVaultInvestmentForDanger(
    kaminoManager,
    vaultState,
    investedInReservesTokens,
    new Set(blacklist.blacklistedReserves.map(({ reserve }) => reserve)),
    new Set(
      blacklist.pendingEvacuations
        .filter(({ vault }) => vault === vaultAddress.toString())
        .map(({ reserve }) => reserve)
    )
  );
}
