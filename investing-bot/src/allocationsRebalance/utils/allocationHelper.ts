import { Decimal } from 'decimal.js';
import {
  calculateAPYFromAPR,
  computeReservesAllocation,
  DEFAULT_PUBLIC_KEY,
  isCtokenAllocationCapUncapped,
  KaminoReserve,
  lamportsToDecimal,
  ReserveAllocationForCompute,
  ReserveAllocationOverview,
  toReserveAllocationForCompute,
  VaultAllocationResult,
  VaultState,
} from '@kamino-finance/klend-sdk';
import { Address, Slot } from '@solana/kit';
import { logger } from 'kvaults-investing-bot-logger';
import { FarmAndKey, FarmIncentives, Farms, FarmState } from '@kamino-finance/farms-sdk';
import { StabilizationFactorAndAPY } from './maxYieldOptimizers.js';

export const FULL_BPS = 10_000;

export interface VaultAllocationProjectionContext {
  vaultState: VaultState;
  vaultAUMTokens: Decimal;
  currentVaultAllocations: Map<Address, ReserveAllocationOverview>;
  allVaultReserves: Map<Address, KaminoReserve>;
  currentSlot: Slot;
  forcedZeroReserves?: ReadonlySet<string>;
}

/**
 * Project proposed weights into the exact token targets used by kvault's
 * `refresh_target_allocations`, via the pinned klend SDK implementation.
 */
export function computeVaultTargetAllocation(
  proposedWeights: ReadonlyMap<Address, Decimal>,
  context: VaultAllocationProjectionContext
): VaultAllocationResult {
  const tokenDecimals = context.vaultState.tokenMintDecimals.toNumber();
  const allocationsForCompute = new Map<Address, ReserveAllocationForCompute>();

  for (const [reserveAddress, currentAllocation] of context.currentVaultAllocations) {
    const targetWeight = context.forcedZeroReserves?.has(reserveAddress.toString())
      ? new Decimal(0)
      : (proposedWeights.get(reserveAddress) ?? currentAllocation.targetWeight);
    let collateralExchangeRate: Decimal | undefined;
    if (!isCtokenAllocationCapUncapped(currentAllocation.ctokenAllocationCapLamports)) {
      const reserve = context.allVaultReserves.get(reserveAddress);
      if (!reserve) {
        throw new Error(`Reserve ${reserveAddress} not found while computing finite cToken allocation cap`);
      }
      collateralExchangeRate = reserve.getEstimatedCollateralExchangeRate(context.currentSlot, 0);
    }

    allocationsForCompute.set(
      reserveAddress,
      toReserveAllocationForCompute({ ...currentAllocation, targetWeight }, tokenDecimals, collateralExchangeRate)
    );
  }

  return computeReservesAllocation(
    context.vaultAUMTokens,
    new Decimal(context.vaultState.unallocatedWeight.toString()),
    lamportsToDecimal(context.vaultState.unallocatedTokensCap.toString(), tokenDecimals),
    allocationsForCompute,
    tokenDecimals
  );
}

/// returns the simulated supply yield of the reserve if we remove `prevVaultAllocTokens` (which is current allocation) and deposit `newVaultAllocTokens` (which is the new allocation)
export function evaluateReserveSupplyYieldWithNewAllocation(
  reserve: KaminoReserve,
  newVaultAllocTokens: Decimal,
  prevVaultAllocTokens: Decimal,
  currentSlot: Slot,
  compoundPeriods: number
): Decimal {
  const decimals = new Decimal(reserve.state.liquidity.mintDecimals.toString());
  const liquidityDeltaLamports = newVaultAllocTokens.sub(prevVaultAllocTokens).mul(new Decimal(10).pow(decimals));
  const action = liquidityDeltaLamports.gt(0) ? 'deposit' : 'withdraw';
  // 4th SDK parameter is referralFeeBps, not compounding - vault deposits
  // carry no referral fee (compounding is applied below via perPeriodAPY)
  const simulatedReserveAPR = reserve.calcSimulatedSupplyAPR(liquidityDeltaLamports.abs(), action, currentSlot, 0);
  const simulatedReserveAPY = calculateAPYFromAPR(simulatedReserveAPR);

  const perPeriodAPY = new Decimal(simulatedReserveAPY).div(compoundPeriods);
  return perPeriodAPY;
}

/// returns the simulated supply farm rewards yield of the reserve if we remove `prevVaultAllocTokens` (which is current allocation) and deposit `newVaultAllocTokens` (which is the new allocation)
export async function evaluateReserveSupplyFarmRewardsYieldWithNewAllocation(
  farmsClient: Farms,
  farmWithKey: FarmAndKey,
  newVaultAllocTokens: Decimal,
  prevVaultAllocTokens: Decimal,
  stakedTokenPrice: Decimal, // cToken price
  tokenDecimals: number,
  pricesMap: Map<Address, Decimal>
): Promise<FarmIncentives> {
  const tokensDelta = newVaultAllocTokens.sub(prevVaultAllocTokens);
  return await farmsClient.simulateFarmIncentivesApy(
    farmWithKey,
    tokensDelta,
    async (mint) => pricesMap.get(mint)!,
    stakedTokenPrice,
    tokenDecimals,
    pricesMap
  );
}

/// returns the simulated supply farm rewards yield of the reserve if we remove `prevVaultAllocTokens` (which is current allocation) and deposit `newVaultAllocTokens` (which is the new allocation). It is the total APY for all farm rewards.
export async function getSimulatedReserveSupplyFarmAPY(
  newReserveAllocTokens: Decimal,
  prevReserveAllocTokens: Decimal,
  reserve: KaminoReserve,
  farmsClient: Farms,
  farmsToFarmStateMap: Map<Address, FarmState>,
  pricesMap: Map<Address, Decimal>
): Promise<Decimal> {
  const farmCollateralAddress = reserve.state.farmCollateral;
  const farmState = farmsToFarmStateMap?.get(farmCollateralAddress);
  if (!farmState) {
    logger.error(`Farm state for reserve ${reserve.address} not found, needs to be fetched`);
    return new Decimal(0);
  }

  const farmAndKey: FarmAndKey = { key: farmCollateralAddress, farmState };
  const liquidityTokenPrice = pricesMap!.get(reserve.state.liquidity.mintPubkey);
  if (!liquidityTokenPrice || liquidityTokenPrice.lte(0)) {
    return new Decimal(0);
  }
  const reserveCtokenPrice = liquidityTokenPrice.div(reserve.getCollateralExchangeRate());
  const tokenDecimals = reserve.state.liquidity.mintDecimals.toNumber();
  const simulatedReserveSupplyFarmAPYAndStats = await evaluateReserveSupplyFarmRewardsYieldWithNewAllocation(
    farmsClient,
    farmAndKey,
    newReserveAllocTokens,
    prevReserveAllocTokens,
    reserveCtokenPrice,
    tokenDecimals,
    pricesMap!
  );
  return new Decimal(simulatedReserveSupplyFarmAPYAndStats.totalIncentivesApy);
}

export async function computeOverallVaultApy(
  normalizedAllocation: Decimal[],
  reservesWithCurrentAllocations: ReserveWithAllocation[],
  allocationWeightsSum: Decimal,
  vaultAUMTokens: Decimal,
  investedInReservesTokens: Map<Address, Decimal>,
  currentSlot: Slot,
  compoundingPeriods: number,
  shouldIncludeFarmRewards: boolean,
  farmsClient: Farms,
  farmsToFarmStateMap?: Map<Address, FarmState>, // if shouldIncludeFarmRewards is true, this is required
  pricesMap?: Map<Address, Decimal>, // if shouldIncludeFarmRewards is true, this is required
  verbose: boolean = false,
  projectionContext?: VaultAllocationProjectionContext
): Promise<Decimal> {
  const allocs = normalizedAllocation.map((alloc) => alloc.mul(allocationWeightsSum));
  if (allocationWeightsSum.eq(0) || vaultAUMTokens.lte(0)) {
    return new Decimal(0);
  }

  const proposedWeights = new Map<Address, Decimal>();
  for (let i = 0; i < allocs.length; i++) {
    proposedWeights.set(reservesWithCurrentAllocations[i].reserve.address, allocs[i]);
  }
  const targetAllocation = projectionContext
    ? computeVaultTargetAllocation(proposedWeights, projectionContext)
    : {
        targetUnallocatedAmount: new Decimal(0),
        targetReservesAllocation: new Map(
          reservesWithCurrentAllocations.map(({ reserve }, index) => [
            reserve.address,
            allocs[index].mul(vaultAUMTokens).div(allocationWeightsSum),
          ])
        ),
      };

  let totalFutureValue = targetAllocation.targetUnallocatedAmount;
  for (const [reserveAddress, newReserveAllocTokens] of targetAllocation.targetReservesAllocation) {
    const currentReserve =
      projectionContext?.allVaultReserves.get(reserveAddress) ??
      reservesWithCurrentAllocations.find(({ reserve }) => reserve.address === reserveAddress)?.reserve;
    if (!currentReserve) {
      throw new Error(`Reserve ${reserveAddress} not found while computing vault APY`);
    }
    const prevReserveAllocTokens = investedInReservesTokens.get(currentReserve.address) ?? new Decimal(0);
    const simulatedReserveSupplyYield = evaluateReserveSupplyYieldWithNewAllocation(
      currentReserve,
      newReserveAllocTokens,
      prevReserveAllocTokens,
      currentSlot,
      compoundingPeriods
    );

    let simulatedReserveSupplyFarmAPY = new Decimal(0);
    if (shouldIncludeFarmRewards && currentReserve.state.farmCollateral !== DEFAULT_PUBLIC_KEY) {
      simulatedReserveSupplyFarmAPY = await getSimulatedReserveSupplyFarmAPY(
        newReserveAllocTokens,
        prevReserveAllocTokens,
        currentReserve,
        farmsClient,
        farmsToFarmStateMap!,
        pricesMap!
      );
    }

    const simulatedReserveSupplyYieldWithFarmRewards = simulatedReserveSupplyYield.add(simulatedReserveSupplyFarmAPY);
    if (verbose) {
      logger.info(
        `[allocation-rebalance-loop] reserve ${reserveAddress} with target tokens ${newReserveAllocTokens.toString()} has lending yield ${simulatedReserveSupplyYield} and farm rewards yield ${simulatedReserveSupplyFarmAPY} and total yield ${simulatedReserveSupplyYieldWithFarmRewards.toString()}`
      );
    }
    const futureValue = newReserveAllocTokens.mul(
      new Decimal(1).add(simulatedReserveSupplyYieldWithFarmRewards).pow(compoundingPeriods)
    );
    totalFutureValue = totalFutureValue.add(futureValue);
  }

  const apy = totalFutureValue.div(vaultAUMTokens).sub(1);
  if (verbose) {
    logger.info(`[allocation-rebalance-loop] overall vault apy: ${apy.toString()}`);
  }
  return apy;
}

export function computeOverallVaultAPYFromReservesMap(
  reservesWithAllocations: Map<Address, Decimal>,
  previousVaultAllocations: Map<Address, Decimal>,
  vaultAUMTokens: Decimal,
  investedInReservesTokens: Map<Address, Decimal>,
  vaultsReserves: Map<Address, KaminoReserve>,
  currentSlot: Slot,
  compoundingPeriods: number,
  verbose: boolean = false,
  projectionContext?: VaultAllocationProjectionContext
): Decimal {
  if (vaultAUMTokens.lte(0)) {
    return new Decimal(0);
  }

  let totalFutureValue = new Decimal(0);
  let allocationWeightsSum = new Decimal(0);
  for (const reserveWithAllocation of reservesWithAllocations) {
    allocationWeightsSum = allocationWeightsSum.add(reserveWithAllocation[1]);
  }
  if (allocationWeightsSum.eq(0)) {
    return new Decimal(0);
  }

  const targetAllocation = projectionContext
    ? computeVaultTargetAllocation(reservesWithAllocations, projectionContext)
    : {
        targetUnallocatedAmount: new Decimal(0),
        targetReservesAllocation: new Map(
          Array.from(reservesWithAllocations, ([reserveAddress, weight]) => [
            reserveAddress,
            weight.mul(vaultAUMTokens).div(allocationWeightsSum),
          ])
        ),
      };
  totalFutureValue = targetAllocation.targetUnallocatedAmount;

  for (const [reserveAddress, newReserveAllocTokens] of targetAllocation.targetReservesAllocation) {
    const reserveState = projectionContext?.allVaultReserves.get(reserveAddress) ?? vaultsReserves.get(reserveAddress);
    if (!reserveState) {
      throw new Error(`Reserve ${reserveAddress} not found in vaultsReserves`);
    }
    const previousAllocation = previousVaultAllocations.get(reserveAddress) ?? new Decimal(0);

    const y = evaluateReserveSupplyYieldWithNewAllocation(
      reserveState,
      newReserveAllocTokens,
      investedInReservesTokens.get(reserveAddress) ?? new Decimal(0),
      currentSlot,
      compoundingPeriods
    );
    if (verbose) {
      logger.info(
        `[allocation-rebalance-loop] reserve ${reserveAddress} with target tokens ${newReserveAllocTokens.toString()} and previous allocation ${previousAllocation.toString()} has yield ${y.toString()}`
      );
    }
    const futureValue = newReserveAllocTokens.mul(new Decimal(1).add(y).pow(compoundingPeriods));
    totalFutureValue = totalFutureValue.add(futureValue);
  }

  return totalFutureValue.div(vaultAUMTokens).sub(1);
}

// compute the stabilization factor for a new allocation, which has the goal of being as small as possible. The stabiliation factor is the sum over the pairwise squared differences between reserve apys with the new allocation
export async function computeStabilizationFactorForVault(
  normalizedAllocation: Decimal[],
  reservesWithCurrentAllocations: ReserveWithAllocation[],
  allocationWeightsSum: Decimal,
  vaultAUMTokens: Decimal,
  investedInReservesTokens: Map<Address, Decimal>,
  currentSlot: Slot,
  compoundingPeriods: number,
  shouldIncludeFarmRewards: boolean,
  farmsClient: Farms,
  farmsToFarmStateMap?: Map<Address, FarmState>, // if shouldIncludeFarmRewards is true, this is required
  pricesMap?: Map<Address, Decimal>, // if shouldIncludeFarmRewards is true, this is required
  verbose: boolean = false,
  projectionContext?: VaultAllocationProjectionContext
): Promise<StabilizationFactorAndAPY> {
  const allocs = normalizedAllocation.map((alloc) => alloc.mul(allocationWeightsSum));
  if (allocationWeightsSum.eq(0) || vaultAUMTokens.lte(0)) {
    return {
      stabilizationFactor: new Decimal(0),
      apy: new Decimal(0),
    };
  }

  const proposedWeights = new Map<Address, Decimal>();
  for (let i = 0; i < allocs.length; i++) {
    proposedWeights.set(reservesWithCurrentAllocations[i].reserve.address, allocs[i]);
  }
  const targetAllocation = projectionContext
    ? computeVaultTargetAllocation(proposedWeights, projectionContext)
    : {
        targetUnallocatedAmount: new Decimal(0),
        targetReservesAllocation: new Map(
          reservesWithCurrentAllocations.map(({ reserve }, index) => [
            reserve.address,
            allocs[index].mul(vaultAUMTokens).div(allocationWeightsSum),
          ])
        ),
      };

  let totalFutureAPY = targetAllocation.targetUnallocatedAmount;
  const newAllocationReserveApys = new Map<Address, Decimal>();
  for (const [reserveAddress, newReserveAllocTokens] of targetAllocation.targetReservesAllocation) {
    const currentReserve =
      projectionContext?.allVaultReserves.get(reserveAddress) ??
      reservesWithCurrentAllocations.find(({ reserve }) => reserve.address === reserveAddress)?.reserve;
    if (!currentReserve) {
      throw new Error(`Reserve ${reserveAddress} not found while computing vault stabilization`);
    }
    const prevReserveAllocTokens = investedInReservesTokens.get(currentReserve.address) ?? new Decimal(0);

    const simulatedReserveSupplyYield = evaluateReserveSupplyYieldWithNewAllocation(
      currentReserve,
      newReserveAllocTokens,
      prevReserveAllocTokens,
      currentSlot,
      compoundingPeriods
    );

    let simulatedReserveSupplyFarmAPY = new Decimal(0);
    if (shouldIncludeFarmRewards && currentReserve.state.farmCollateral !== DEFAULT_PUBLIC_KEY) {
      simulatedReserveSupplyFarmAPY = await getSimulatedReserveSupplyFarmAPY(
        newReserveAllocTokens,
        prevReserveAllocTokens,
        currentReserve,
        farmsClient,
        farmsToFarmStateMap!,
        pricesMap!
      );
    }

    const simulatedReserveSupplyYieldWithFarmRewards = simulatedReserveSupplyYield.add(simulatedReserveSupplyFarmAPY);
    if (verbose) {
      logger.info(
        `[allocation-rebalance-loop] reserve ${reserveAddress} with target tokens ${newReserveAllocTokens.toString()} has lending yield ${simulatedReserveSupplyYield} and farm rewards yield ${simulatedReserveSupplyFarmAPY} and total yield ${simulatedReserveSupplyYieldWithFarmRewards.toString()}`
      );
    }
    if (proposedWeights.has(currentReserve.address)) {
      newAllocationReserveApys.set(currentReserve.address, simulatedReserveSupplyYieldWithFarmRewards);
    }

    const futureValue = newReserveAllocTokens.mul(
      new Decimal(1).add(simulatedReserveSupplyYieldWithFarmRewards).pow(compoundingPeriods)
    );
    totalFutureAPY = totalFutureAPY.add(futureValue);
  }

  let stabilizationFactor = new Decimal(0);
  const reservesList = Array.from(newAllocationReserveApys.keys());
  for (let i = 0; i < reservesList.length; i++) {
    for (let j = i + 1; j < reservesList.length; j++) {
      const apy1 = newAllocationReserveApys.get(reservesList[i])!;
      const apy2 = newAllocationReserveApys.get(reservesList[j])!;
      const apyDiff = apy1.sub(apy2);
      stabilizationFactor = stabilizationFactor.add(apyDiff.pow(2));
    }
  }

  const apy = totalFutureAPY.div(vaultAUMTokens).sub(1);
  if (verbose) {
    logger.info(`[allocation-rebalance-loop] stabilization factor: ${stabilizationFactor.toString()} and apy: ${apy}`);
  }
  return {
    stabilizationFactor,
    apy,
  };
}

export type ReserveWithAllocation = {
  reserve: KaminoReserve;
  allocation: Decimal;
};

export function getVaultTotalAllocationsWeights(kaminoVault: VaultState): Decimal {
  let totalAllocationsWeights = new Decimal(0);
  for (const allocation of kaminoVault.vaultAllocationStrategy.values()) {
    totalAllocationsWeights = totalAllocationsWeights.add(new Decimal(allocation.targetAllocationWeight.toString()));
  }
  return totalAllocationsWeights;
}
