import { IInstruction } from '@solana/kit';
import { Decimal } from 'decimal.js';
export declare function createAddExtraComputeUnitsTransaction(units: number, feePerCUMicroLamports?: Decimal): IInstruction[];
export declare function isComputeBudgetComputeUnitLimit(ix: ComputeBudgetInstructionType): ix is 'SetComputeUnitLimit';
export declare function isComputeBudgetComputeUnitPrice(ix: ComputeBudgetInstructionType): ix is 'SetComputeUnitPrice';
export type ComputeBudgetInstructionType = 'RequestUnits' | 'RequestHeapFrame' | 'SetComputeUnitLimit' | 'SetComputeUnitPrice';
export declare function markOptionalAccountsReadonly(ixs: IInstruction[]): IInstruction[];
export declare function overwriteComputeBudget(ixs: IInstruction[], units: number): IInstruction[];
export declare function overwritePriorityFee(ixs: IInstruction[], feePerCUMicroLamports: Decimal | undefined): IInstruction[];
export declare function overwriteComputeBudgetAndPriorityFee(ixs: IInstruction[], units: number, feePerCUMicroLamports: Decimal | undefined): IInstruction[];
export declare function removeComputeBudgetIxs(ixs: IInstruction[]): {
    computeBudgetIxs: IInstruction[];
    otherIxs: IInstruction[];
};
/**
 * Move all compute budget instructions to the end of the array
 * Useful for getting more log output before truncation
 * @param ixns
 */
export declare function moveComputeBudgetIxsLast(ixns: IInstruction[]): IInstruction[];
//# sourceMappingURL=computeBudget.d.ts.map