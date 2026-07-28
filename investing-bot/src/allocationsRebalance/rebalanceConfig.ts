import fs from 'fs';
import { logger } from 'kvaults-investing-bot-logger';
import chalk from 'chalk';
import { address, Address } from '@solana/kit';
import { RiskAppetiteMode } from '../danger/dangerTypes.js';
import { RebalanceStrategy } from './rebalanceTypes.js';
import {
  DEFAULT_DRIPPING_RATE_PERCENT,
  DEFAULT_ENFORCE_UTILIZATION_CAP,
  DEFAULT_MAX_VAULT_DOMINANCE_BPS,
  MAX_UTILIZATION_CHANGE_BPS,
} from './consts.js';
import { FULL_BPS } from './utils/allocationHelper.js';

export const DEFAULT_REBALANCE_FREQUENCY_SECONDS = 3600;

// TODO: support passing max allocation for reserve from config

/**
 * Represents a reserve with a fixed weight for FIXED_WEIGHTS strategy
 */
export interface ReserveWeight {
  reserve: string;
  weight: number;
}

/**
 * Represents a vault with fixed reserves configuration
 */
export interface VaultWithFixedReserves {
  vault: string;
  strategy?: RebalanceStrategy;
  fixedReserves?: string[] | ReserveWeight[];
  reservesAllocationPercentageBPS?: number;
  fixedReservesStrategy?: RebalanceStrategy;
  rebalanceFrequencySeconds?: number;
  includeReservesSupplyFarmRewardsApy?: boolean; // if true, the reserve supply APY will be considered as well in the computation of max yield allocation
  allocationDryRun?: boolean; // if true, the allocation will not be executed, only the simulation will be done; if the global (in .env) is true, it will override the per-vault value
  drippingRatePercent?: number; // MAX_YIELD_DRIPPING only: % of the gap between current and MAX_YIELD target weights closed per iteration; defaults to DEFAULT_DRIPPING_RATE_PERCENT
  enforceUtilizationCap?: boolean; // MAX_YIELD_DRIPPING only: whether to cap each reserve's per-iteration utilization change; defaults to DEFAULT_ENFORCE_UTILIZATION_CAP
  maxUtilizationChangeBps?: number; // MAX_YIELD_DRIPPING only: the per-iteration utilization-change cap (when enforced); defaults to MAX_UTILIZATION_CHANGE_BPS
  maxVaultDominanceBps?: number; // Danger detection: vault share of a reserve's total supply (bps) at or above which the dominant-depositor trigger forces a pull-out at any risk appetite; defaults to DEFAULT_MAX_VAULT_DOMINANCE_BPS (unset = graduated score only)
}

/**
 * Represents an allocation configuration for a set of vaults
 */
interface AllocationConfig {
  strategy: RebalanceStrategy;
  vaults: (string | VaultWithFixedReserves)[];
  rebalanceFrequencySeconds?: number; // it should be present for all strategies except MAX_YIELD_WITH_FIXED_RESERVES where it should be per entry in that array
  includeReservesSupplyFarmRewardsApy?: boolean; // if true, the reserve supply APY will be considered as well in the computation of max yield allocation
  allocationDryRun?: boolean; // if true, the allocation will not be executed, only the simulation will be done; if the global (in .env) is true, it will override the per-vault value
  riskAppetiteMode?: RiskAppetiteMode; // PARANOID, SENSIBLE, or YOLO — controls danger detection sensitivity for all vaults in this allocation
  drippingRatePercent?: number; // MAX_YIELD_DRIPPING only: % of the gap between current and MAX_YIELD target weights closed per iteration; defaults to DEFAULT_DRIPPING_RATE_PERCENT
  enforceUtilizationCap?: boolean; // MAX_YIELD_DRIPPING only: whether to cap each reserve's per-iteration utilization change; defaults to DEFAULT_ENFORCE_UTILIZATION_CAP
  maxUtilizationChangeBps?: number; // MAX_YIELD_DRIPPING only: the per-iteration utilization-change cap (when enforced); defaults to MAX_UTILIZATION_CHANGE_BPS
  maxVaultDominanceBps?: number; // Danger detection: vault share of a reserve's total supply (bps) at or above which the dominant-depositor trigger forces a pull-out at any risk appetite; defaults to DEFAULT_MAX_VAULT_DOMINANCE_BPS (unset = graduated score only)
}

export interface AllocationsConfig {
  allocationsConfig: AllocationConfig[];
}

export function readAllocationsConfig(configPath: string): AllocationsConfig {
  const rawConfig = fs.readFileSync(configPath, 'utf8');
  if (!rawConfig || rawConfig.length === 0) {
    logger.warn('[allocation-rebalance-loop] no rebalance allocation config found');
    return { allocationsConfig: [] };
  }
  const config: AllocationsConfig = JSON.parse(rawConfig);
  if (!config || !Array.isArray(config.allocationsConfig) || config.allocationsConfig.length === 0) {
    logger.warn('[allocation-rebalance-loop] no rebalance allocation config found');
    return { allocationsConfig: [] };
  }

  // if any of the configs do not have includeReservesSupplyFarmRewardsApy, set it to true
  const configuredVaults = new Set<string>();
  config.allocationsConfig.forEach((allocation, allocationIndex) => {
    const allocationPath = `allocationsConfig[${allocationIndex}]`;
    validateRebalanceStrategy(allocation.strategy, `${allocationPath}.strategy`);
    validatePositiveFiniteNumber(allocation.rebalanceFrequencySeconds, `${allocationPath}.rebalanceFrequencySeconds`);
    validateDrippingRatePercent(allocation.drippingRatePercent, `${allocationPath}.drippingRatePercent`);
    validateOptionalBoolean(
      allocation.includeReservesSupplyFarmRewardsApy,
      `${allocationPath}.includeReservesSupplyFarmRewardsApy`
    );
    validateOptionalBoolean(allocation.allocationDryRun, `${allocationPath}.allocationDryRun`);
    if (!Array.isArray(allocation.vaults)) {
      throw new Error(`[allocation-rebalance-loop] ${allocationPath}.vaults must be an array`);
    }
    if (allocation.includeReservesSupplyFarmRewardsApy === undefined) {
      allocation.includeReservesSupplyFarmRewardsApy = true;
    }
    if (allocation.allocationDryRun === undefined) {
      allocation.allocationDryRun = false;
    }
    validateRiskAppetiteMode(allocation.riskAppetiteMode);
    validateUtilizationCapConfig(allocation.enforceUtilizationCap, allocation.maxUtilizationChangeBps);
    validateMaxVaultDominanceBps(allocation.maxVaultDominanceBps);
    // Validate object-level overrides and materialize only fields whose legacy representation
    // requires it. Optional farm-reward settings stay undefined so the resolver can inherit the
    // entry-level value.
    allocation.vaults.forEach((vault, vaultIndex) => {
      if (typeof vault !== 'string') {
        const vaultPath = `${allocationPath}.vaults[${vaultIndex}]`;
        if (!vault || typeof vault.vault !== 'string' || vault.vault.length === 0) {
          throw new Error(`[allocation-rebalance-loop] ${vaultPath}.vault must be a non-empty address string`);
        }
        if (vault.strategy !== undefined) {
          validateRebalanceStrategy(vault.strategy, `${vaultPath}.strategy`);
        }
        if (vault.fixedReservesStrategy !== undefined) {
          validateRebalanceStrategy(vault.fixedReservesStrategy, `${vaultPath}.fixedReservesStrategy`);
        }
        validatePositiveFiniteNumber(vault.rebalanceFrequencySeconds, `${vaultPath}.rebalanceFrequencySeconds`);
        validateDrippingRatePercent(vault.drippingRatePercent, `${vaultPath}.drippingRatePercent`);
        validateBps(vault.reservesAllocationPercentageBPS, `${vaultPath}.reservesAllocationPercentageBPS`);
        validateOptionalBoolean(
          vault.includeReservesSupplyFarmRewardsApy,
          `${vaultPath}.includeReservesSupplyFarmRewardsApy`
        );
        validateOptionalBoolean(vault.allocationDryRun, `${vaultPath}.allocationDryRun`);
        if (vault.fixedReserves !== undefined && !Array.isArray(vault.fixedReserves)) {
          throw new Error(`[allocation-rebalance-loop] ${vaultPath}.fixedReserves must be an array`);
        }
        if (vault.fixedReserves !== undefined) {
          validateFixedReserves(vault.fixedReserves, `${vaultPath}.fixedReserves`);
        }
        const effectiveStrategy = vault.strategy ?? allocation.strategy;
        if (effectiveStrategy === RebalanceStrategy.FIXED_WEIGHTS) {
          if (!vault.fixedReserves || !isReserveWeightFormat(vault.fixedReserves)) {
            throw new Error(
              `[allocation-rebalance-loop] ${vaultPath}.fixedReserves must contain { reserve, weight } entries for FIXED_WEIGHTS`
            );
          }
        }
        if (vault.allocationDryRun === undefined) {
          vault.allocationDryRun = false;
        }
        validateUtilizationCapConfig(vault.enforceUtilizationCap, vault.maxUtilizationChangeBps);
        validateMaxVaultDominanceBps(vault.maxVaultDominanceBps);
        // If vault doesn't have its own strategy, inherit from allocation config
        if (vault.strategy === undefined) {
          vault.strategy = allocation.strategy;
        }
      } else if (allocation.strategy === RebalanceStrategy.FIXED_WEIGHTS) {
        throw new Error(
          `[allocation-rebalance-loop] ${allocationPath}.vaults[${vaultIndex}] must be an object with fixedReserves for FIXED_WEIGHTS`
        );
      }

      const vaultAddress = getVaultAddress(vault);
      validateAddress(vaultAddress, `${allocationPath}.vaults[${vaultIndex}].vault`);
      if (configuredVaults.has(vaultAddress)) {
        throw new Error(`[allocation-rebalance-loop] Vault ${vaultAddress} appears multiple times in the config`);
      }
      configuredVaults.add(vaultAddress);
    });
  });

  logger.info('[allocation-rebalance-loop] vault allocation config: ', config);
  return config;
}

export function getAllocationConfig(strategy: string, config: AllocationsConfig): AllocationConfig | undefined {
  return config.allocationsConfig.find((c) => c.strategy === strategy);
}

/**
 * Get the vault address from a vault entry (string or VaultWithFixedReserves)
 */
export function getVaultAddress(vaultEntry: string | VaultWithFixedReserves): string {
  return typeof vaultEntry === 'string' ? vaultEntry : vaultEntry.vault;
}

/**
 * Get the rebalance frequency seconds for a vault entry
 */
export function getRebalanceFrequencySeconds(
  vaultAllocationConfig: AllocationConfig,
  vaultEntry: string | VaultWithFixedReserves
): number {
  if (vaultAllocationConfig.rebalanceFrequencySeconds) {
    return vaultAllocationConfig.rebalanceFrequencySeconds;
  }
  if (typeof vaultEntry !== 'string' && vaultEntry.rebalanceFrequencySeconds) {
    return vaultEntry.rebalanceFrequencySeconds;
  }
  return DEFAULT_REBALANCE_FREQUENCY_SECONDS;
}

export interface FixedReservesWithConfig {
  fixedReserves: Address[];
  reservesAllocationPercentageBPS: number;
  fixedReservesStrategy: RebalanceStrategy;
}
export function getFixedReservesWithConfig(vaultEntry: string | VaultWithFixedReserves): FixedReservesWithConfig {
  if (typeof vaultEntry === 'string') {
    return { fixedReserves: [], reservesAllocationPercentageBPS: 0, fixedReservesStrategy: RebalanceStrategy.EQUAL };
  }
  return {
    fixedReserves: getReserveAddresses(vaultEntry.fixedReserves).map((reserve) => address(reserve)),
    reservesAllocationPercentageBPS: vaultEntry.reservesAllocationPercentageBPS ?? 0,
    fixedReservesStrategy: vaultEntry.fixedReservesStrategy ?? RebalanceStrategy.EQUAL,
  };
}

/**
 * Get the strategy for a vault entry
 */
export function getVaultStrategy(
  vaultEntry: string | VaultWithFixedReserves,
  defaultStrategy: RebalanceStrategy
): RebalanceStrategy {
  return typeof vaultEntry === 'string' ? defaultStrategy : (vaultEntry.strategy ?? defaultStrategy);
}

/**
 * Check if a vault entry has fixed reserves
 */
export function hasFixedReserves(vaultEntry: string | VaultWithFixedReserves): boolean {
  return typeof vaultEntry !== 'string' && Boolean(vaultEntry.fixedReserves?.length);
}

/**
 * Type guard to check if fixedReserves uses the ReserveWeight format (FIXED_WEIGHTS strategy)
 */
export function isReserveWeightFormat(
  fixedReserves: string[] | ReserveWeight[] | undefined
): fixedReserves is ReserveWeight[] {
  return (
    Array.isArray(fixedReserves) &&
    fixedReserves.length > 0 &&
    fixedReserves.every(
      (entry) => typeof entry === 'object' && entry !== null && 'reserve' in entry && 'weight' in entry
    )
  );
}

/**
 * Check if a vault entry uses FIXED_WEIGHTS strategy with reserve weights
 */
export function hasFixedWeights(vaultEntry: string | VaultWithFixedReserves): boolean {
  return (
    typeof vaultEntry !== 'string' &&
    Boolean(vaultEntry.fixedReserves?.length) &&
    isReserveWeightFormat(vaultEntry.fixedReserves)
  );
}

/**
 * Extract reserve addresses from either string[] or ReserveWeight[] format
 */
export function getReserveAddresses(fixedReserves: string[] | ReserveWeight[] | undefined): string[] {
  if (!fixedReserves) {
    return [];
  }
  if (isReserveWeightFormat(fixedReserves)) {
    return fixedReserves.map((rw) => rw.reserve);
  }
  return fixedReserves;
}

export function validateConfiguredReserveMembership(
  vaultAddress: string,
  configuredReserves: readonly string[],
  vaultReserves: readonly Address[]
): void {
  const vaultReserveAddresses = new Set(vaultReserves.map((reserve) => reserve.toString()));
  for (const configuredReserve of configuredReserves) {
    if (!vaultReserveAddresses.has(configuredReserve)) {
      throw new Error(
        `[allocation-rebalance-loop] Configured reserve ${configuredReserve} is not part of vault ${vaultAddress}`
      );
    }
  }
}

/**
 * Get reserve weights configuration for FIXED_WEIGHTS strategy
 */
export function getReserveWeights(vaultEntry: string | VaultWithFixedReserves): ReserveWeight[] | null {
  if (typeof vaultEntry !== 'string' && hasFixedWeights(vaultEntry)) {
    return vaultEntry.fixedReserves as ReserveWeight[];
  }
  return null;
}

/**
 * Get the allocation dry run value for a vault entry
 */
export function getAllocationDryRun(
  vaultAllocationConfig: AllocationConfig,
  vaultEntry: string | VaultWithFixedReserves
): boolean {
  // Individual vault dry run overrides allocation dry run
  if (typeof vaultEntry !== 'string' && vaultEntry.allocationDryRun !== undefined) {
    return vaultEntry.allocationDryRun;
  }
  // Fall back to allocation dry run
  return vaultAllocationConfig.allocationDryRun ?? false;
}

export function getIncludeReservesSupplyFarmRewardsApy(
  vaultAllocationConfig: AllocationConfig,
  vaultEntry: string | VaultWithFixedReserves
): boolean {
  if (typeof vaultEntry !== 'string' && vaultEntry.includeReservesSupplyFarmRewardsApy !== undefined) {
    return vaultEntry.includeReservesSupplyFarmRewardsApy;
  }
  return vaultAllocationConfig.includeReservesSupplyFarmRewardsApy ?? true;
}

/**
 * Get the risk appetite mode for an allocation config.
 * Defaults to SENSIBLE if not specified at any level.
 */
export function getRiskAppetiteMode(vaultAllocationConfig: AllocationConfig): RiskAppetiteMode {
  return vaultAllocationConfig.riskAppetiteMode ?? RiskAppetiteMode.SENSIBLE;
}

/**
 * Risk appetite is read from JSON config, so the TS enum type does not guarantee a valid value at
 * runtime. An invalid value (e.g. a typo) would otherwise flow into RISK_APPETITE_THRESHOLDS as
 * `undefined`, silently disabling danger detection (fail open). Reject it explicitly at load time.
 * An absent (undefined) value is allowed — callers fall back to the SENSIBLE default.
 */
function validateRiskAppetiteMode(value: RiskAppetiteMode | undefined): void {
  if (value !== undefined && !Object.values(RiskAppetiteMode).includes(value)) {
    throw new Error(
      `[allocation-rebalance-loop] Invalid riskAppetiteMode "${value}" in allocation config. ` +
        `Must be one of: ${Object.values(RiskAppetiteMode).join(', ')}`
    );
  }
}

function validateRebalanceStrategy(value: RebalanceStrategy, fieldPath: string): void {
  if (!Object.values(RebalanceStrategy).includes(value)) {
    throw new Error(
      `[allocation-rebalance-loop] Invalid ${fieldPath} "${value}". Must be one of: ${Object.values(
        RebalanceStrategy
      ).join(', ')}`
    );
  }
}

function validatePositiveFiniteNumber(value: number | undefined, fieldPath: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    throw new Error(`[allocation-rebalance-loop] ${fieldPath} must be a finite number greater than 0`);
  }
}

function validateOptionalBoolean(value: unknown, fieldPath: string): void {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new Error(`[allocation-rebalance-loop] ${fieldPath} must be true or false`);
  }
}

function validateDrippingRatePercent(value: number | undefined, fieldPath: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0 || value > 100)) {
    throw new Error(`[allocation-rebalance-loop] ${fieldPath} must be a finite number in (0, 100]`);
  }
}

function validateBps(value: number | undefined, fieldPath: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > FULL_BPS)) {
    throw new Error(`[allocation-rebalance-loop] ${fieldPath} must be a finite number in [0, ${FULL_BPS}]`);
  }
}

function validateReserveWeights(weights: ReserveWeight[], fieldPath: string): void {
  const seenReserves = new Set<string>();
  weights.forEach((weight, index) => {
    if (typeof weight.reserve !== 'string' || !Number.isSafeInteger(weight.weight) || weight.weight < 0) {
      throw new Error(
        `[allocation-rebalance-loop] ${fieldPath}[${index}] must contain a reserve string and a non-negative safe-integer weight`
      );
    }
    if (seenReserves.has(weight.reserve)) {
      throw new Error(`[allocation-rebalance-loop] ${fieldPath} contains duplicate reserve ${weight.reserve}`);
    }
    validateAddress(weight.reserve, `${fieldPath}[${index}].reserve`);
    seenReserves.add(weight.reserve);
  });
}

function validateFixedReserves(fixedReserves: string[] | ReserveWeight[], fieldPath: string): void {
  if (fixedReserves.length === 0) {
    return;
  }
  if (isReserveWeightFormat(fixedReserves)) {
    validateReserveWeights(fixedReserves, fieldPath);
    return;
  }
  if (!fixedReserves.every((reserve) => typeof reserve === 'string')) {
    throw new Error(
      `[allocation-rebalance-loop] ${fieldPath} must contain only reserve address strings or only { reserve, weight } entries`
    );
  }

  const seenReserves = new Set<string>();
  fixedReserves.forEach((reserve, index) => {
    validateAddress(reserve, `${fieldPath}[${index}]`);
    if (seenReserves.has(reserve)) {
      throw new Error(`[allocation-rebalance-loop] ${fieldPath} contains duplicate reserve ${reserve}`);
    }
    seenReserves.add(reserve);
  });
}

function validateAddress(value: string, fieldPath: string): void {
  try {
    address(value);
  } catch (error) {
    throw new Error(`[allocation-rebalance-loop] ${fieldPath} has invalid address "${value}"`, { cause: error });
  }
}

/**
 * Validate the MAX_YIELD_DRIPPING utilization-cap fields (allocation-level or per-vault).
 * Fails config loading on a misconfiguration rather than silently freezing or disabling the cap.
 */
function validateUtilizationCapConfig(enforceUtilizationCap: unknown, maxUtilizationChangeBps: unknown): void {
  if (enforceUtilizationCap !== undefined && typeof enforceUtilizationCap !== 'boolean') {
    throw new Error(
      `[allocation-rebalance-loop] Invalid enforceUtilizationCap "${enforceUtilizationCap}" in allocation config. ` +
        `Must be true or false.`
    );
  }
  if (
    maxUtilizationChangeBps !== undefined &&
    (typeof maxUtilizationChangeBps !== 'number' ||
      !Number.isFinite(maxUtilizationChangeBps) ||
      maxUtilizationChangeBps <= 0 ||
      maxUtilizationChangeBps > FULL_BPS)
  ) {
    throw new Error(
      `[allocation-rebalance-loop] Invalid maxUtilizationChangeBps "${maxUtilizationChangeBps}" in allocation config. ` +
        `Must be a number in (0, ${FULL_BPS}]. To disable the utilization cap, set enforceUtilizationCap to false.`
    );
  }
}

/**
 * Validate the danger-detection dominant-depositor threshold (allocation-level or per-vault).
 * A vault cannot hold more than all of a reserve, so the ceiling is 100%; zero or below would pull
 * out of every reserve unconditionally, which is a misconfiguration rather than a safety setting.
 */
function validateMaxVaultDominanceBps(maxVaultDominanceBps: unknown): void {
  if (
    maxVaultDominanceBps !== undefined &&
    (typeof maxVaultDominanceBps !== 'number' ||
      !Number.isFinite(maxVaultDominanceBps) ||
      maxVaultDominanceBps <= 0 ||
      maxVaultDominanceBps > FULL_BPS)
  ) {
    throw new Error(
      `[allocation-rebalance-loop] Invalid maxVaultDominanceBps "${maxVaultDominanceBps}" in allocation config. ` +
        `Must be a number in (0, ${FULL_BPS}]. Leave it unset to keep the graduated dominant-depositor score.`
    );
  }
}

/**
 * Get the dominant-depositor pull-out threshold (in bps of a reserve's total supply) for a vault
 * entry; the per-vault value overrides the allocation-level value, falling back to the default.
 * Undefined means no hard threshold — the graduated red-flag score applies on its own.
 */
export function getMaxVaultDominanceBps(
  vaultAllocationConfig: AllocationConfig,
  vaultEntry: string | VaultWithFixedReserves
): number | undefined {
  if (typeof vaultEntry !== 'string' && vaultEntry.maxVaultDominanceBps !== undefined) {
    return vaultEntry.maxVaultDominanceBps;
  }
  return vaultAllocationConfig.maxVaultDominanceBps ?? DEFAULT_MAX_VAULT_DOMINANCE_BPS;
}

/**
 * Get the dripping rate percent for a vault entry (MAX_YIELD_DRIPPING strategy);
 * the per-vault value overrides the allocation-level value, falling back to the default
 */
export function getDrippingRatePercent(
  vaultAllocationConfig: AllocationConfig,
  vaultEntry: string | VaultWithFixedReserves
): number {
  if (typeof vaultEntry !== 'string' && vaultEntry.drippingRatePercent !== undefined) {
    return vaultEntry.drippingRatePercent;
  }
  return vaultAllocationConfig.drippingRatePercent ?? DEFAULT_DRIPPING_RATE_PERCENT;
}

/**
 * Get whether the per-reserve utilization-change cap is enforced for a vault entry
 * (MAX_YIELD_DRIPPING strategy); the per-vault value overrides the allocation-level
 * value, falling back to the default
 */
export function getEnforceUtilizationCap(
  vaultAllocationConfig: AllocationConfig,
  vaultEntry: string | VaultWithFixedReserves
): boolean {
  if (typeof vaultEntry !== 'string' && vaultEntry.enforceUtilizationCap !== undefined) {
    return vaultEntry.enforceUtilizationCap;
  }
  return vaultAllocationConfig.enforceUtilizationCap ?? DEFAULT_ENFORCE_UTILIZATION_CAP;
}

/**
 * Get the per-iteration utilization-change cap (in bps) for a vault entry
 * (MAX_YIELD_DRIPPING strategy); the per-vault value overrides the allocation-level
 * value, falling back to the default
 */
export function getMaxUtilizationChangeBps(
  vaultAllocationConfig: AllocationConfig,
  vaultEntry: string | VaultWithFixedReserves
): number {
  if (typeof vaultEntry !== 'string' && vaultEntry.maxUtilizationChangeBps !== undefined) {
    return vaultEntry.maxUtilizationChangeBps;
  }
  return vaultAllocationConfig.maxUtilizationChangeBps ?? MAX_UTILIZATION_CHANGE_BPS;
}

/**
 * Formats seconds into a human-readable duration
 * @param seconds Duration in seconds
 * @returns Formatted duration string
 */
function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds} seconds`;
  } else if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
  } else if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (minutes === 0) {
      return `${hours} hour${hours !== 1 ? 's' : ''}`;
    }
    return `${hours} hour${hours !== 1 ? 's' : ''} ${minutes} minute${minutes !== 1 ? 's' : ''}`;
  } else {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    if (hours === 0) {
      return `${days} day${days !== 1 ? 's' : ''}`;
    }
    return `${days} day${days !== 1 ? 's' : ''} ${hours} hour${hours !== 1 ? 's' : ''}`;
  }
}

/**
 * Prints the allocation configuration in a human-readable format
 * @param config The allocation configuration to print
 */
export function printAllocationsConfig(config: AllocationsConfig): void {
  // If there are no configurations, print a message and return
  if (!config.allocationsConfig || config.allocationsConfig.length === 0) {
    console.log('No allocation configurations found.');
    return;
  }

  console.log(chalk?.bold('🔷 ALLOCATION CONFIGURATIONS') || '🔷 ALLOCATION CONFIGURATIONS');
  console.log('='.repeat(80));

  // Iterate through each allocation configuration
  config.allocationsConfig.forEach((allocation, index) => {
    console.log(chalk?.cyan(`\n📋 Allocation Config #${index + 1}:`) || `\n📋 Allocation Config #${index + 1}:`);
    console.log(`  ${chalk?.bold('Strategy') || 'Strategy'}: ${allocation.strategy}`);

    if (allocation.rebalanceFrequencySeconds) {
      console.log(
        `  ${chalk?.bold('Rebalance Frequency') || 'Rebalance Frequency'}: ${formatDuration(allocation.rebalanceFrequencySeconds)}`
      );
    }

    console.log(
      chalk?.yellow(`  🏦 Vaults (${allocation.vaults.length}):`) || `  🏦 Vaults (${allocation.vaults.length}):`
    );

    // Iterate through each vault in the allocation
    allocation.vaults.forEach((vault, vaultIndex) => {
      console.log(`\n    ${chalk?.green(`Vault #${vaultIndex + 1}:`) || `Vault #${vaultIndex + 1}:`}`);

      // Handle simple string vaults
      if (typeof vault === 'string') {
        console.log(`      ${chalk?.bold('Address') || 'Address'}: ${vault}`);
        console.log(`      ${chalk?.bold('Type') || 'Type'}: Simple vault`);
        console.log(
          `      ${chalk?.bold('Strategy') || 'Strategy'}: ${allocation.strategy} (inherited from allocation)`
        );

        if (allocation.rebalanceFrequencySeconds) {
          console.log(
            `      ${chalk?.bold('Rebalance Frequency') || 'Rebalance Frequency'}: ${formatDuration(allocation.rebalanceFrequencySeconds)} (inherited)`
          );
        }
        if (allocation.includeReservesSupplyFarmRewardsApy !== undefined) {
          console.log(
            `      ${chalk?.bold('Include Reserves Supply Farm Rewards APY') || 'Include Reserves Supply Farm Rewards APY'}: ${allocation.includeReservesSupplyFarmRewardsApy}`
          );
        }
        if (allocation.allocationDryRun !== undefined) {
          console.log(
            `      ${chalk?.bold('Allocation Dry Run') || 'Allocation Dry Run'}: ${allocation.allocationDryRun}`
          );
        }
      }
      // Handle complex vault objects
      else {
        const fixedReserves = vault.fixedReserves ?? [];
        console.log(`      ${chalk?.bold('Address') || 'Address'}: ${vault.vault}`);
        console.log(
          `      ${chalk?.bold('Type') || 'Type'}: Complex vault with ${fixedReserves.length} fixed reserve(s)`
        );
        console.log(`      ${chalk?.bold('Strategy') || 'Strategy'}: ${vault.strategy}`);

        if (vault.rebalanceFrequencySeconds) {
          console.log(
            `      ${chalk?.bold('Rebalance Frequency') || 'Rebalance Frequency'}: ${formatDuration(vault.rebalanceFrequencySeconds)}`
          );
        }

        if (vault.includeReservesSupplyFarmRewardsApy !== undefined) {
          console.log(
            `      ${chalk?.bold('Include Reserves Supply Farm Rewards APY') || 'Include Reserves Supply Farm Rewards APY'}: ${vault.includeReservesSupplyFarmRewardsApy}`
          );
        }

        if (vault.allocationDryRun !== undefined) {
          console.log(`      ${chalk?.bold('Allocation Dry Run') || 'Allocation Dry Run'}: ${vault.allocationDryRun}`);
        }

        if (vault.reservesAllocationPercentageBPS !== undefined) {
          const percentage = (vault.reservesAllocationPercentageBPS / 100).toFixed(2);
          console.log(
            `      ${chalk?.bold('Fixed Reserves Allocation') || 'Fixed Reserves Allocation'}: ${percentage}% (${vault.reservesAllocationPercentageBPS} BPS)`
          );
        }

        if (vault.fixedReservesStrategy) {
          console.log(
            `      ${chalk?.bold('Fixed Reserves Strategy') || 'Fixed Reserves Strategy'}: ${vault.fixedReservesStrategy}`
          );
        }

        console.log(`      ${chalk?.bold('Fixed Reserves') || 'Fixed Reserves'}:`);
        if (isReserveWeightFormat(fixedReserves)) {
          // FIXED_WEIGHTS format - show reserve addresses with weights
          fixedReserves.forEach((reserveWeight, reserveIndex) => {
            console.log(`        ${reserveIndex + 1}. ${reserveWeight.reserve} (weight: ${reserveWeight.weight})`);
          });
        } else {
          // Traditional format - just show reserve addresses
          fixedReserves.forEach((reserve, reserveIndex) => {
            console.log(`        ${reserveIndex + 1}. ${reserve}`);
          });
        }
      }
    });

    console.log('-'.repeat(80));
  });
}
