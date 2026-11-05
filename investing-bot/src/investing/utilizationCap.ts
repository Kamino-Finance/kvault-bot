import { Address, address } from '@solana/kit';
import {
  AllocationConfig,
  getVaultAddress,
  getVaultStrategy,
  readAllocationsConfig,
  VaultWithFixedReserves,
} from '../allocationsRebalance/rebalanceConfig.js';
import { getStrategy, resolveStrategyConfig } from '../allocationsRebalance/strategyRegistry.js';
import { resolveUtilizationCap } from '../allocationsRebalance/strategies/maxYieldDripping.js';

export interface InvestUtilizationCap {
  maxUtilizationChangeBps: number;
}

/** Resolves the effective cap for one allocation entry and vault, including in-memory callers. */
export function getInvestUtilizationCap(
  allocation: AllocationConfig,
  vault: string | VaultWithFixedReserves
): InvestUtilizationCap | undefined {
  const strategy = getVaultStrategy(vault, allocation.strategy);
  if (strategy !== 'MAX_YIELD_DRIPPING') return undefined;
  const config = resolveStrategyConfig(getStrategy(strategy)!, allocation, vault);
  const { enforceUtilizationCap, maxUtilizationChangeBps } = resolveUtilizationCap(config);
  return enforceUtilizationCap ? { maxUtilizationChangeBps } : undefined;
}

/** Uses the allocation loop's effective strategy and field precedence. An empty path configures no cap. */
export function readInvestUtilizationCaps(configPath: string): ReadonlyMap<Address, InvestUtilizationCap> {
  const caps = new Map<Address, InvestUtilizationCap>();
  if (configPath.length === 0) return caps;
  for (const allocation of readAllocationsConfig(configPath).allocationsConfig) {
    for (const vault of allocation.vaults) {
      const cap = getInvestUtilizationCap(allocation, vault);
      if (cap) caps.set(address(getVaultAddress(vault)), cap);
    }
  }
  return caps;
}
