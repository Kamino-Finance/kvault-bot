import { DEFAULT_REBALANCE_FREQUENCY_SECONDS } from '../allocationsRebalance/rebalanceConfig.js';
import { RebalanceStrategy } from '../allocationsRebalance/strategies/index.js';
import { listStrategies, StrategyBehaviours, StrategyDefinition } from '../allocationsRebalance/strategyRegistry.js';
import { RiskAppetiteMode } from '../danger/dangerTypes.js';
import { ConfigFieldSpec } from './schema.js';

// The docs describe the strategies registered when this module loads: the built-ins and a fork's own.
const STRATEGIES: readonly StrategyDefinition[] = listStrategies();

function strategiesWith(predicate: (behaviours: StrategyBehaviours, definition: StrategyDefinition) => boolean) {
  return STRATEGIES.filter((definition) => predicate(definition.behaviours, definition)).map(
    (definition) => definition.name
  );
}

// The FIXED_WEIGHTS strategies come last so the list reads floors first, as the field description does.
const FIXED_RESERVE_FLOORS = strategiesWith(({ fixedReserveFloors }) => fixedReserveFloors);
const FIXED_RESERVE_WEIGHTS = strategiesWith(({ fixedReserveWeights }) => fixedReserveWeights);

/** Every registered strategy's own fields, one spec per name and level, with `strategies` from the registrations. */
function strategyFields(): ConfigFieldSpec[] {
  const fields = new Map<string, ConfigFieldSpec>();
  for (const definition of STRATEGIES) {
    for (const field of definition.configFields) {
      const key = `${field.level}:${field.name}`;
      const known = fields.get(key);
      fields.set(key, {
        ...(known ?? field),
        strategies: [...(known?.strategies ?? []), definition.name],
      });
    }
  }
  return [...fields.values()];
}

/** The name and description of every registered strategy, for the README strategies table. */
export const STRATEGY_DOCS: readonly { name: string; description: string }[] = STRATEGIES.map(
  ({ name, description }) => ({ name, description })
);

/**
 * The fields of `AllocationConfig` (entry) and `VaultWithFixedReserves` (vault object) in `rebalanceConfig.ts`,
 * plus the registered strategies' own fields. A field whose meaning differs per level has one spec per level.
 * Entry-only fields come first, then vault-only fields, then fields that mean the same at both levels, so each
 * generated table keeps its reading order.
 */
export const ALLOCATION_FIELDS: readonly ConfigFieldSpec[] = [
  // Entry only
  {
    name: 'strategy',
    level: 'entry',
    required: true,
    type: 'RebalanceStrategy',
    description: 'One of the strategies above; applied to every vault in the entry.',
  },
  {
    name: 'vaults',
    level: 'entry',
    required: true,
    type: '(string | VaultWithFixedReserves)[]',
    description:
      'Array of vault address strings, and/or objects for per-vault settings (see below). An entry with an empty array is ignored, with a warning.',
  },
  {
    name: 'rebalanceFrequencySeconds',
    level: 'entry',
    required: false,
    type: 'number',
    default: `\`${DEFAULT_REBALANCE_FREQUENCY_SECONDS}\``,
    description:
      'Minimum seconds between rebalances. Set at the entry level, it applies to all vaults in the entry (overriding per-vault values).',
  },
  {
    name: 'includeReservesSupplyFarmRewardsApy',
    level: 'entry',
    required: false,
    type: 'boolean',
    default: '`true`',
    description: 'Include farm-reward APY in the yield computation.',
  },
  {
    name: 'allocationDryRun',
    level: 'entry',
    required: false,
    type: 'boolean',
    default: '`false`',
    description:
      'Compute and log without sending transactions. This value applies to string vault entries. Object vault entries use their own `allocationDryRun` value. The global `ALLOCATION_DRY_RUN=true` forces dry-run for every vault.',
  },
  {
    name: 'riskAppetiteMode',
    level: 'entry',
    required: false,
    type: 'RiskAppetiteMode',
    default: `\`${RiskAppetiteMode.SENSIBLE}\``,
    description:
      'Danger-detection sensitivity for all vaults in the entry: `PARANOID`, `SENSIBLE`, or `YOLO` — see [Danger detection](#danger-detection). An invalid value fails config loading.',
  },

  // Vault object only
  {
    name: 'vault',
    level: 'vault',
    required: true,
    type: 'string',
    description: 'The vault address.',
  },
  {
    name: 'strategy',
    level: 'vault',
    required: false,
    type: 'RebalanceStrategy',
    default: 'entry value',
    description: 'Optional strategy override for this vault; otherwise the entry-level strategy applies.',
  },
  {
    name: 'fixedReserves',
    level: 'vault',
    required: false,
    type: 'string[] | { reserve, weight }[]',
    strategies: [...FIXED_RESERVE_FLOORS, ...FIXED_RESERVE_WEIGHTS],
    description:
      'Reserve address strings — the reserves the search-allocation floor applies to (`MAX_YIELD_WITH_FIXED_RESERVES`, `MAX_YIELD_STABLE`); or `{ reserve, weight }` objects for `FIXED_WEIGHTS`.',
  },
  {
    name: 'reservesAllocationPercentageBPS',
    level: 'vault',
    required: false,
    type: 'number',
    strategies: FIXED_RESERVE_FLOORS,
    description: 'Minimum combined allocation, in basis points, for `fixedReserves`; must be in `[0, 10000]`.',
  },
  {
    name: 'fixedReservesStrategy',
    level: 'vault',
    required: false,
    type: 'RebalanceStrategy',
    default: `\`${RebalanceStrategy.EQUAL}\``,
    description:
      'Metadata only; the fixed-reserve strategies use the explicit floor/weights described above. Must be a known strategy.',
  },
  {
    name: 'includeReservesSupplyFarmRewardsApy',
    level: 'vault',
    required: false,
    type: 'boolean',
    default: 'entry value',
    description: 'Optional farm-reward APY override for this vault.',
  },
  {
    name: 'allocationDryRun',
    level: 'vault',
    required: false,
    type: 'boolean',
    default: '`false`',
    description:
      'Dry-run setting for this object vault, overriding the entry-level value. `ALLOCATION_DRY_RUN=true` still forces dry-run globally.',
  },
  {
    name: 'rebalanceFrequencySeconds',
    level: 'vault',
    required: false,
    type: 'number',
    default: `\`${DEFAULT_REBALANCE_FREQUENCY_SECONDS}\``,
    description: 'Per-vault frequency used only when the entry-level field is omitted; the entry-level value wins.',
  },

  // Both levels
  ...strategyFields(),
  {
    name: 'maxVaultDominanceBps',
    level: 'both',
    required: false,
    type: 'number',
    description:
      "Danger detection: the vault's share of a reserve's total supply, in basis points, at or above which the dominant-depositor trigger forces a pull-out at any risk appetite. Unset keeps the graduated score only. Must be in `(0, 10000]`.",
  },
];
