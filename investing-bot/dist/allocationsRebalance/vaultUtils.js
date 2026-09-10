import { Decimal } from 'decimal.js';
import { lamportsToDecimal, numberToLamportsDecimal, } from '@kamino-finance/klend-sdk';
import { DEFAULT_PUBLIC_KEY } from 'kvaults-investing-bot-tx/instruction';
import { MAX_ALLOCATION_CAP_IN_LAMPORTS } from './consts.js';
export function getReserveAllocationsMap(vaultState) {
    const allocations = new Map();
    for (const allocation of vaultState.vaultAllocationStrategy) {
        if (allocation.reserve !== DEFAULT_PUBLIC_KEY) {
            allocations.set(allocation.reserve, new Decimal(allocation.targetAllocationWeight.toString()));
        }
    }
    return allocations;
}
export function getVaultAllocationForReserve(vaultState, reserve) {
    return vaultState.vaultAllocationStrategy.find((a) => a.reserve === reserve);
}
export function getAllocationCapInTokensOrDefault(vaultState, reserve, defaultCapInLamports = new Decimal(MAX_ALLOCATION_CAP_IN_LAMPORTS)) {
    let capInLamports = defaultCapInLamports;
    const allocForReserve = getVaultAllocationForReserve(vaultState, reserve);
    if (allocForReserve) {
        capInLamports = new Decimal(allocForReserve.tokenAllocationCap.toString());
    }
    return lamportsToDecimal(capInLamports, vaultState.tokenMintDecimals.toNumber());
}
/// this impl assumes the new config has cap in tokens, not lamports
export function shouldUpdateAllocation(vaultState, reserveAllocConfig) {
    const allocForReserve = getVaultAllocationForReserve(vaultState, reserveAllocConfig.reserve.address);
    if (!allocForReserve) {
        return false;
    }
    const weightIsEqual = new Decimal(allocForReserve.targetAllocationWeight.toString()).eq(reserveAllocConfig.targetAllocationWeight);
    const newAllocCapInLamports = numberToLamportsDecimal(reserveAllocConfig.allocationCapDecimal, vaultState.tokenMintDecimals.toNumber());
    const capIsEqual = new Decimal(allocForReserve.tokenAllocationCap.toString()).eq(newAllocCapInLamports);
    const allocationUnchanged = weightIsEqual && capIsEqual;
    return !allocationUnchanged;
}
//# sourceMappingURL=vaultUtils.js.map