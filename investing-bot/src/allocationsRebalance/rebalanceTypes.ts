import { Decimal } from 'decimal.js';

import { KaminoManager, KaminoReserve, KaminoVault, LedgerInstant } from '@kamino-finance/klend-sdk';
import { Address, IInstruction, TransactionSigner } from '@solana/kit';
import { logger } from 'kvaults-investing-bot-logger';
import { Farms, FarmState } from '@kamino-finance/farms-sdk';
import { AllocationWithAPYAndIxs } from './utils/maxYieldOptimizers.js';
import { FixedReservesWithConfig, ReserveWeight } from './rebalanceConfig.js';
import { DEFAULT_ENFORCE_UTILIZATION_CAP, MAX_UTILIZATION_CHANGE_BPS } from './consts.js';
import { buildReservesAllocationLog } from './utils/logging.js';
import { getMaxYieldDrippingAllocationRebalanceIxs } from './strategies/maxYieldDripping.js';
import { buildRebalanceUniverse } from './rebalanceUniverse.js';
import {
  getEqualAllocationRebalanceIxs,
  getFixedWeightsAllocationRebalanceIxs,
  getRandomAllocationRebalanceIxs,
  getUnchangedAllocationRebalanceIxs,
} from './strategies/basic.js';
import {
  getMaxYieldAllocationRebalanceIxs,
  getMaxYieldStabilizationAllocationRebalanceIxs,
} from './strategies/maxYield.js';

export {
  getEqualAllocationRebalanceIxs,
  getFixedWeightsAllocationRebalanceIxs,
  getRandomAllocationRebalanceIxs,
  getUnchangedAllocationRebalanceIxs,
} from './strategies/basic.js';
export {
  getMaxYieldAllocationRebalanceIxs,
  getMaxYieldStabilizationAllocationRebalanceIxs,
} from './strategies/maxYield.js';

export enum RebalanceStrategy {
  EQUAL = 'EQUAL',
  MAX_YIELD = 'MAX_YIELD',
  RANDOM = 'RANDOM',
  MAX_YIELD_WITH_FIXED_RESERVES = 'MAX_YIELD_WITH_FIXED_RESERVES',
  UNCHANGED = 'UNCHANGED', // only useful as the strategy for strategies with fixed reserves
  MAX_YIELD_STABLE = 'MAX_YIELD_STABLE', // achieve aggressive yield but with secondary goal of stabilizing the yields of the reserves
  // add here other allocation strategies
  FIXED_WEIGHTS = 'FIXED_WEIGHTS',
  MAX_YIELD_DRIPPING = 'MAX_YIELD_DRIPPING', // achieve aggressive yield but prevent sharp changes in reserve allocation(smoother APY shifts)
}

export interface RebalanceAllocationRequest {
  kaminoManager: KaminoManager;
  kaminoVault: KaminoVault;
  vaultsReserves: Map<Address, KaminoReserve>;
  strategy: RebalanceStrategy;
  signer: TransactionSigner;
  currentLedgerInstant: LedgerInstant;
  gridSearchResolution: number;
  shouldIncludeFarmRewards: boolean;
  fixedReservesConfig?: FixedReservesWithConfig;
  fixedReservesWeights?: ReserveWeight[];
  drippingRatePercent?: number;
  farmsToFarmStateMap?: Map<Address, FarmState>;
  pricesMap?: Map<Address, Decimal>;
  verbose?: boolean;
  blacklistedReserves?: ReadonlySet<string>;
  cooldownReserves?: ReadonlySet<string>;
  enforceUtilizationCap?: boolean;
  maxUtilizationChangeBps?: number;
}

// abstraction for rebalancing the allocation of a vault
export async function rebalanceAllocation({
  kaminoManager,
  kaminoVault,
  vaultsReserves,
  strategy,
  signer,
  currentLedgerInstant,
  gridSearchResolution,
  shouldIncludeFarmRewards,
  fixedReservesConfig,
  fixedReservesWeights,
  drippingRatePercent,
  farmsToFarmStateMap,
  pricesMap,
  verbose = false,
  blacklistedReserves = new Set(),
  cooldownReserves = new Set(),
  enforceUtilizationCap = DEFAULT_ENFORCE_UTILIZATION_CAP,
  maxUtilizationChangeBps = MAX_UTILIZATION_CHANGE_BPS,
}: RebalanceAllocationRequest): Promise<IInstruction[]> {
  let logMsg = `[allocation-rebalance-loop] Rebalancing allocation for vault ${kaminoVault.address.toString()} with strategy ${strategy}; `;
  const rebalanceUniverse = await buildRebalanceUniverse(
    kaminoManager,
    kaminoVault,
    vaultsReserves,
    signer,
    blacklistedReserves,
    cooldownReserves
  );
  if (rebalanceUniverse.blacklistedVaultReserves.size > 0) {
    logger.warn(
      `[allocation-rebalance-loop] Rebalance universe for vault ${kaminoVault.address.toString()} excludes ${
        rebalanceUniverse.blacklistedVaultReserves.size
      } blacklisted reserve(s)`
    );
  }
  if (rebalanceUniverse.cooldownVaultReserves.size > 0) {
    logger.warn(
      `[allocation-rebalance-loop] Rebalance universe for vault ${kaminoVault.address.toString()} excludes ${
        rebalanceUniverse.cooldownVaultReserves.size
      } reserve(s) in reinvest cooldown (no new allocation this pass)`
    );
  }

  let allocationWithIxsAndApy: AllocationWithAPYAndIxs;
  switch (strategy) {
    case RebalanceStrategy.FIXED_WEIGHTS:
      if (!fixedReservesWeights) {
        throw new Error(
          `Fixed reserve weights are required for FIXED_WEIGHTS strategy on vault ${kaminoVault.address.toString()}`
        );
      }
      allocationWithIxsAndApy = await getFixedWeightsAllocationRebalanceIxs(
        kaminoManager,
        kaminoVault,
        rebalanceUniverse.healthyVaultReserves,
        fixedReservesWeights,
        signer,
        currentLedgerInstant,
        undefined,
        verbose,
        vaultsReserves,
        rebalanceUniverse.blacklistedVaultReserves
      );
      break;
    case RebalanceStrategy.EQUAL:
      allocationWithIxsAndApy = await getEqualAllocationRebalanceIxs(
        kaminoManager,
        kaminoVault,
        rebalanceUniverse.healthyVaultReserves,
        signer,
        currentLedgerInstant,
        undefined,
        verbose,
        vaultsReserves,
        rebalanceUniverse.blacklistedVaultReserves
      );
      break;
    case RebalanceStrategy.MAX_YIELD:
      allocationWithIxsAndApy = await getMaxYieldAllocationRebalanceIxs({
        kaminoManager,
        kaminoVault,
        vaultsReserves: rebalanceUniverse.healthyVaultReserves,
        signer,
        currentLedgerInstant,
        gridSearchResolution,
        shouldIncludeFarmRewards,
        farmsToFarmStateMap,
        pricesMap,
        verbose,
        allVaultReserves: vaultsReserves,
        preservedReserves: rebalanceUniverse.cooldownVaultReserves,
        forcedZeroReserves: rebalanceUniverse.blacklistedVaultReserves,
      });
      break;
    case RebalanceStrategy.RANDOM:
      allocationWithIxsAndApy = await getRandomAllocationRebalanceIxs(
        kaminoManager,
        kaminoVault,
        rebalanceUniverse.healthyVaultReserves,
        signer,
        currentLedgerInstant,
        undefined,
        verbose,
        vaultsReserves,
        rebalanceUniverse.blacklistedVaultReserves
      );
      break;
    case RebalanceStrategy.MAX_YIELD_WITH_FIXED_RESERVES:
      if (!fixedReservesConfig) {
        logger.error(
          `[allocation-rebalance-loop] Fixed reserves and allocation percentage must be provided for MAX_YIELD_WITH_FIXED_RESERVES strategy for vault ${kaminoVault.address.toString()}`
        );
        return rebalanceUniverse.forcedZeroIxs;
      }
      allocationWithIxsAndApy = await getMaxYieldAllocationRebalanceIxs({
        kaminoManager,
        kaminoVault,
        vaultsReserves: rebalanceUniverse.healthyVaultReserves,
        signer,
        currentLedgerInstant,
        gridSearchResolution,
        shouldIncludeFarmRewards,
        compoundingPeriods: 1,
        reservesWithMinAllocation: fixedReservesConfig.fixedReserves,
        minTotalAllocationForSpecifiedReservesBPS: new Decimal(fixedReservesConfig.reservesAllocationPercentageBPS),
        farmsToFarmStateMap,
        pricesMap,
        verbose,
        allVaultReserves: vaultsReserves,
        preservedReserves: rebalanceUniverse.cooldownVaultReserves,
        forcedZeroReserves: rebalanceUniverse.blacklistedVaultReserves,
      });
      break;
    case RebalanceStrategy.UNCHANGED:
      allocationWithIxsAndApy = await getUnchangedAllocationRebalanceIxs(
        kaminoManager,
        kaminoVault,
        rebalanceUniverse.healthyVaultReserves,
        currentLedgerInstant,
        undefined,
        verbose,
        vaultsReserves,
        rebalanceUniverse.blacklistedVaultReserves
      );
      break;
    case RebalanceStrategy.MAX_YIELD_STABLE: {
      // Extract fixed reserves configuration if provided
      const reservesWithMinAllocation = fixedReservesConfig?.fixedReserves || [];
      const minTotalAllocationForSpecifiedReservesBPS = fixedReservesConfig?.reservesAllocationPercentageBPS
        ? new Decimal(fixedReservesConfig.reservesAllocationPercentageBPS)
        : new Decimal(0);

      allocationWithIxsAndApy = await getMaxYieldStabilizationAllocationRebalanceIxs({
        kaminoManager,
        kaminoVault,
        vaultsReserves: rebalanceUniverse.healthyVaultReserves,
        signer,
        currentLedgerInstant,
        gridSearchResolution,
        shouldIncludeFarmRewards,
        compoundingPeriods: 1,
        reservesWithMinAllocation,
        minTotalAllocationForSpecifiedReservesBPS,
        farmsToFarmStateMap,
        pricesMap,
        verbose,
        allVaultReserves: vaultsReserves,
        preservedReserves: rebalanceUniverse.cooldownVaultReserves,
        forcedZeroReserves: rebalanceUniverse.blacklistedVaultReserves,
      });
      break;
    }
    case RebalanceStrategy.MAX_YIELD_DRIPPING: {
      if (fixedReservesConfig && fixedReservesConfig.fixedReserves.length > 0) {
        logger.warn(
          `[allocation-rebalance-loop] Fixed reserves are not supported for MAX_YIELD_DRIPPING; ignoring them for vault ${kaminoVault.address.toString()}`
        );
      }
      allocationWithIxsAndApy = await getMaxYieldDrippingAllocationRebalanceIxs({
        kaminoManager,
        kaminoVault,
        vaultsReserves: rebalanceUniverse.healthyVaultReserves,
        signer,
        currentLedgerInstant,
        gridSearchResolution,
        shouldIncludeFarmRewards,
        drippingRatePercent,
        compoundingPeriods: 1,
        farmsToFarmStateMap,
        pricesMap,
        verbose,
        enforceUtilizationCap,
        maxUtilizationChangeBps,
        allVaultReserves: vaultsReserves,
        preservedReserves: rebalanceUniverse.cooldownVaultReserves,
        forcedZeroReserves: rebalanceUniverse.blacklistedVaultReserves,
      });
      break;
    }
    default:
      throw new Error(`Rebalance strategy ${strategy} not implemented`);
  }

  // just for logging
  const farmsClient = new Farms(kaminoManager.getRpc());
  try {
    logMsg += await buildReservesAllocationLog(
      kaminoManager,
      kaminoVault,
      rebalanceUniverse.healthyVaultReserves,
      allocationWithIxsAndApy.bestAllocation,
      currentLedgerInstant,
      shouldIncludeFarmRewards,
      farmsClient,
      farmsToFarmStateMap,
      pricesMap,
      vaultsReserves,
      rebalanceUniverse.blacklistedVaultReserves
    );
    logger.info(logMsg);
  } catch (error) {
    logger.warn(
      `[allocation-rebalance-loop] Failed to build allocation log for vault ${kaminoVault.address.toString()}: ${error}`
    );
  }

  // Strategies only see healthy reserves; forced-zero ixs enforce blacklist state on-chain.
  return [...allocationWithIxsAndApy.ixns, ...rebalanceUniverse.forcedZeroIxs];
}
