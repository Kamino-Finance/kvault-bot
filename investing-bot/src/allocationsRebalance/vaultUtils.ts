import { Decimal } from 'decimal.js';
import {
  KaminoManager,
  KaminoVault,
  lamportsToDecimal,
  numberToLamportsDecimal,
  ReserveAllocationConfig,
  ReserveWithAddress,
  VaultAllocation,
  VaultState,
} from '@kamino-finance/klend-sdk';
import { Address, IInstruction, TransactionSigner } from '@solana/kit';
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

function getAllocationCapInTokensOrDefault(vaultState: VaultState, reserve: Address): Decimal {
  let capInLamports = new Decimal(MAX_ALLOCATION_CAP_IN_LAMPORTS);
  const allocForReserve = getVaultAllocationForReserve(vaultState, reserve);
  if (allocForReserve) {
    capInLamports = new Decimal(allocForReserve.tokenAllocationCap.toString());
  }
  return lamportsToDecimal(capInLamports, vaultState.tokenMintDecimals.toNumber());
}

/// this impl assumes the new config has cap in tokens, not lamports
function shouldUpdateAllocation(vaultState: VaultState, reserveAllocConfig: ReserveAllocationConfig): boolean {
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

/** The instruction that sets `reserve`'s weight in the vault and keeps its cap, or undefined when nothing changes. */
export async function buildWeightUpdateIx(
  kaminoManager: KaminoManager,
  kaminoVault: KaminoVault,
  vaultState: VaultState,
  reserve: ReserveWithAddress,
  weight: number,
  signer: TransactionSigner
): Promise<IInstruction | undefined> {
  const config = new ReserveAllocationConfig(
    reserve,
    weight,
    getAllocationCapInTokensOrDefault(vaultState, reserve.address)
  );
  if (!shouldUpdateAllocation(vaultState, config)) {
    return undefined;
  }
  return (await kaminoManager.updateVaultReserveAllocationIxs(kaminoVault, config, signer)).updateReserveAllocationIx;
}

/**
 * The instruction that sets `reserve`'s token allocation cap in the vault, in vault-token lamports, and keeps its weight;
 * undefined when the reserve is not in the vault or nothing changes. The cToken cap keeps its on-chain value.
 */
export async function buildCapUpdateIx(
  kaminoManager: KaminoManager,
  kaminoVault: KaminoVault,
  vaultState: VaultState,
  reserve: ReserveWithAddress,
  capLamports: Decimal,
  signer: TransactionSigner
): Promise<IInstruction | undefined> {
  const allocation = getVaultAllocationForReserve(vaultState, reserve.address);
  if (!allocation) {
    return undefined;
  }
  const config = new ReserveAllocationConfig(
    reserve,
    allocation.targetAllocationWeight.toNumber(),
    lamportsToDecimal(capLamports, vaultState.tokenMintDecimals.toNumber())
  );
  if (!shouldUpdateAllocation(vaultState, config)) {
    return undefined;
  }
  return (await kaminoManager.updateVaultReserveAllocationIxs(kaminoVault, config, signer)).updateReserveAllocationIx;
}
