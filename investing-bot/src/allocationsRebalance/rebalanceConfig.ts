import fs from 'fs';
import { logger } from 'kvaults-investing-bot-logger';
import { address, Address } from '@solana/kit';
import { RiskAppetiteMode } from '../danger/dangerTypes.js';
import './strategies/index.js';
import { DEFAULT_MAX_VAULT_DOMINANCE_BPS } from './consts.js';
import { FULL_BPS } from './utils/allocationHelper.js';
import {
  DRIFT_RATE_PERCENT_FIELD,
  getStrategy,
  listStrategies,
  resolveConfigFieldValue,
  resolveStrategyConfig,
  StrategyDefinition,
} from './strategyRegistry.js';

export const DEFAULT_REBALANCE_FREQUENCY_SECONDS = 3600;

/**
 * Fields the loader reads on an allocation entry. Anything else is a misplaced or misspelled setting.
 * A field added to AllocationConfig without an entry here is a compile error.
 */
const ALLOCATION_ENTRY_KEYS = {
  strategy: true,
  vaults: true,
  rebalanceFrequencySeconds: true,
  includeReservesSupplyFarmRewardsApy: true,
  allocationDryRun: true,
  riskAppetiteMode: true,
  maxVaultDominanceBps: true,
} satisfies Record<keyof AllocationConfig, true>;

/**
 * Fields the loader reads on a vault object. Anything else is a misplaced or misspelled setting.
 * A field added to VaultWithFixedReserves without an entry here is a compile error.
 */
const VAULT_OBJECT_KEYS = {
  vault: true,
  strategy: true,
  fixedReserves: true,
  reservesAllocationPercentageBPS: true,
  fixedReservesStrategy: true,
  rebalanceFrequencySeconds: true,
  includeReservesSupplyFarmRewardsApy: true,
  allocationDryRun: true,
  maxVaultDominanceBps: true,
} satisfies Record<keyof VaultWithFixedReserves, true>;

/** The registered strategies an entry applies: its own strategy and every vault-object override. */
function entryStrategies(allocation: AllocationConfig): StrategyDefinition[] {
  const names = new Set<string>([allocation.strategy]);
  if (Array.isArray(allocation.vaults)) {
    for (const vault of allocation.vaults) {
      if (vault !== null && typeof vault === 'object' && typeof vault.strategy === 'string') {
        names.add(vault.strategy);
      }
    }
  }
  return [...names].flatMap((name) => getStrategy(name) ?? []);
}

/** The known keys at one level: the common fields plus the fields that `strategies` declare at that level. */
function knownKeys(
  commonKeys: object,
  level: 'entry' | 'vault',
  strategies: readonly StrategyDefinition[]
): ReadonlySet<string> {
  const keys = new Set(Object.keys(commonKeys));
  for (const definition of strategies) {
    for (const field of definition.configFields) {
      if (field.level === level || field.level === 'both') {
        keys.add(field.name);
      }
    }
  }
  return keys;
}

/** Runs the validator of every field that `strategies` declare at this level and `value` sets. */
function validateStrategyFields(
  value: object,
  level: 'entry' | 'vault',
  fieldPath: string,
  strategies: readonly StrategyDefinition[]
): void {
  const record = value as Record<string, unknown>;
  const validated = new Set<string>();
  for (const definition of strategies) {
    for (const field of definition.configFields) {
      if (field.level !== level && field.level !== 'both') {
        continue;
      }
      if (record[field.name] === undefined || validated.has(field.name)) {
        continue;
      }
      validated.add(field.name);
      field.validate?.(record[field.name], `${fieldPath}.${field.name}`);
    }
  }
}

/**
 * Log unknown settings without rejecting the config, so danger detection can continue. Unknown settings use defaults.
 */
function reportUnknownKeys(value: object, knownKeys: ReadonlySet<string>, fieldPath: string): void {
  for (const key of Object.keys(value)) {
    if (!knownKeys.has(key)) {
      logger.error(
        `[allocation-rebalance-loop] ${fieldPath} has unknown field "${key}"; it is ignored and the default applies`
      );
    }
  }
}

/** A strategy name. The loader accepts any registered name; `RebalanceStrategy` names the built-ins. */
export type StrategyName = string;

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
  strategy?: StrategyName;
  fixedReserves?: string[] | ReserveWeight[];
  reservesAllocationPercentageBPS?: number;
  fixedReservesStrategy?: StrategyName;
  rebalanceFrequencySeconds?: number;
  includeReservesSupplyFarmRewardsApy?: boolean; // if true, the reserve supply APY will be considered as well in the computation of max yield allocation
  allocationDryRun?: boolean; // if true, the allocation will not be executed, only the simulation will be done; if the global (in .env) is true, it will override the per-vault value
  maxVaultDominanceBps?: number; // Danger detection: vault share of a reserve's total supply (bps) at or above which the dominant-depositor trigger forces a pull-out at any risk appetite; defaults to DEFAULT_MAX_VAULT_DOMINANCE_BPS (unset = graduated score only)
}

/**
 * Represents an allocation configuration for a set of vaults
 */
export interface AllocationConfig {
  strategy: StrategyName;
  vaults: (string | VaultWithFixedReserves)[];
  rebalanceFrequencySeconds?: number; // applies to every vault of the entry and wins over a vault-level value
  includeReservesSupplyFarmRewardsApy?: boolean; // if true, the reserve supply APY will be considered as well in the computation of max yield allocation
  allocationDryRun?: boolean; // if true, the allocation will not be executed, only the simulation will be done; if the global (in .env) is true, it will override the per-vault value
  riskAppetiteMode?: RiskAppetiteMode; // PARANOID, SENSIBLE, or YOLO — controls danger detection sensitivity for all vaults in this allocation
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

  const configuredVaults = new Set<string>();
  config.allocationsConfig.forEach((allocation, allocationIndex) => {
    const allocationPath = `allocationsConfig[${allocationIndex}]`;
    const strategiesOfEntry = entryStrategies(allocation);
    reportUnknownKeys(allocation, knownKeys(ALLOCATION_ENTRY_KEYS, 'entry', strategiesOfEntry), allocationPath);
    validateRebalanceStrategy(allocation.strategy, `${allocationPath}.strategy`);
    validatePositiveFiniteNumber(allocation.rebalanceFrequencySeconds, `${allocationPath}.rebalanceFrequencySeconds`);
    validateStrategyFields(allocation, 'entry', allocationPath, strategiesOfEntry);
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
        const effectiveStrategy = vault.strategy ?? allocation.strategy;
        const effectiveDefinition = getStrategy(effectiveStrategy)!;
        reportUnknownKeys(vault, knownKeys(VAULT_OBJECT_KEYS, 'vault', [effectiveDefinition]), vaultPath);
        if (vault.fixedReservesStrategy !== undefined) {
          validateRebalanceStrategy(vault.fixedReservesStrategy, `${vaultPath}.fixedReservesStrategy`);
        }
        validatePositiveFiniteNumber(vault.rebalanceFrequencySeconds, `${vaultPath}.rebalanceFrequencySeconds`);
        validateStrategyFields(vault, 'vault', vaultPath, [effectiveDefinition]);
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
        const effectiveBehaviours = effectiveDefinition.behaviours;
        if (effectiveBehaviours.fixedReserveWeights) {
          if (!vault.fixedReserves || !isReserveWeightFormat(vault.fixedReserves)) {
            throw new Error(
              `[allocation-rebalance-loop] ${vaultPath}.fixedReserves must contain { reserve, weight } entries for ${effectiveStrategy}`
            );
          }
        }
        // Log unsupported floors without rejecting the config, so danger detection can continue.
        // FIXED_WEIGHTS uses fixedReserves as weights, so only its percentage floor is ignored.
        const hasIgnoredFloorSettings = effectiveBehaviours.fixedReserveWeights
          ? vault.reservesAllocationPercentageBPS !== undefined
          : (vault.fixedReserves !== undefined && vault.fixedReserves.length > 0) ||
            vault.reservesAllocationPercentageBPS !== undefined;
        if (hasIgnoredFloorSettings && !effectiveBehaviours.fixedReserveFloors) {
          logger.error(
            `[allocation-rebalance-loop] ${vaultPath} sets fixedReserves or reservesAllocationPercentageBPS but its strategy ${effectiveStrategy} ignores them; use MAX_YIELD_WITH_FIXED_RESERVES or MAX_YIELD_STABLE`
          );
        }
        if (vault.allocationDryRun === undefined) {
          vault.allocationDryRun = false;
        }
        validateMaxVaultDominanceBps(vault.maxVaultDominanceBps);
        // If vault doesn't have its own strategy, inherit from allocation config
        if (vault.strategy === undefined) {
          vault.strategy = allocation.strategy;
        }
      } else if (getStrategy(allocation.strategy)!.behaviours.fixedReserveWeights) {
        throw new Error(
          `[allocation-rebalance-loop] ${allocationPath}.vaults[${vaultIndex}] must be an object with fixedReserves for ${allocation.strategy}`
        );
      }
      validateDriftRatePercentForStrategy(allocation, vault, `${allocationPath}.vaults[${vaultIndex}]`);
      logIgnoredUtilizationCapThreshold(allocation, vault, `${allocationPath}.vaults[${vaultIndex}]`);

      const vaultAddress = getVaultAddress(vault);
      validateAddress(vaultAddress, `${allocationPath}.vaults[${vaultIndex}].vault`);
      if (configuredVaults.has(vaultAddress)) {
        throw new Error(`[allocation-rebalance-loop] Vault ${vaultAddress} appears multiple times in the config`);
      }
      configuredVaults.add(vaultAddress);
    });
  });
  // An entry without vaults rebalances nothing, and the loop reads the first vault of each entry.
  config.allocationsConfig = config.allocationsConfig.filter((allocation, allocationIndex) => {
    if (allocation.vaults.length > 0) {
      return true;
    }
    logger.warn(`[allocation-rebalance-loop] allocationsConfig[${allocationIndex}] lists no vaults; ignoring it`);
    return false;
  });

  logger.info('[allocation-rebalance-loop] vault allocation config: ', config);
  return config;
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
}
export function getFixedReservesWithConfig(vaultEntry: string | VaultWithFixedReserves): FixedReservesWithConfig {
  if (typeof vaultEntry === 'string') {
    return { fixedReserves: [], reservesAllocationPercentageBPS: 0 };
  }
  return {
    fixedReserves: getReserveAddresses(vaultEntry.fixedReserves).map((reserve) => address(reserve)),
    reservesAllocationPercentageBPS: vaultEntry.reservesAllocationPercentageBPS ?? 0,
  };
}

/**
 * Get the strategy for a vault entry
 */
export function getVaultStrategy(
  vaultEntry: string | VaultWithFixedReserves,
  defaultStrategy: StrategyName
): StrategyName {
  return typeof vaultEntry === 'string' ? defaultStrategy : (vaultEntry.strategy ?? defaultStrategy);
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
export function getReserveWeights(vaultEntry: string | VaultWithFixedReserves): ReserveWeight[] | undefined {
  return typeof vaultEntry !== 'string' && isReserveWeightFormat(vaultEntry.fixedReserves)
    ? vaultEntry.fixedReserves
    : undefined;
}

/**
 * Get the allocation dry run value for a vault entry
 */
export function getAllocationDryRun(
  vaultAllocationConfig: AllocationConfig,
  vaultEntry: string | VaultWithFixedReserves
): boolean {
  // An object vault uses its own value; the loader sets it to false when unset, so it never inherits the entry's.
  if (typeof vaultEntry !== 'string' && vaultEntry.allocationDryRun !== undefined) {
    return vaultEntry.allocationDryRun;
  }
  // A string vault entry uses the entry-level value.
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

function validateRebalanceStrategy(value: unknown, fieldPath: string): void {
  if (typeof value !== 'string' || getStrategy(value) === undefined) {
    throw new Error(
      `[allocation-rebalance-loop] Invalid ${fieldPath} "${value}". Must be one of: ${listStrategies()
        .map((definition) => definition.name)
        .join(', ')}`
    );
  }
}

/**
 * Log an inactive utilization threshold without rejecting the config, so danger detection can continue.
 */
function logIgnoredUtilizationCapThreshold(
  allocation: AllocationConfig,
  vault: string | VaultWithFixedReserves,
  path: string
): void {
  const config = resolveStrategyConfig(getStrategy(getVaultStrategy(vault, allocation.strategy))!, allocation, vault);
  if (config.maxUtilizationChangeBps !== undefined && config.enforceUtilizationCap !== true) {
    logger.error(
      `[allocation-rebalance-loop] ${path} sets maxUtilizationChangeBps but not enforceUtilizationCap: true, so the utilization cap stays off`
    );
  }
}

function validateDriftRatePercentForStrategy(
  allocation: AllocationConfig,
  vaultEntry: string | VaultWithFixedReserves,
  vaultPath: string
): void {
  if (resolveConfigFieldValue(DRIFT_RATE_PERCENT_FIELD, allocation, vaultEntry) === undefined) {
    return;
  }
  const strategy = getVaultStrategy(vaultEntry, allocation.strategy);
  const { ownDriftRate } = getStrategy(strategy)!;
  if (ownDriftRate) {
    throw new Error(
      `[allocation-rebalance-loop] ${vaultPath} gets driftRatePercent, but its strategy ${strategy} sets its drift rate with ${ownDriftRate.field}; remove driftRatePercent and set ${ownDriftRate.field} instead`
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
