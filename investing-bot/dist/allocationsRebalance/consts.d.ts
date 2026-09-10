export declare const DEFAULT_ALLOCATIONS_POINTS_RESOLUTION = 0.1;
export declare const DEFAULT_ALLOCATION_WEIGHT = 100000;
export declare const MAX_ALLOCATION_CAP_IN_LAMPORTS = "18446744073709551615";
export declare const DEFAULT_DRIPPING_RATE_PERCENT = 20;
/** Maximum allowed utilization change (absolute) per reserve per rebalance iteration */
export declare const MAX_UTILIZATION_CHANGE_BPS = 100;
/** MAX_YIELD_DRIPPING only: whether the per-reserve utilization-change cap is enforced when not set in the allocation config (opt-in: off by default, existing vaults keep the raw MAX_YIELD target) */
export declare const DEFAULT_ENFORCE_UTILIZATION_CAP = false;
/**
 * Danger detection: the vault's share of a reserve's total supply at and above which the
 * dominant-depositor trigger forces an emergency pull-out, regardless of risk appetite. Undefined by
 * default (opt-in: existing vaults keep the graduated red-flag score, which never fires alone below
 * PARANOID). Set per allocation or per vault as `maxVaultDominanceBps`.
 */
export declare const DEFAULT_MAX_VAULT_DOMINANCE_BPS: number | undefined;
//# sourceMappingURL=consts.d.ts.map