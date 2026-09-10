import { Address } from '@solana/kit';
import { RiskAppetiteMode } from '../danger/dangerTypes.js';
import { RebalanceStrategy } from './rebalanceTypes.js';
export declare const DEFAULT_REBALANCE_FREQUENCY_SECONDS = 3600;
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
    includeReservesSupplyFarmRewardsApy?: boolean;
    allocationDryRun?: boolean;
    drippingRatePercent?: number;
    enforceUtilizationCap?: boolean;
    maxUtilizationChangeBps?: number;
    maxVaultDominanceBps?: number;
}
/**
 * Represents an allocation configuration for a set of vaults
 */
interface AllocationConfig {
    strategy: RebalanceStrategy;
    vaults: (string | VaultWithFixedReserves)[];
    rebalanceFrequencySeconds?: number;
    includeReservesSupplyFarmRewardsApy?: boolean;
    allocationDryRun?: boolean;
    riskAppetiteMode?: RiskAppetiteMode;
    drippingRatePercent?: number;
    enforceUtilizationCap?: boolean;
    maxUtilizationChangeBps?: number;
    maxVaultDominanceBps?: number;
}
export interface AllocationsConfig {
    allocationsConfig: AllocationConfig[];
}
export declare function readAllocationsConfig(configPath: string): AllocationsConfig;
export declare function getAllocationConfig(strategy: string, config: AllocationsConfig): AllocationConfig | undefined;
/**
 * Get the vault address from a vault entry (string or VaultWithFixedReserves)
 */
export declare function getVaultAddress(vaultEntry: string | VaultWithFixedReserves): string;
/**
 * Get the rebalance frequency seconds for a vault entry
 */
export declare function getRebalanceFrequencySeconds(vaultAllocationConfig: AllocationConfig, vaultEntry: string | VaultWithFixedReserves): number;
export interface FixedReservesWithConfig {
    fixedReserves: Address[];
    reservesAllocationPercentageBPS: number;
    fixedReservesStrategy: RebalanceStrategy;
}
export declare function getFixedReservesWithConfig(vaultEntry: string | VaultWithFixedReserves): FixedReservesWithConfig;
/**
 * Get the strategy for a vault entry
 */
export declare function getVaultStrategy(vaultEntry: string | VaultWithFixedReserves, defaultStrategy: RebalanceStrategy): RebalanceStrategy;
/**
 * Check if a vault entry has fixed reserves
 */
export declare function hasFixedReserves(vaultEntry: string | VaultWithFixedReserves): boolean;
/**
 * Type guard to check if fixedReserves uses the ReserveWeight format (FIXED_WEIGHTS strategy)
 */
export declare function isReserveWeightFormat(fixedReserves: string[] | ReserveWeight[] | undefined): fixedReserves is ReserveWeight[];
/**
 * Check if a vault entry uses FIXED_WEIGHTS strategy with reserve weights
 */
export declare function hasFixedWeights(vaultEntry: string | VaultWithFixedReserves): boolean;
/**
 * Extract reserve addresses from either string[] or ReserveWeight[] format
 */
export declare function getReserveAddresses(fixedReserves: string[] | ReserveWeight[] | undefined): string[];
export declare function validateConfiguredReserveMembership(vaultAddress: string, configuredReserves: readonly string[], vaultReserves: readonly Address[]): void;
/**
 * Get reserve weights configuration for FIXED_WEIGHTS strategy
 */
export declare function getReserveWeights(vaultEntry: string | VaultWithFixedReserves): ReserveWeight[] | null;
/**
 * Get the allocation dry run value for a vault entry
 */
export declare function getAllocationDryRun(vaultAllocationConfig: AllocationConfig, vaultEntry: string | VaultWithFixedReserves): boolean;
export declare function getIncludeReservesSupplyFarmRewardsApy(vaultAllocationConfig: AllocationConfig, vaultEntry: string | VaultWithFixedReserves): boolean;
/**
 * Get the risk appetite mode for an allocation config.
 * Defaults to SENSIBLE if not specified at any level.
 */
export declare function getRiskAppetiteMode(vaultAllocationConfig: AllocationConfig): RiskAppetiteMode;
/**
 * Get the dominant-depositor pull-out threshold (in bps of a reserve's total supply) for a vault
 * entry; the per-vault value overrides the allocation-level value, falling back to the default.
 * Undefined means no hard threshold — the graduated red-flag score applies on its own.
 */
export declare function getMaxVaultDominanceBps(vaultAllocationConfig: AllocationConfig, vaultEntry: string | VaultWithFixedReserves): number | undefined;
/**
 * Get the dripping rate percent for a vault entry (MAX_YIELD_DRIPPING strategy);
 * the per-vault value overrides the allocation-level value, falling back to the default
 */
export declare function getDrippingRatePercent(vaultAllocationConfig: AllocationConfig, vaultEntry: string | VaultWithFixedReserves): number;
/**
 * Get whether the per-reserve utilization-change cap is enforced for a vault entry
 * (MAX_YIELD_DRIPPING strategy); the per-vault value overrides the allocation-level
 * value, falling back to the default
 */
export declare function getEnforceUtilizationCap(vaultAllocationConfig: AllocationConfig, vaultEntry: string | VaultWithFixedReserves): boolean;
/**
 * Get the per-iteration utilization-change cap (in bps) for a vault entry
 * (MAX_YIELD_DRIPPING strategy); the per-vault value overrides the allocation-level
 * value, falling back to the default
 */
export declare function getMaxUtilizationChangeBps(vaultAllocationConfig: AllocationConfig, vaultEntry: string | VaultWithFixedReserves): number;
/**
 * Prints the allocation configuration in a human-readable format
 * @param config The allocation configuration to print
 */
export declare function printAllocationsConfig(config: AllocationsConfig): void;
export {};
//# sourceMappingURL=rebalanceConfig.d.ts.map