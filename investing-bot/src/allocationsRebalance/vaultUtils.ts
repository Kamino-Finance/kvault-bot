import { Decimal } from 'decimal.js';
import {
  lamportsToDecimal,
  numberToLamportsDecimal,
  ReserveAllocationConfig,
  VaultAllocation,
  VaultState,
} from '@kamino-finance/klend-sdk';
import { Address } from '@solana/kit';
import { DEFAULT_PUBLIC_KEY } from 'kvaults-investing-bot-tx/instruction';
import { MAX_ALLOCATION_CAP_IN_LAMPORTS } from './consts.js';

export function getReserveAllocationsMap(vaultState: VaultState): Map<Address, Decimal> {
  const allocations = new Map<Address, Decimal>();
  for (const allocation of vaultState.vaultAllocationStrategy) {
    if (allocation.reserve !== DEFAULT_PUBLIC_KEY) {
      allocations.set(allocation.reserve, new Decimal(allocation.targetAllocationWeight.toString()));
    }
  }
  return allocations;
}

export function getVaultAllocationForReserve(vaultState: VaultState, reserve: Address): VaultAllocation | undefined {
  return vaultState.vaultAllocationStrategy.find((a) => a.reserve === reserve);
}

export function getAllocationCapInTokensOrDefault(
  vaultState: VaultState,
  reserve: Address,
  defaultCapInLamports: Decimal = new Decimal(MAX_ALLOCATION_CAP_IN_LAMPORTS)
): Decimal {
  let capInLamports = defaultCapInLamports;
  const allocForReserve = getVaultAllocationForReserve(vaultState, reserve);
  if (allocForReserve) {
    capInLamports = new Decimal(allocForReserve.tokenAllocationCap.toString());
  }
  return lamportsToDecimal(capInLamports, vaultState.tokenMintDecimals.toNumber());
}

/// this impl assumes the new config has cap in tokens, not lamports
export function shouldUpdateAllocation(vaultState: VaultState, reserveAllocConfig: ReserveAllocationConfig): boolean {
  const allocForReserve = getVaultAllocationForReserve(vaultState, reserveAllocConfig.reserve.address);
  if (!allocForReserve) {
    return false;
  }

  const weightIsEqual = new Decimal(allocForReserve.targetAllocationWeight.toString()).eq(
    reserveAllocConfig.targetAllocationWeight
  );

  const newAllocCapInLamports = numberToLamportsDecimal(
    reserveAllocConfig.allocationCapDecimal,
    vaultState.tokenMintDecimals.toNumber()
  );
  const capIsEqual = new Decimal(allocForReserve.tokenAllocationCap.toString()).eq(newAllocCapInLamports);

  const allocationUnchanged = weightIsEqual && capIsEqual;
  return !allocationUnchanged;
}
