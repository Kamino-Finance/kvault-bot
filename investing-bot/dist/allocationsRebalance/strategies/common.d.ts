import { Decimal } from 'decimal.js';
import { KaminoManager, KaminoReserve, KaminoVault, LedgerInstant, VaultState } from '@kamino-finance/klend-sdk';
import { Address, IInstruction, TransactionSigner } from '@solana/kit';
import { AllocationWithAPY } from '../utils/maxYieldOptimizers.js';
import { VaultAllocationProjectionContext } from '../utils/allocationHelper.js';
import { ReserveConstraints } from '../utils/allocationConstraints.js';
/**
 * Common vault context needed for allocation strategies
 */
export interface VaultContext {
    vaultState: VaultState;
    totalAllocationsWeights: Decimal;
    vaultAUMTokens: Decimal;
    investedInReservesTokensMap: Map<Address, Decimal>;
    allInvestedInReservesTokensMap: Map<Address, Decimal>;
    allocationProjectionContext: VaultAllocationProjectionContext;
}
/**
 * Extracts common vault context needed for allocation strategies
 */
export declare function getVaultContext(kaminoManager: KaminoManager, kaminoVault: KaminoVault, optimizationReserves: Map<Address, KaminoReserve>, currentLedgerInstant: LedgerInstant, allVaultReserves?: Map<Address, KaminoReserve>, preservedReserves?: ReadonlySet<string>, forcedZeroReserves?: ReadonlySet<string>): Promise<VaultContext>;
/**
 * Logs allocation strategy results with consistent formatting
 */
export declare function logAllocationResult(kaminoVault: KaminoVault, strategyName: string, allocation: AllocationWithAPY, reservesWithMinAllocation: Address[], stabilizationFactor?: Decimal): void;
/**
 * Build the per-reserve inputs to `applyReserveConstraints` that do NOT depend on the candidate
 * target weight. Extracted so the same deposit/withdrawal-cap logic backs both the instruction
 * builder below and the MAX_YIELD_DRIPPING utilization filter — a single source of truth for "would
 * this deposit/withdrawal hit a chain-side reserve constraint".
 */
export declare function buildReserveConstraintsBase(reserveAddress: Address, reserve: KaminoReserve, currentWeight: Decimal, investedTokensInReserve: Decimal, currentLedgerInstant: LedgerInstant): Omit<ReserveConstraints, 'targetWeight'>;
/**
 * Builds allocation rebalance instructions from allocation results
 */
export declare function buildAllocationRebalanceInstructions(kaminoManager: KaminoManager, kaminoVault: KaminoVault, vaultState: VaultState, vaultsReserves: Map<Address, KaminoReserve>, proposedAllocation: AllocationWithAPY, signer: TransactionSigner, currentLedgerInstant: LedgerInstant, allVaultReserves?: Map<Address, KaminoReserve>, preservedReserves?: ReadonlySet<string>, forcedZeroReserves?: ReadonlySet<string>): Promise<IInstruction[]>;
//# sourceMappingURL=common.d.ts.map