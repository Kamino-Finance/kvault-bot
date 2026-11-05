import { Decimal } from 'decimal.js';
import {
  calculateAPYFromAPR,
  computeReservesAllocation,
  getEffectiveLiquidityAllocationCap,
  DEFAULT_PUBLIC_KEY,
  isCtokenAllocationCapUncapped,
  KaminoReserve,
  LedgerInstant,
  lamportsToDecimal,
  ReserveAllocationForCompute,
  ReserveAllocationOverview,
  toReserveAllocationForCompute,
  VaultAllocationResult,
  VaultState,
} from '@kamino-finance/klend-sdk';
import { Address } from '@solana/kit';
import { logger } from 'kvaults-investing-bot-logger';
import { FarmAndKey, FarmIncentives, Farms, FarmState } from '@kamino-finance/farms-sdk';

export const FULL_BPS = 10_000;

export interface VaultAllocationProjectionContext {
  vaultState: VaultState;
  vaultAUMTokens: Decimal;
  currentVaultAllocations: Map<Address, ReserveAllocationOverview>;
  allVaultReserves: Map<Address, KaminoReserve>;
  currentLedgerInstant: LedgerInstant;
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
  return computeReservesAllocation(
    context.vaultAUMTokens,
    new Decimal(context.vaultState.unallocatedWeight.toString()),
    lamportsToDecimal(
      context.vaultState.unallocatedTokensCap.toString(),
      context.vaultState.tokenMintDecimals.toNumber()
    ),
    getAllocationsForCompute(proposedWeights, context),
    context.vaultState.tokenMintDecimals.toNumber()
  );
}

function getAllocationsForCompute(
  proposedWeights: ReadonlyMap<Address, Decimal>,
  context: VaultAllocationProjectionContext
): Map<Address, ReserveAllocationForCompute> {
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
      collateralExchangeRate = reserve.getEstimatedCollateralExchangeRate(context.currentLedgerInstant, 0);
    }

    allocationsForCompute.set(
      reserveAddress,
      toReserveAllocationForCompute({ ...currentAllocation, targetWeight }, tokenDecimals, collateralExchangeRate)
    );
  }

  return allocationsForCompute;
}

/** Inverts token targets while preserving the healthy weight total, other reserve weights, and the canonical idle target. */
export function computeWeightsForTokenTargets(
  desiredTokens: ReadonlyMap<Address, Decimal>,
  targetWeights: ReadonlyMap<Address, Decimal>,
  context: VaultAllocationProjectionContext,
  totalWeight: Decimal
): Map<Address, Decimal> | undefined {
  const allocations = getAllocationsForCompute(targetWeights, context);
  const fullTarget = computeVaultTargetAllocation(targetWeights, context);
  const tolerance = lamportsToDecimal(1, context.vaultState.tokenMintDecimals.toNumber());
  const weights = new Map<Address, Decimal>();
  const saturated: Address[] = [];
  let availableWeight = totalWeight;
  let desiredTotal = new Decimal(0);
  // SDK water-filling targets are min(capTokens, scale * weight), with scale in tokens per weight unit.
  // An uncapped preserved reserve fixes that scale; a saturated healthy reserve can carry surplus weight.
  let fixedScale: Decimal | undefined;
  let fullScale = new Decimal(0);
  let minimumScale = new Decimal(0);

  for (const [reserve, allocation] of allocations) {
    const cap = getEffectiveLiquidityAllocationCap(
      allocation.tokenAllocationCapTokens,
      allocation.ctokenAllocationCapLiquidityTokens
    );
    const fullTokens = fullTarget.targetReservesAllocation.get(reserve) ?? new Decimal(0);
    if (allocation.targetWeight.gt(0) && fullTokens.gt(0)) {
      const scale = fullTokens.div(allocation.targetWeight);
      fullScale = Decimal.max(fullScale, scale);
      if (!desiredTokens.has(reserve)) {
        if (fullTokens.lt(cap)) fixedScale = scale;
        else minimumScale = Decimal.max(minimumScale, scale);
      }
    }
    if (!desiredTokens.has(reserve)) continue;
    const amount = desiredTokens.get(reserve)!;
    if (!amount.isFinite() || amount.lt(0) || amount.gt(cap)) return undefined;
    if (cap.eq(0)) {
      weights.set(reserve, allocation.targetWeight);
      availableWeight = availableWeight.sub(allocation.targetWeight);
    } else {
      desiredTotal = desiredTotal.add(amount);
      if (amount.eq(cap)) saturated.push(reserve);
    }
  }
  if (availableWeight.lt(0)) return undefined;
  if (desiredTotal.eq(0)) {
    for (const reserve of desiredTokens.keys()) weights.set(reserve, targetWeights.get(reserve) ?? new Decimal(0));
  } else {
    if (availableWeight.lte(0)) return undefined;
    const requiredScale = desiredTotal.div(availableWeight);
    const scale =
      fixedScale ?? (saturated.length > 0 ? Decimal.max(fullScale, requiredScale, minimumScale) : requiredScale);
    if (scale.lte(0) || scale.lt(minimumScale)) return undefined;
    let usedWeight = new Decimal(0);
    for (const [reserve, amount] of desiredTokens) {
      if (weights.has(reserve)) continue;
      const weight = amount.div(scale);
      weights.set(reserve, weight);
      usedWeight = usedWeight.add(weight);
    }
    const remainder = availableWeight.sub(usedWeight);
    // Decimal division can leave a sub-precision weight residue. It must not reject an otherwise exact inverse.
    const weightTolerance = Decimal.max(totalWeight, 1).mul('1e-18');
    if (remainder.lt(weightTolerance.neg()) || (remainder.gt(weightTolerance) && saturated.length === 0))
      return undefined;
    const recipient =
      saturated[0] ??
      [...desiredTokens.keys()].find((reserve) => desiredTokens.get(reserve)!.gt(0) && weights.get(reserve)!.gt(0));
    if (recipient && !remainder.eq(0)) weights.set(recipient, weights.get(recipient)!.add(remainder));
  }

  const projected = computeVaultTargetAllocation(weights, context);
  if (projected.targetUnallocatedAmount.sub(fullTarget.targetUnallocatedAmount).abs().gt(tolerance)) return undefined;
  for (const [reserve, fullTokens] of fullTarget.targetReservesAllocation) {
    const expected = desiredTokens.get(reserve) ?? fullTokens;
    if ((projected.targetReservesAllocation.get(reserve) ?? new Decimal(0)).sub(expected).abs().gt(tolerance))
      return undefined;
  }
  return weights;
}

/** Uses the post-refresh, post-allocation supply for the forward reserve-rewards APR. */
function calculateSimulatedReserveRewardsSupplyAPR(
  reserve: KaminoReserve,
  liquidityDeltaLamports: Decimal,
  currentLedgerInstant: LedgerInstant
): Decimal {
  const simulatedPostAllocationSupplyLamports = reserve
    .getEstimatedTotalSupply(currentLedgerInstant, 0)
    .add(liquidityDeltaLamports);
  if (simulatedPostAllocationSupplyLamports.lte(0)) {
    return new Decimal(0);
  }

  const configuredRewardsAPR = new Decimal(reserve.state.config.rewardsAmountPerAccrualUnit.toString())
    .mul(reserve.accrualUnitsPerYear().toString())
    .div(simulatedPostAllocationSupplyLamports);
  const maxRewardsAPR = new Decimal(reserve.reserveRewardsMaxAprBps).div(FULL_BPS);
  return Decimal.min(configuredRewardsAPR, maxRewardsAPR).mul(reserve.rateAdjustmentFactor());
}

/// returns the simulated supply yield of the reserve if we remove `prevVaultAllocTokens` (which is current allocation) and deposit `newVaultAllocTokens` (which is the new allocation)
export function evaluateReserveSupplyYieldWithNewAllocation(
  reserve: KaminoReserve,
  newVaultAllocTokens: Decimal,
  prevVaultAllocTokens: Decimal,
  currentLedgerInstant: LedgerInstant,
  compoundPeriods: number
): Decimal {
  const decimals = new Decimal(reserve.state.liquidity.mintDecimals.toString());
  const liquidityDeltaLamports = newVaultAllocTokens.sub(prevVaultAllocTokens).mul(new Decimal(10).pow(decimals));
  const action = liquidityDeltaLamports.gt(0) ? 'deposit' : 'withdraw';
  // 4th SDK parameter is referralFeeBps, not compounding - vault deposits
  // carry no referral fee (compounding is applied below via perPeriodAPY)
  const simulatedBorrowInterestSupplyAPR = new Decimal(
    reserve.calcSimulatedSupplyAPR(liquidityDeltaLamports.abs(), action, currentLedgerInstant, 0)
  );
  const simulatedRewardsSupplyAPR = calculateSimulatedReserveRewardsSupplyAPR(
    reserve,
    liquidityDeltaLamports,
    currentLedgerInstant
  );
  const simulatedReserveAPY = calculateAPYFromAPR(
    simulatedBorrowInterestSupplyAPR.add(simulatedRewardsSupplyAPR).toNumber()
  );

  const perPeriodAPY = new Decimal(simulatedReserveAPY).div(compoundPeriods);
  return perPeriodAPY;
}

/// returns the simulated supply farm rewards yield of the reserve if we remove `prevVaultAllocTokens` (which is current allocation) and deposit `newVaultAllocTokens` (which is the new allocation). Both are amounts of the farm's staked token: the reserve's cTokens.
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
  // A zero position earns no farm rewards. The SDK can divide by zero when its simulated farm stake is empty.
  if (newReserveAllocTokens.isZero()) {
    return new Decimal(0);
  }
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
  // cTokens per liquidity token. The supply farm stakes cTokens, so the vault's stake changes by its liquidity change in
  // cTokens.
  const collateralExchangeRate = reserve.getCollateralExchangeRate();
  const reserveCtokenPrice = liquidityTokenPrice.div(collateralExchangeRate);
  const tokenDecimals = reserve.state.liquidity.mintDecimals.toNumber();
  const simulatedReserveSupplyFarmAPYAndStats = await evaluateReserveSupplyFarmRewardsYieldWithNewAllocation(
    farmsClient,
    farmAndKey,
    newReserveAllocTokens.mul(collateralExchangeRate),
    prevReserveAllocTokens.mul(collateralExchangeRate),
    reserveCtokenPrice,
    tokenDecimals,
    pricesMap!
  );
  const farmApy = new Decimal(simulatedReserveSupplyFarmAPYAndStats.totalIncentivesApy);
  if (!farmApy.isFinite()) {
    throw new Error(`Invalid farm APY for reserve ${reserve.address}: ${farmApy}`);
  }
  return farmApy;
}

/** Every APY the bot computes compounds once. */
const COMPOUNDING_PERIODS = 1;

/** The inputs of a yield simulation for one vault. */
export interface VaultYieldSimulation {
  /** The tokens the vault holds in each reserve, including the reserves outside the proposal. */
  investedInReservesTokens: Map<Address, Decimal>;
  currentLedgerInstant: LedgerInstant;
  shouldIncludeFarmRewards: boolean;
  farmsClient: Farms;
  farmsToFarmStateMap?: Map<Address, FarmState>; // if shouldIncludeFarmRewards is true, this is required
  pricesMap?: Map<Address, Decimal>; // if shouldIncludeFarmRewards is true, this is required
  verbose: boolean;
  projectionContext: VaultAllocationProjectionContext;
}

/** The simulated lending and farm yield of `reserve` when the vault moves from `prevTokens` to `newTokens` in it. */
export async function simulateReserveYield(
  reserve: KaminoReserve,
  newTokens: Decimal,
  prevTokens: Decimal,
  sim: VaultYieldSimulation
): Promise<{ lendingYield: Decimal; farmYield: Decimal }> {
  const lendingYield = evaluateReserveSupplyYieldWithNewAllocation(
    reserve,
    newTokens,
    prevTokens,
    sim.currentLedgerInstant,
    COMPOUNDING_PERIODS
  );
  if (!lendingYield.isFinite()) {
    throw new Error(`Invalid lending APY for reserve ${reserve.address}: ${lendingYield}`);
  }
  const farmYield =
    sim.shouldIncludeFarmRewards && reserve.state.farmCollateral !== DEFAULT_PUBLIC_KEY
      ? await getSimulatedReserveSupplyFarmAPY(
          newTokens,
          prevTokens,
          reserve,
          sim.farmsClient,
          sim.farmsToFarmStateMap!,
          sim.pricesMap!
        )
      : new Decimal(0);
  return { lendingYield, farmYield };
}

export interface SimulatedVaultYield {
  apy: Decimal;
  /** The simulated lending plus farm yield of each proposed reserve. */
  reserveYields: Map<Address, Decimal>;
}

/**
 * Projects `proposedWeights` into the token targets the contract invests, then simulates the vault APY and the yield of
 * each proposed reserve. A proposal with a zero weight total, or a vault with no AUM, scores 0.
 */
export async function simulateVaultYield(
  proposedWeights: Map<Address, Decimal>,
  sim: VaultYieldSimulation
): Promise<SimulatedVaultYield> {
  const reserveYields = new Map<Address, Decimal>();
  const proposedWeightTotal = [...proposedWeights.values()].reduce((sum, weight) => sum.add(weight), new Decimal(0));
  const totalVaultAUMTokens = sim.projectionContext.vaultAUMTokens;
  if (proposedWeightTotal.eq(0) || totalVaultAUMTokens.lte(0)) {
    return { apy: new Decimal(0), reserveYields };
  }

  const targetAllocation = computeVaultTargetAllocation(proposedWeights, sim.projectionContext);
  let totalFutureValue = targetAllocation.targetUnallocatedAmount;
  for (const [reserveAddress, newReserveAllocTokens] of targetAllocation.targetReservesAllocation) {
    const currentReserve = sim.projectionContext.allVaultReserves.get(reserveAddress);
    if (!currentReserve) {
      throw new Error(`Reserve ${reserveAddress} not found while computing vault APY`);
    }
    const prevReserveAllocTokens = sim.investedInReservesTokens.get(currentReserve.address) ?? new Decimal(0);
    const { lendingYield: simulatedReserveSupplyYield, farmYield: simulatedReserveSupplyFarmAPY } =
      await simulateReserveYield(currentReserve, newReserveAllocTokens, prevReserveAllocTokens, sim);

    const simulatedReserveSupplyYieldWithFarmRewards = simulatedReserveSupplyYield.add(simulatedReserveSupplyFarmAPY);
    if (sim.verbose) {
      logger.info(
        `[allocation-rebalance-loop] reserve ${reserveAddress} with target tokens ${newReserveAllocTokens.toString()} has lending yield ${simulatedReserveSupplyYield} and farm rewards yield ${simulatedReserveSupplyFarmAPY} and total yield ${simulatedReserveSupplyYieldWithFarmRewards.toString()}`
      );
    }
    if (proposedWeights.has(currentReserve.address)) {
      reserveYields.set(currentReserve.address, simulatedReserveSupplyYieldWithFarmRewards);
    }
    const futureValue = newReserveAllocTokens.mul(
      new Decimal(1).add(simulatedReserveSupplyYieldWithFarmRewards).pow(COMPOUNDING_PERIODS)
    );
    totalFutureValue = totalFutureValue.add(futureValue);
  }

  const apy = totalFutureValue.div(totalVaultAUMTokens).sub(1);
  if (sim.verbose) {
    logger.info(`[allocation-rebalance-loop] overall vault apy: ${apy.toString()}`);
  }
  return { apy, reserveYields };
}

/**
 * The stabilization factor of a set of reserve yields, which the stable search makes as small as possible: the sum of
 * the pairwise squared differences between the yields.
 */
export function computeStabilizationFactor(reserveYields: Map<Address, Decimal>): Decimal {
  let stabilizationFactor = new Decimal(0);
  const yields = Array.from(reserveYields.values());
  for (let i = 0; i < yields.length; i++) {
    for (let j = i + 1; j < yields.length; j++) {
      stabilizationFactor = stabilizationFactor.add(yields[i].sub(yields[j]).pow(2));
    }
  }
  return stabilizationFactor;
}

export type ReserveWithAllocation = {
  reserve: KaminoReserve;
  allocation: Decimal;
};
