import { Decimal } from 'decimal.js';
import { KaminoManager, KaminoReserve, KaminoVault, LedgerInstant } from '@kamino-finance/klend-sdk';
import { FarmState } from '@kamino-finance/farms-sdk';
import { Address } from '@solana/kit';
import type { ConfigFieldSpec } from '../config/schema.js';
import type { FixedReservesWithConfig, ReserveWeight } from './rebalanceConfig.js';
import type { VaultContext } from './strategies/common.js';
import type { DriftResult } from './drift.js';
import type { GridSearchBudget } from './utils/maxYieldOptimizers.js';

/**
 * The drift rate field. registerStrategy attaches it to every strategy that supports drift and has no own rate
 * field.
 */
export const DRIFT_RATE_PERCENT_FIELD: ConfigFieldSpec = {
  name: 'driftRatePercent',
  level: 'both',
  required: false,
  type: 'number',
  description:
    'Percent of the current→target gap closed per iteration; unset applies the target at once. Must be in `(0, 100]`. `MAX_YIELD_DRIPPING` rejects it and uses `drippingRatePercent`. That rejection also fails loading when an entry sets the rate and one of its vault objects overrides the strategy to `MAX_YIELD_DRIPPING`. Set the rate on the other vault objects instead.',
  validate: validateRatePercent,
};

/** A strategy's declared fields resolved for one vault. A field that is not set has no key. */
export type StrategyConfig = Readonly<Record<string, unknown>>;

export interface StrategyContext {
  kaminoManager: KaminoManager;
  kaminoVault: KaminoVault;
  /** The healthy reserves: the only reserves a strategy may allocate to. */
  healthyVaultsReserves: Map<Address, KaminoReserve>;
  /** Every loaded reserve of the vault, including blacklisted and cooldown ones. */
  allVaultReserves: Map<Address, KaminoReserve>;
  /** Blacklisted reserves still in the vault config. The pipeline forces their weight to zero. */
  blacklistedReserves: ReadonlySet<string>;
  /** Reserves in reinvest cooldown. They keep their on-chain weight and receive no new allocation. */
  cooldownReserves: ReadonlySet<string>;
  currentLedgerInstant: LedgerInstant;
  gridSearchResolution: number;
  /** The limits of one MAX_YIELD-family grid search for this vault. */
  gridSearchBudget: GridSearchBudget;
  shouldIncludeFarmRewards: boolean;
  farmsToFarmStateMap?: Map<Address, FarmState>;
  pricesMap?: Map<Address, Decimal>;
  verbose: boolean;
  vaultContext: VaultContext;
  /** The strategy's `configFields`, resolved for this vault: the vault-object value, else the entry value. */
  config: StrategyConfig;
  fixedReservesConfig: FixedReservesWithConfig;
  /** Set only for a strategy with `behaviours.fixedReserveWeights`, from the vault's `{ reserve, weight }` entries. */
  fixedReservesWeights?: ReserveWeight[];
  /** The drift rate in percent the pipeline applies after `computeTarget`. Undefined means no drift. */
  driftRatePercent?: number;
}

export type StrategyAllocationFilter = (weights: Map<Address, Decimal>) => boolean;

export interface StrategyTarget {
  /** One target weight for every healthy reserve of the vault. Drift reads them as shares of their total. */
  weights: Map<Address, Decimal>;
  /**
   * APY of the target allocation, for the allocation log. For a strategy without preserved accounting, the pipeline
   * scores the weights it writes instead.
   */
  apy?: Decimal;
  /**
   * Target gaps at or below this weight, on the vault's current healthy weight scale, are optimizer noise: the drift
   * step stays put.
   */
  noiseFloorWeight?: Decimal;
}

export interface StrategyBehaviours {
  /**
   * True applies deposit and withdrawal bounds while preserving cooldown weights. False only scales target shares
   * to the active weight total. Both paths preserve cooldown reserves' shares.
   */
  preservedAccounting: boolean;
  /** The strategy reads `fixedReserves` and `reservesAllocationPercentageBPS` as search floors. */
  fixedReserveFloors: boolean;
  /** The strategy reads `fixedReserves` as `{ reserve, weight }` entries. The loader requires them. */
  fixedReserveWeights: boolean;
  /** The pipeline may move the current weights only part of the way toward the target on each pass. */
  supportsDrift: boolean;
}

export interface StrategyDefinition {
  name: string;
  /** Markdown text for the README strategies table. */
  description: string;
  configFields: readonly ConfigFieldSpec[];
  behaviours: StrategyBehaviours;
  /** Returns the target allocation, or 'unchanged' to keep the current weights and send no update. */
  computeTarget(ctx: StrategyContext): Promise<StrategyTarget | 'unchanged'>;
  /** Applies a strategy-specific drift baseline. */
  applyDrift?(ctx: StrategyContext, target: StrategyTarget, ratePercent: number): Promise<DriftResult>;
  /** Checks final or unchanged weights before the allocation loop can invest them. */
  getAllocationFilter?(ctx: StrategyContext): StrategyAllocationFilter | undefined;
  /**
   * A strategy with its own drift rate field: one of its `configFields` and the rate in percent when it is unset.
   * The loader then rejects `driftRatePercent` for this strategy.
   */
  ownDriftRate?: { field: string; defaultPercent: number };
}

const registry = new Map<string, StrategyDefinition>();

export function registerStrategy(definition: StrategyDefinition): void {
  if (registry.has(definition.name)) {
    throw new Error(`[allocation-rebalance-loop] Strategy ${definition.name} is already registered`);
  }
  const takesDriftRateField = definition.behaviours.supportsDrift && definition.ownDriftRate === undefined;
  registry.set(definition.name, {
    ...definition,
    configFields: takesDriftRateField
      ? [...definition.configFields, DRIFT_RATE_PERCENT_FIELD]
      : definition.configFields,
  });
}

export function getStrategy(name: string): StrategyDefinition | undefined {
  return registry.get(name);
}

export function listStrategies(): readonly StrategyDefinition[] {
  return [...registry.values()];
}

/** The drift rate fields accept a finite number in (0, 100]. */
export function validateRatePercent(value: unknown, fieldPath: string): void {
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 100)) {
    throw new Error(`[allocation-rebalance-loop] ${fieldPath} must be a finite number in (0, 100]`);
  }
}

/** A field's value for one vault: the vault-object value, else the entry value. Levels limit where it is read. */
export function resolveConfigFieldValue(
  field: Pick<ConfigFieldSpec, 'name' | 'level'>,
  allocationEntry: object,
  vaultEntry: string | object
): unknown {
  const vaultValue =
    field.level !== 'entry' && typeof vaultEntry !== 'string'
      ? (vaultEntry as Record<string, unknown>)[field.name]
      : undefined;
  if (vaultValue !== undefined) {
    return vaultValue;
  }
  return field.level !== 'vault' ? (allocationEntry as Record<string, unknown>)[field.name] : undefined;
}

/** Resolves every declared field of `definition` for one vault. */
export function resolveStrategyConfig(
  definition: StrategyDefinition,
  allocationEntry: object,
  vaultEntry: string | object
): StrategyConfig {
  const config: Record<string, unknown> = {};
  for (const field of definition.configFields) {
    const value = resolveConfigFieldValue(field, allocationEntry, vaultEntry);
    if (value !== undefined) {
      config[field.name] = value;
    }
  }
  return config;
}

/** The drift rate the pipeline applies for one vault, from its resolved config, or undefined for no drift. */
export function resolveDriftRatePercent(definition: StrategyDefinition, config: StrategyConfig): number | undefined {
  if (!definition.behaviours.supportsDrift) {
    return undefined;
  }
  if (definition.ownDriftRate) {
    const ownRate = config[definition.ownDriftRate.field];
    return typeof ownRate === 'number' ? ownRate : definition.ownDriftRate.defaultPercent;
  }
  const value = config[DRIFT_RATE_PERCENT_FIELD.name];
  return typeof value === 'number' ? value : undefined;
}
