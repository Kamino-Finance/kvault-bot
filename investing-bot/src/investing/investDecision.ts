import { Decimal } from 'decimal.js';
import { KaminoManager, KaminoReserve, KaminoVault, LedgerInstant } from '@kamino-finance/klend-sdk';
import { Address } from '@solana/kit';
import { logger } from 'kvaults-investing-bot-logger';
import { shouldBlockVaultInvestmentForDangerNow } from '../danger/vaultExposure.js';
import { ReserveInvestCooldowns } from '../utils/investReserves.js';
import { attempt } from '../utils/loop.js';
import { getMinimumSlotsForDurationSeconds } from '../utils/solanaUtils.js';
import { RPC_REQUEST_TIMEOUT_MS, withTimeout } from '../utils/timeout.js';
import { getMissingVaultReserves } from '../utils/vaultReserves.js';
import { depositsInto } from '../utils/noNewFunds.js';

/** Why the invest loop leaves a vault alone for one pass. */
export enum VaultInvestSkip {
  MissingReserves = 'missingReserves',
  HoldingsUnavailable = 'holdingsUnavailable',
  Danger = 'danger',
  AllocationUnavailable = 'allocationUnavailable',
  BelowMinInvest = 'belowMinInvest',
}

export interface VaultInvestDecision {
  /** Why the vault is left alone this pass; `undefined` when the loop should invest it. */
  skip: VaultInvestSkip | undefined;
  /** Whether the vault's target allocation was computed, which counts as a work cycle for the slot-duration refresh. */
  allocationComputed: boolean;
}

export interface VaultInvestDecisionInputs {
  kaminoManager: KaminoManager;
  /** The danger blacklist file; the invest gate reads it for each vault. */
  blacklistPath: string;
  reserveInvestCooldowns: ReserveInvestCooldowns;
  vaultsReserves: Map<Address, KaminoReserve>;
  currentLedgerInstant: LedgerInstant;
  minInvestTokens: number;
  /** Reserves that get no new funds, from the allocation loop's last danger pass; empty without that loop. */
  noNewFundsReserves: ReadonlySet<string>;
}

export interface VaultInvestTimeGateInputs {
  kaminoManager: KaminoManager;
  currentLedgerInstant: LedgerInstant;
  lastSentInvestSlot: Decimal | undefined;
  minSecondsSinceLastInvest: number;
  bypassConfigMinSlots: boolean;
}

/**
 * Checks invest delays from vault state before loading reserves.
 */
export function isVaultInvestDue(
  vault: KaminoVault,
  {
    kaminoManager,
    currentLedgerInstant,
    lastSentInvestSlot,
    minSecondsSinceLastInvest,
    bypassConfigMinSlots,
  }: VaultInvestTimeGateInputs
): boolean {
  const vaultState = vault.state!;
  let latestInvestedSlot = new Decimal(0);
  vaultState.vaultAllocationStrategy.forEach((allocation) => {
    const allocationLastInvestSlot = new Decimal(allocation.lastInvestSlot.toString());
    if (allocationLastInvestSlot.gt(latestInvestedSlot)) {
      latestInvestedSlot = allocationLastInvestSlot;
    }
  });
  return isInvestDueBySlots({
    currentSlot: new Decimal(currentLedgerInstant.slot.toString()),
    onChainLastInvestSlot: latestInvestedSlot,
    lastSentInvestSlot,
    configMinSlotsSinceLastInvest: getMinimumSlotsForDurationSeconds(
      minSecondsSinceLastInvest,
      kaminoManager.recentSlotDurationMs
    ),
    vaultMinInvestDelaySlots: new Decimal(vaultState.minInvestDelaySlots.toString()),
    bypassConfigMinSlots,
  });
}

/**
 * Decides whether the invest loop invests a vault that is due (isVaultInvestDue) this pass. A failed read skips only
 * this vault.
 */
export async function decideVaultInvest(
  vault: KaminoVault,
  vaultReservesPubkeys: Address[],
  {
    kaminoManager,
    blacklistPath,
    reserveInvestCooldowns,
    vaultsReserves,
    currentLedgerInstant,
    minInvestTokens,
    noNewFundsReserves,
  }: VaultInvestDecisionInputs
): Promise<VaultInvestDecision> {
  const vaultState = vault.state!;
  const missingReserves = getMissingVaultReserves(vaultReservesPubkeys, vaultsReserves);
  if (missingReserves.length > 0) {
    // The SDK throws on a missing reserve; a vault whose reserve batch failed to load waits for the next pass.
    logger.error(
      `[investing-loop] skipping vault ${vault.address} this pass: ${missingReserves.length} reserve(s) failed to load: ${missingReserves.join(', ')}`
    );
    return { skip: VaultInvestSkip.MissingReserves, allocationComputed: false };
  }

  const vaultHoldings = await attempt(
    `[investing-loop] error reading holdings of vault ${vault.address}; skipping it this pass`,
    () =>
      withTimeout(
        kaminoManager.getVaultHoldings(vaultState, currentLedgerInstant, vaultsReserves, currentLedgerInstant),
        RPC_REQUEST_TIMEOUT_MS,
        `[investing-loop] get vault holdings ${vault.address}`
      )
  );
  if (vaultHoldings === undefined) {
    return { skip: VaultInvestSkip.HoldingsUnavailable, allocationComputed: false };
  }
  if (
    shouldBlockVaultInvestmentForDangerNow(
      blacklistPath,
      kaminoManager,
      vault.address,
      vaultState,
      vaultHoldings.investedInReserves
    )
  ) {
    logger.warn(
      `[investing-loop] skipping vault ${vault.address}: it has a pending evacuation or remaining blacklisted exposure`
    );
    return { skip: VaultInvestSkip.Danger, allocationComputed: false };
  }
  const theoreticalComputedAllocation = await attempt(
    `[investing-loop] error computing the allocation of vault ${vault.address}; skipping it this pass`,
    () =>
      withTimeout(
        kaminoManager.getVaultComputedReservesAllocation(
          vaultState,
          currentLedgerInstant,
          vaultsReserves,
          currentLedgerInstant
        ),
        RPC_REQUEST_TIMEOUT_MS,
        `[investing-loop] get computed allocation ${vault.address}`
      )
  );
  if (theoreticalComputedAllocation === undefined) {
    return { skip: VaultInvestSkip.AllocationUnavailable, allocationComputed: false };
  }

  // for each reserve compute the diffTokens between holdings and theoretical allocation and sum the net diffTokens
  let totalDiffTokens = new Decimal(0);
  // if there are no reserves or all have weight 0 everything should be available
  const allAllocationsZero = Array.from(theoreticalComputedAllocation.targetReservesAllocation.values()).every(
    (allocation) => allocation.eq(0)
  );

  if (vaultReservesPubkeys.length === 0 || allAllocationsZero) {
    // Everything is disinvested, except from a reserve on cooldown: it gets no instruction this pass, so its holding
    // must not trigger a plan on its own.
    for (const [reserve, investedTokens] of vaultHoldings.investedInReserves) {
      if (!reserveInvestCooldowns.isCoolingDown(reserve, vault.address)) {
        totalDiffTokens = totalDiffTokens.plus(investedTokens);
      }
    }
  } else {
    // The SDK caps withdrawals at available liquidity, so an illiquid reserve need not block other moves.
    // Count max(deposits, withdrawals) to include idle withdrawals without counting reserve transfers twice.
    // Exclude cooldown moves, blocked deposits, and withdrawals that only fund those deposits.
    // Deposits are checked again against the SDK snapshot before sending.
    const droppedDeposits = depositsInto(
      noNewFundsReserves,
      theoreticalComputedAllocation.targetReservesAllocation,
      vaultHoldings.investedInReserves
    );
    let depositTokens = new Decimal(0);
    let withdrawalTokens = new Decimal(0);
    let unsentDepositTokens = new Decimal(0);
    theoreticalComputedAllocation.targetReservesAllocation.forEach((allocation, reserve) => {
      const diffTokens = allocation.minus(vaultHoldings.investedInReserves.get(reserve)!);
      if (reserveInvestCooldowns.isCoolingDown(reserve, vault.address)) {
        unsentDepositTokens = unsentDepositTokens.plus(Decimal.max(0, diffTokens));
      } else if (droppedDeposits.has(reserve)) {
        unsentDepositTokens = unsentDepositTokens.plus(diffTokens);
      } else if (diffTokens.gt(0)) {
        depositTokens = depositTokens.plus(diffTokens);
      } else {
        withdrawalTokens = withdrawalTokens.minus(diffTokens);
      }
    });
    totalDiffTokens = Decimal.max(depositTokens, withdrawalTokens.minus(unsentDepositTokens));
  }

  if (!totalDiffTokens.gt(minInvestTokens)) {
    return { skip: VaultInvestSkip.BelowMinInvest, allocationComputed: true };
  }
  return { skip: undefined, allocationComputed: true };
}

/**
 * Whether enough slots have passed since the vault's last invest. The configured minimum counts from the later of the
 * on-chain `lastInvestSlot` and this loop's last landed invest: kvault does not update `lastInvestSlot` when the
 * `max_amount` cap limits the move. The vault's own delay counts from the on-chain slot only, as in the program.
 */
export function isInvestDueBySlots({
  currentSlot,
  onChainLastInvestSlot,
  lastSentInvestSlot,
  configMinSlotsSinceLastInvest,
  vaultMinInvestDelaySlots,
  bypassConfigMinSlots,
}: {
  currentSlot: Decimal;
  onChainLastInvestSlot: Decimal;
  lastSentInvestSlot: Decimal | undefined;
  configMinSlotsSinceLastInvest: Decimal;
  vaultMinInvestDelaySlots: Decimal;
  bypassConfigMinSlots: boolean;
}): boolean {
  const lastInvestSlot =
    lastSentInvestSlot === undefined ? onChainLastInvestSlot : Decimal.max(onChainLastInvestSlot, lastSentInvestSlot);
  if (currentSlot.minus(lastInvestSlot).lessThan(configMinSlotsSinceLastInvest) && !bypassConfigMinSlots) {
    return false;
  }
  return currentSlot.minus(onChainLastInvestSlot).gt(vaultMinInvestDelaySlots);
}
