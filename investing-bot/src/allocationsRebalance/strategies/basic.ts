import { Decimal } from 'decimal.js';
import {
  KaminoManager,
  KaminoReserve,
  KaminoVault,
  ReserveAllocationConfig,
  ReserveWithAddress,
} from '@kamino-finance/klend-sdk';
import { Address, IInstruction, Slot, TransactionSigner } from '@solana/kit';
import { logger } from 'kvaults-investing-bot-logger';
import { AllocationWithAPY, AllocationWithAPYAndIxs } from '../utils/maxYieldOptimizers.js';
import { computeOverallVaultAPYFromReservesMap } from '../utils/allocationHelper.js';
import { ReserveWeight } from '../rebalanceConfig.js';
import { getAllocationCapInTokensOrDefault, shouldUpdateAllocation } from '../vaultUtils.js';
import { DEFAULT_ALLOCATION_WEIGHT } from '../consts.js';
import { getReserveAllocationsForUniverse, getVaultReserveAddressesInUniverse } from '../rebalanceUniverse.js';

export async function getUnchangedAllocationRebalanceIxs(
  kaminoManager: KaminoManager,
  kaminoVault: KaminoVault,
  vaultsReserves: Map<Address, KaminoReserve>,
  currentSlot: Slot,
  compoundingPeriods: number = 1,
  verbose: boolean = false,
  allVaultReserves: Map<Address, KaminoReserve> = vaultsReserves,
  forcedZeroReserves: ReadonlySet<string> = new Set()
): Promise<AllocationWithAPYAndIxs> {
  const vaultState = await kaminoVault.getState();
  const vaultHoldings = await kaminoManager.getVaultHoldings(vaultState, currentSlot, allVaultReserves, currentSlot);
  const currentReservesAllocations = getReserveAllocationsForUniverse(vaultState, vaultsReserves);
  const bestAllocation: AllocationWithAPY = {
    reservesWithAllocation: currentReservesAllocations,
    apy: computeOverallVaultAPYFromReservesMap(
      currentReservesAllocations,
      currentReservesAllocations,
      vaultHoldings.totalAUMIncludingFees.sub(vaultHoldings.pendingFees ?? 0),
      vaultHoldings.investedInReserves,
      vaultsReserves,
      currentSlot,
      compoundingPeriods,
      verbose,
      {
        vaultState,
        vaultAUMTokens: vaultHoldings.totalAUMIncludingFees.sub(vaultHoldings.pendingFees ?? 0),
        currentVaultAllocations: kaminoManager.getVaultAllocations(vaultState),
        allVaultReserves,
        currentSlot,
        forcedZeroReserves,
      }
    ),
  };
  return { ixns: [], bestAllocation };
}

export async function getFixedWeightsAllocationRebalanceIxs(
  kaminoManager: KaminoManager,
  kaminoVault: KaminoVault,
  vaultsReserves: Map<Address, KaminoReserve>,
  fixedReservesWeights: ReserveWeight[],
  signer: TransactionSigner,
  currentSlot: Slot,
  compoundingPeriods: number = 1,
  verbose: boolean = false,
  allVaultReserves: Map<Address, KaminoReserve> = vaultsReserves,
  forcedZeroReserves: ReadonlySet<string> = new Set()
): Promise<AllocationWithAPYAndIxs> {
  const vaultState = await kaminoVault.getState();
  const currentReservesWithWeights = getReserveAllocationsForUniverse(vaultState, vaultsReserves);
  const allocationRebalanceIxs: IInstruction[] = [];
  const bestAllocation: AllocationWithAPY = {
    reservesWithAllocation: new Map(),
    apy: new Decimal(0),
  };

  for (const [reserve] of currentReservesWithWeights) {
    const fixedReserveWeight = fixedReservesWeights.find(
      ({ reserve: configuredReserve }) => configuredReserve === reserve
    );
    if (!fixedReserveWeight) {
      continue;
    }
    const kaminoReserveState = vaultsReserves.get(reserve);
    if (!kaminoReserveState) {
      throw new Error(`Reserve ${reserve} not found`);
    }
    bestAllocation.reservesWithAllocation.set(reserve, new Decimal(fixedReserveWeight.weight));
    const reserveWithAddress: ReserveWithAddress = {
      address: reserve,
      state: kaminoReserveState.state,
    };
    const reserveAllocationConfig = new ReserveAllocationConfig(
      reserveWithAddress,
      fixedReserveWeight.weight,
      getAllocationCapInTokensOrDefault(vaultState, reserve)
    );
    if (shouldUpdateAllocation(vaultState, reserveAllocationConfig)) {
      logger.info(
        `[allocation-rebalance-loop] Updating reserve allocation for vault ${kaminoVault.address.toString()} with reserve ${reserve} to weight ${fixedReserveWeight.weight}`
      );
      const updateIxs = await kaminoManager.updateVaultReserveAllocationIxs(
        kaminoVault,
        reserveAllocationConfig,
        signer
      );
      allocationRebalanceIxs.push(updateIxs.updateReserveAllocationIx);
    }
  }

  const vaultHoldings = await kaminoManager.getVaultHoldings(vaultState, currentSlot, allVaultReserves, currentSlot);
  bestAllocation.apy = computeOverallVaultAPYFromReservesMap(
    bestAllocation.reservesWithAllocation,
    getReserveAllocationsForUniverse(vaultState, vaultsReserves),
    vaultHoldings.totalAUMIncludingFees.sub(vaultHoldings.pendingFees ?? 0),
    vaultHoldings.investedInReserves,
    vaultsReserves,
    currentSlot,
    compoundingPeriods,
    verbose,
    {
      vaultState,
      vaultAUMTokens: vaultHoldings.totalAUMIncludingFees.sub(vaultHoldings.pendingFees ?? 0),
      currentVaultAllocations: kaminoManager.getVaultAllocations(vaultState),
      allVaultReserves,
      currentSlot,
      forcedZeroReserves,
    }
  );
  return { ixns: allocationRebalanceIxs, bestAllocation };
}

export async function getEqualAllocationRebalanceIxs(
  kaminoManager: KaminoManager,
  kaminoVault: KaminoVault,
  vaultsReserves: Map<Address, KaminoReserve>,
  signer: TransactionSigner,
  currentSlot: Slot,
  compoundingPeriods: number = 1,
  verbose: boolean = false,
  allVaultReserves: Map<Address, KaminoReserve> = vaultsReserves,
  forcedZeroReserves: ReadonlySet<string> = new Set()
): Promise<AllocationWithAPYAndIxs> {
  const vaultState = await kaminoVault.getState();
  const reserves = getVaultReserveAddressesInUniverse(kaminoManager, vaultState, vaultsReserves);
  const vaultHoldings = await kaminoManager.getVaultHoldings(vaultState, currentSlot, allVaultReserves, currentSlot);
  const allocationRebalanceIxs: IInstruction[] = [];
  const bestAllocation: AllocationWithAPY = {
    reservesWithAllocation: new Map(),
    apy: new Decimal(0),
  };

  logger.info(
    `[allocation-rebalance-loop] Rebalancing allocation for vault ${kaminoVault.address.toString()}; strategy: EQUAL; ${reserves
      .map((reserve) => `Reserve ${reserve.toString()} weight: ${DEFAULT_ALLOCATION_WEIGHT};`)
      .join(' ')}`
  );
  for (const reserve of reserves) {
    const kaminoReserveState = vaultsReserves.get(reserve);
    if (!kaminoReserveState) {
      throw new Error(`Reserve ${reserve} not found`);
    }
    bestAllocation.reservesWithAllocation.set(reserve, new Decimal(DEFAULT_ALLOCATION_WEIGHT));
    const reserveAllocationConfig = new ReserveAllocationConfig(
      { address: reserve, state: kaminoReserveState.state },
      DEFAULT_ALLOCATION_WEIGHT,
      getAllocationCapInTokensOrDefault(vaultState, reserve)
    );
    if (shouldUpdateAllocation(vaultState, reserveAllocationConfig)) {
      const updateIxs = await kaminoManager.updateVaultReserveAllocationIxs(
        kaminoVault,
        reserveAllocationConfig,
        signer
      );
      allocationRebalanceIxs.push(updateIxs.updateReserveAllocationIx);
    }
  }

  bestAllocation.apy = computeOverallVaultAPYFromReservesMap(
    bestAllocation.reservesWithAllocation,
    getReserveAllocationsForUniverse(vaultState, vaultsReserves),
    vaultHoldings.totalAUMIncludingFees.sub(vaultHoldings.pendingFees ?? 0),
    vaultHoldings.investedInReserves,
    vaultsReserves,
    currentSlot,
    compoundingPeriods,
    verbose,
    {
      vaultState,
      vaultAUMTokens: vaultHoldings.totalAUMIncludingFees.sub(vaultHoldings.pendingFees ?? 0),
      currentVaultAllocations: kaminoManager.getVaultAllocations(vaultState),
      allVaultReserves,
      currentSlot,
      forcedZeroReserves,
    }
  );
  return { ixns: allocationRebalanceIxs, bestAllocation };
}

export async function getRandomAllocationRebalanceIxs(
  kaminoManager: KaminoManager,
  kaminoVault: KaminoVault,
  vaultsReserves: Map<Address, KaminoReserve>,
  signer: TransactionSigner,
  currentSlot: Slot,
  compoundingPeriods: number = 1,
  verbose: boolean = false,
  allVaultReserves: Map<Address, KaminoReserve> = vaultsReserves,
  forcedZeroReserves: ReadonlySet<string> = new Set()
): Promise<AllocationWithAPYAndIxs> {
  const vaultState = await kaminoVault.getState();
  const reserves = getVaultReserveAddressesInUniverse(kaminoManager, vaultState, vaultsReserves);
  const vaultHoldings = await kaminoManager.getVaultHoldings(vaultState, currentSlot, allVaultReserves, currentSlot);
  const weights = reserves.map(() => Math.floor(Math.random() * 100_000) + 100);
  const allocationRebalanceIxs: IInstruction[] = [];
  const bestAllocation: AllocationWithAPY = {
    reservesWithAllocation: new Map(),
    apy: new Decimal(0),
  };

  logger.info(
    `[allocation-rebalance-loop] Rebalancing allocation for vault ${kaminoVault.address.toString()}; strategy: RANDOM; ${reserves
      .map((reserve, index) => `Reserve ${reserve.toString()} weight: ${weights[index]};`)
      .join(' ')}`
  );
  for (let index = 0; index < reserves.length; index++) {
    const reserve = reserves[index];
    const weight = weights[index];
    const kaminoReserveState = vaultsReserves.get(reserve);
    if (!kaminoReserveState) {
      throw new Error(`Reserve ${reserve} not found`);
    }
    const reserveAllocationConfig = new ReserveAllocationConfig(
      { address: reserve, state: kaminoReserveState.state },
      weight,
      getAllocationCapInTokensOrDefault(vaultState, reserve)
    );
    if (shouldUpdateAllocation(vaultState, reserveAllocationConfig)) {
      const updateIxs = await kaminoManager.updateVaultReserveAllocationIxs(
        kaminoVault,
        reserveAllocationConfig,
        signer
      );
      allocationRebalanceIxs.push(updateIxs.updateReserveAllocationIx);
    }
    bestAllocation.reservesWithAllocation.set(reserve, new Decimal(weight));
  }

  bestAllocation.apy = computeOverallVaultAPYFromReservesMap(
    bestAllocation.reservesWithAllocation,
    getReserveAllocationsForUniverse(vaultState, vaultsReserves),
    vaultHoldings.totalAUMIncludingFees.sub(vaultHoldings.pendingFees ?? 0),
    vaultHoldings.investedInReserves,
    vaultsReserves,
    currentSlot,
    compoundingPeriods,
    verbose,
    {
      vaultState,
      vaultAUMTokens: vaultHoldings.totalAUMIncludingFees.sub(vaultHoldings.pendingFees ?? 0),
      currentVaultAllocations: kaminoManager.getVaultAllocations(vaultState),
      allVaultReserves,
      currentSlot,
      forcedZeroReserves,
    }
  );
  return { ixns: allocationRebalanceIxs, bestAllocation };
}
