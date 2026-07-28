import { Decimal } from 'decimal.js';
import { KaminoManager, KaminoReserve, KaminoVault } from '@kamino-finance/klend-sdk';
import { FarmState } from '@kamino-finance/farms-sdk';
import { Address, Slot, TransactionSigner } from '@solana/kit';
import {
  AllocationWithAPYAndIxs,
  AllocationWithStabilizationFactorAndAPYAndIxs,
  gridSearchAllocationForMaxApyCoarseToFine,
  gridSearchAllocationForMinStabilizationFactorCoarseToFine,
} from '../utils/maxYieldOptimizers.js';
import { buildAllocationRebalanceInstructions, getVaultContext, logAllocationResult } from './common.js';

interface MaxYieldStrategyRequest {
  kaminoManager: KaminoManager;
  kaminoVault: KaminoVault;
  vaultsReserves: Map<Address, KaminoReserve>;
  signer: TransactionSigner;
  currentSlot: Slot;
  currentUnixTimestamp: number;
  gridSearchResolution: number;
  shouldIncludeFarmRewards: boolean;
  compoundingPeriods?: number;
  reservesWithMinAllocation?: Address[];
  minTotalAllocationForSpecifiedReservesBPS?: Decimal;
  farmsToFarmStateMap?: Map<Address, FarmState>;
  pricesMap?: Map<Address, Decimal>;
  verbose?: boolean;
  allVaultReserves?: Map<Address, KaminoReserve>;
  preservedReserves?: ReadonlySet<string>;
  forcedZeroReserves?: ReadonlySet<string>;
}

export async function getMaxYieldAllocationRebalanceIxs({
  kaminoManager,
  kaminoVault,
  vaultsReserves,
  signer,
  currentSlot,
  currentUnixTimestamp,
  gridSearchResolution,
  shouldIncludeFarmRewards,
  compoundingPeriods = 1,
  reservesWithMinAllocation = [],
  minTotalAllocationForSpecifiedReservesBPS = new Decimal(0),
  farmsToFarmStateMap,
  pricesMap,
  verbose = false,
  allVaultReserves = vaultsReserves,
  preservedReserves = new Set(),
  forcedZeroReserves = new Set(),
}: MaxYieldStrategyRequest): Promise<AllocationWithAPYAndIxs> {
  const vaultContext = await getVaultContext(
    kaminoManager,
    kaminoVault,
    vaultsReserves,
    currentSlot,
    allVaultReserves,
    preservedReserves,
    forcedZeroReserves
  );
  const bestAllocation = await gridSearchAllocationForMaxApyCoarseToFine(
    kaminoManager,
    vaultContext.vaultState,
    vaultsReserves,
    vaultContext.totalAllocationsWeights,
    gridSearchResolution,
    currentSlot,
    vaultContext.vaultAUMTokens,
    vaultContext.investedInReservesTokensMap,
    shouldIncludeFarmRewards,
    undefined,
    undefined,
    undefined,
    compoundingPeriods,
    reservesWithMinAllocation,
    minTotalAllocationForSpecifiedReservesBPS,
    undefined,
    farmsToFarmStateMap,
    pricesMap,
    verbose,
    undefined,
    vaultContext.allocationProjectionContext,
    vaultContext.allInvestedInReservesTokensMap
  );
  logAllocationResult(kaminoVault, 'MAX_YIELD', bestAllocation, reservesWithMinAllocation);
  return {
    ixns: await buildAllocationRebalanceInstructions(
      kaminoManager,
      kaminoVault,
      vaultContext.vaultState,
      vaultsReserves,
      bestAllocation,
      signer,
      currentSlot,
      currentUnixTimestamp,
      allVaultReserves,
      preservedReserves,
      forcedZeroReserves
    ),
    bestAllocation,
  };
}

export async function getMaxYieldStabilizationAllocationRebalanceIxs({
  kaminoManager,
  kaminoVault,
  vaultsReserves,
  signer,
  currentSlot,
  currentUnixTimestamp,
  gridSearchResolution,
  shouldIncludeFarmRewards,
  compoundingPeriods = 1,
  reservesWithMinAllocation = [],
  minTotalAllocationForSpecifiedReservesBPS = new Decimal(0),
  farmsToFarmStateMap,
  pricesMap,
  verbose = false,
  allVaultReserves = vaultsReserves,
  preservedReserves = new Set(),
  forcedZeroReserves = new Set(),
}: MaxYieldStrategyRequest): Promise<AllocationWithStabilizationFactorAndAPYAndIxs> {
  const vaultContext = await getVaultContext(
    kaminoManager,
    kaminoVault,
    vaultsReserves,
    currentSlot,
    allVaultReserves,
    preservedReserves,
    forcedZeroReserves
  );
  const bestAllocation = await gridSearchAllocationForMinStabilizationFactorCoarseToFine(
    kaminoManager,
    vaultContext.vaultState,
    vaultsReserves,
    vaultContext.totalAllocationsWeights,
    gridSearchResolution,
    currentSlot,
    vaultContext.vaultAUMTokens,
    vaultContext.investedInReservesTokensMap,
    shouldIncludeFarmRewards,
    undefined,
    undefined,
    undefined,
    compoundingPeriods,
    reservesWithMinAllocation,
    minTotalAllocationForSpecifiedReservesBPS,
    undefined,
    farmsToFarmStateMap,
    pricesMap,
    verbose,
    vaultContext.allocationProjectionContext,
    vaultContext.allInvestedInReservesTokensMap
  );
  logAllocationResult(
    kaminoVault,
    'MAX_YIELD_STABLE',
    bestAllocation,
    reservesWithMinAllocation,
    bestAllocation.stabilizationFactor
  );
  return {
    ixns: await buildAllocationRebalanceInstructions(
      kaminoManager,
      kaminoVault,
      vaultContext.vaultState,
      vaultsReserves,
      bestAllocation,
      signer,
      currentSlot,
      currentUnixTimestamp,
      allVaultReserves,
      preservedReserves,
      forcedZeroReserves
    ),
    bestAllocation,
  };
}
