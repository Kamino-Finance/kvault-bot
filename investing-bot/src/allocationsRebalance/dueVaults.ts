import { Decimal } from 'decimal.js';
import { KaminoManager, KaminoReserve, KaminoVault, VaultState } from '@kamino-finance/klend-sdk';
import { address, Address, TransactionSigner } from '@solana/kit';
import { logger } from 'kvaults-investing-bot-logger';
import { ConnectionPool } from 'kvaults-investing-bot-tx/ConnectionPool';
import { DEFAULT_PUBLIC_KEY } from 'kvaults-investing-bot-tx/instruction';
import { FarmState, fetchAllMaybeFarmState } from '@kamino-finance/farms-sdk';
import { batchFetch } from '../libs/utils/batch.js';
import { getVaultTokenMints, getWalletBalances } from '../libs/utils/wallet.js';
import type { VaultRebalanceDirective } from '../danger/dangerCoordinator.js';
import { getTokensBatchPrice } from '../utils/price.js';
import { RPC_REQUEST_TIMEOUT_MS, withTimeout } from '../utils/timeout.js';
import { attempt, LoopHeartbeat, yieldAndBeat } from '../utils/loop.js';
import {
  AllocationConfig,
  AllocationsConfig,
  getAllocationDryRun,
  getIncludeReservesSupplyFarmRewardsApy,
  getRebalanceFrequencySeconds,
  getVaultAddress,
  VaultWithFixedReserves,
} from './rebalanceConfig.js';

/**
 * When each vault is due for a rebalance: once its rebalance frequency has passed since its last rebalance, and after a
 * failed attempt once its retry delay has passed. The delay starts at one pass interval, doubles with each failure in a
 * row, and stops at the rebalance frequency. A completed rebalance clears it. Each call reads the clock, so a result
 * counts from when it happened, not from the start of the pass.
 */
export class VaultRebalanceSchedule {
  private readonly lastRebalanceSeconds = new Map<string, number>();
  private readonly failures = new Map<string, { count: number; retryAtSeconds: number }>();

  constructor(
    private readonly passIntervalSeconds: number,
    private readonly nowSeconds: () => number = () => Math.floor(Date.now() / 1000)
  ) {}

  isDue(vault: string, rebalanceFrequencySeconds: number): boolean {
    const nowSeconds = this.nowSeconds();
    const failure = this.failures.get(vault);
    if (failure !== undefined && nowSeconds < failure.retryAtSeconds) {
      return false;
    }
    return nowSeconds - (this.lastRebalanceSeconds.get(vault) ?? 0) > rebalanceFrequencySeconds;
  }

  recordDone(vault: string): void {
    this.lastRebalanceSeconds.set(vault, this.nowSeconds());
    this.failures.delete(vault);
  }

  recordFailure(vault: string, rebalanceFrequencySeconds: number): void {
    const count = (this.failures.get(vault)?.count ?? 0) + 1;
    const delaySeconds = Math.min(this.passIntervalSeconds * 2 ** (count - 1), rebalanceFrequencySeconds);
    this.failures.set(vault, { count, retryAtSeconds: this.nowSeconds() + delaySeconds });
  }
}

/** Whether `signer` may update the weights of the vault's reserves: kvault accepts its allocation or vault admin. */
export function canUpdateAllocations(vaultState: VaultState, signer: Address): boolean {
  return vaultState.allocationAdmin === signer || vaultState.vaultAdminAuthority === signer;
}

/** A configured vault whose rebalance is due this pass. */
export interface DueVault {
  allocation: AllocationConfig;
  vaultEntry: string | VaultWithFixedReserves;
  vaultAddress: string;
  kaminoVault: KaminoVault;
  directive: Extract<VaultRebalanceDirective, { skip: false }>;
  /** The global dry run or the vault's own dry-run setting is on: compute and log, send nothing. */
  vaultDryRun: boolean;
  includeFarmRewards: boolean;
  tokenMint: Address;
  /** The supply farms whose rewards the vault's APY counts. Empty when it counts none. */
  farms: Address[];
}

export interface DueVaultSelection {
  allocationsConfig: AllocationsConfig;
  directiveByVault: ReadonlyMap<string, VaultRebalanceDirective>;
  kaminoVaultsMap: Map<Address, KaminoVault>;
  vaultsReserves: Map<Address, KaminoReserve>;
  kaminoManager: KaminoManager;
  rebalanceSchedule: VaultRebalanceSchedule;
  allocationAdmin: Address;
  globalDryRun: boolean;
  heartbeat?: LoopHeartbeat;
}

/**
 * The configured vaults to rebalance this pass, in config order: assessed and cleared by the danger pass, updatable by
 * the allocation admin unless in dry run, and due by their schedule.
 */
export async function selectDueVaults({
  allocationsConfig,
  directiveByVault,
  kaminoVaultsMap,
  vaultsReserves,
  kaminoManager,
  rebalanceSchedule,
  allocationAdmin,
  globalDryRun,
  heartbeat,
}: DueVaultSelection): Promise<DueVault[]> {
  const dueVaults: DueVault[] = [];
  for (const allocation of allocationsConfig.allocationsConfig) {
    for (const vaultEntry of allocation.vaults) {
      // Yield for each vault entry to prevent blocking
      await yieldAndBeat(heartbeat);

      // Handle different vault entry types
      const vaultAddress = getVaultAddress(vaultEntry);
      logger.info(`[allocation-rebalance-loop] processing vault ${vaultAddress.toString()}`);

      // Skip vaults the danger pass responded to (or could not assess): their directive carries no
      // rebalance sets, so the type system prevents rebalancing them below. Rebalancing a
      // just-responded vault could immediately re-expose it.
      const dangerDirective = directiveByVault.get(vaultAddress);
      if (!dangerDirective || dangerDirective.skip) {
        logger.warn(
          `[allocation-rebalance-loop] Skipping rebalance for vault ${vaultAddress} — danger response executed or vault not assessed this iteration`
        );
        continue;
      }
      const kaminoVault = kaminoVaultsMap.get(address(vaultAddress));
      if (!kaminoVault) continue;
      const vaultState = await kaminoVault.getState();
      const vaultDryRun = globalDryRun || getAllocationDryRun(allocation, vaultEntry);
      // A dry run sends nothing, so only a live rebalance needs a key that can sign the weight updates.
      if (!vaultDryRun && !canUpdateAllocations(vaultState, allocationAdmin)) {
        logger.error(
          `[allocation-rebalance-loop] skipping the rebalance of vault ${vaultAddress}: the configured allocation admin ${allocationAdmin} is neither its allocation admin ${vaultState.allocationAdmin} nor its vault admin ${vaultState.vaultAdminAuthority}, so its weight updates and its emergency zeroing fail`
        );
        continue;
      }
      if (!rebalanceSchedule.isDue(vaultAddress, getRebalanceFrequencySeconds(allocation, vaultEntry))) {
        continue;
      }
      const includeFarmRewards = getIncludeReservesSupplyFarmRewardsApy(allocation, vaultEntry);
      dueVaults.push({
        allocation,
        vaultEntry,
        vaultAddress,
        kaminoVault,
        directive: dangerDirective,
        vaultDryRun,
        includeFarmRewards,
        tokenMint: vaultState.tokenMint,
        farms: includeFarmRewards ? getVaultSupplyFarms(kaminoManager, vaultState, vaultsReserves) : [],
      });
    }
  }
  return dueVaults;
}

/** The supply farms of the vault's reserves. */
function getVaultSupplyFarms(
  kaminoManager: KaminoManager,
  vaultState: VaultState,
  vaultsReserves: Map<Address, KaminoReserve>
): Address[] {
  const farms: Address[] = [];
  for (const reserve of kaminoManager.getVaultReserves(vaultState)) {
    const farm = vaultsReserves.get(reserve)?.state.farmCollateral;
    if (farm !== undefined && farm !== DEFAULT_PUBLIC_KEY) {
      farms.push(farm);
    }
  }
  return farms;
}

/** Supply-farm states and USD prices, the inputs of farm-reward APY. */
export interface FarmData {
  farmToFarmStateMap: Map<Address, FarmState>;
  pricesMap: Map<Address, Decimal>;
}

/**
 * Fetches farm states and reward/vault-token prices. Returns undefined on failure so reward-dependent vaults skip the pass.
 */
export async function fetchFarmData(
  c: ConnectionPool,
  farms: Address[],
  vaultTokenMints: Address[],
  fetchPrices: (mints: Address[]) => Promise<Map<Address, Decimal>> = getTokensBatchPrice
): Promise<FarmData | undefined> {
  const farmsStates = await attempt(
    '[allocation-rebalance-loop] Farm state fetch failed; skipping the vaults that count farm rewards this pass',
    () =>
      withTimeout(
        batchFetch(farms, (chunk) => fetchAllMaybeFarmState(c.getRpc(), chunk)),
        RPC_REQUEST_TIMEOUT_MS,
        '[allocation-rebalance-loop] fetch farm states'
      )
  );
  if (farmsStates === undefined) {
    return undefined;
  }
  const farmToFarmStateMap = new Map<Address, FarmState>();
  const mintsToPrice = new Set<Address>(vaultTokenMints);
  // zip the farms states with the farms list
  farmsStates.forEach((maybeFarmState, index) => {
    if (maybeFarmState.exists) {
      farmToFarmStateMap.set(farms[index], maybeFarmState.data);

      // add reward tokens to the set of all tokens relevant for APY computation
      maybeFarmState.data.rewardInfos.forEach((rewardInfo) => {
        if (rewardInfo.token.mint !== DEFAULT_PUBLIC_KEY) {
          mintsToPrice.add(rewardInfo.token.mint);
        }
      });
    }
  });
  // Every kswap chunk failed: skip rather than allocate on all-zero farm APYs.
  const pricesMap = await attempt(
    '[allocation-rebalance-loop] Price fetch failed; skipping the vaults that count farm rewards this pass',
    () => fetchPrices(Array.from(mintsToPrice))
  );
  if (pricesMap === undefined) {
    return undefined;
  }
  return { farmToFarmStateMap, pricesMap };
}

/** Base units of each vault token the allocation admin keeps: a capped invest makes its payer cover the rounding loss. */
export const MIN_ADMIN_VAULT_TOKEN_BASE_UNITS = 1_000n;

/** The mints of which `balances` holds fewer than MIN_ADMIN_VAULT_TOKEN_BASE_UNITS base units. No token account holds 0. */
export function findUnderfundedMints(mints: Address[], balances: ReadonlyMap<Address, bigint>): Address[] {
  return mints.filter((mint) => (balances.get(mint) ?? 0n) < MIN_ADMIN_VAULT_TOKEN_BASE_UNITS);
}

/**
 * Logs an error for each vault token of which the allocation admin holds too little. The admin pays the rounding loss
 * of the capped invests it sends: the invest after a weight update and the emergency deinvest.
 */
export async function checkAdminVaultTokenBalances(
  c: ConnectionPool,
  allocationAdmin: TransactionSigner,
  vaultStates: VaultState[]
): Promise<void> {
  const mints = getVaultTokenMints(vaultStates);
  const balances = await attempt('[allocation-rebalance-loop] error reading the allocation admin balances', () =>
    withTimeout(
      getWalletBalances(c, mints, allocationAdmin),
      RPC_REQUEST_TIMEOUT_MS,
      '[allocation-rebalance-loop] get allocation admin balances'
    )
  );
  if (balances === undefined) {
    return;
  }
  for (const mint of findUnderfundedMints(
    mints.map(({ mint }) => mint),
    balances
  )) {
    logger.error(
      `[allocation-rebalance-loop] allocation admin ${allocationAdmin.address} holds fewer than ${MIN_ADMIN_VAULT_TOKEN_BASE_UNITS} base units of vault token ${mint}; the capped invests and emergency deinvests it pays for fail without them`
    );
  }
}
