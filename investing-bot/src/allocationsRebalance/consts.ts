import { U64_MAX } from '@kamino-finance/klend-sdk';

export const DEFAULT_ALLOCATIONS_POINTS_RESOLUTION = 0.1;
export const DEFAULT_ALLOCATION_WEIGHT = 100_000;
export const MAX_ALLOCATION_CAP_IN_LAMPORTS = U64_MAX;
export const DEFAULT_DRIPPING_RATE_PERCENT = 20; // % of the gap between current and MAX_YIELD target weights closed per iteration; used when drippingRatePercent is not set in the allocation config
/** Maximum allowed utilization change (absolute) per reserve per rebalance iteration */
export const MAX_UTILIZATION_CHANGE_BPS = 100; // 1% = 100 bps
/** MAX_YIELD_DRIPPING only: whether the per-reserve utilization-change cap is enforced when not set in the allocation config (opt-in: off by default, existing vaults keep the raw MAX_YIELD target) */
export const DEFAULT_ENFORCE_UTILIZATION_CAP = false;
/**
 * Danger detection: the vault's share of a reserve's total supply at and above which the
 * dominant-depositor trigger forces an emergency pull-out, regardless of risk appetite. Undefined by
 * default (opt-in: existing vaults keep the graduated red-flag score, which never fires alone below
 * PARANOID). Set per allocation or per vault as `maxVaultDominanceBps`.
 */
export const DEFAULT_MAX_VAULT_DOMINANCE_BPS: number | undefined = undefined;
