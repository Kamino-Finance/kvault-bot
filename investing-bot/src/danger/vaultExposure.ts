import { Decimal } from 'decimal.js';
import { KaminoManager, VaultState } from '@kamino-finance/klend-sdk';
import { Address } from '@solana/kit';

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
