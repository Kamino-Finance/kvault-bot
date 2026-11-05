import { IInstruction } from '@solana/kit';
import { Decimal } from 'decimal.js';
import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  ComputeBudgetInstruction,
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
  identifyComputeBudgetInstruction,
} from '@solana-program/compute-budget';

export function createAddExtraComputeUnitsTransaction(units: number, feePerCUMicroLamports?: Decimal): IInstruction[] {
  const ixns = [];
  ixns.push(getSetComputeUnitLimitInstruction({ units }));
  if (feePerCUMicroLamports) {
    const num = BigInt(feePerCUMicroLamports.ceil().toString());
    ixns.push(getSetComputeUnitPriceInstruction({ microLamports: num }));
  }
  return ixns;
}

export function overwriteComputeBudget(ixs: IInstruction[], units: number): IInstruction[] {
  const newIxs = [...ixs];
  for (let i = 0; i < newIxs.length; i += 1) {
    const ix = newIxs[i];
    if (ix.data && ix.programAddress === COMPUTE_BUDGET_PROGRAM_ADDRESS) {
      const ixType = identifyComputeBudgetInstruction(ix.data);
      if (ixType === ComputeBudgetInstruction.SetComputeUnitLimit) {
        newIxs[i] = getSetComputeUnitLimitInstruction({ units });
        return newIxs;
      }
    }
  }
  newIxs.push(getSetComputeUnitLimitInstruction({ units }));
  return newIxs;
}

export function overwritePriorityFee(ixs: IInstruction[], feePerCUMicroLamports: Decimal | undefined): IInstruction[] {
  const newIxs = [...ixs];
  const priorityFeeIx: IInstruction | undefined = feePerCUMicroLamports
    ? getSetComputeUnitPriceInstruction({ microLamports: feePerCUMicroLamports.ceil().toNumber() })
    : undefined;
  let replaced = false;
  for (let i = 0; i < newIxs.length; i += 1) {
    const ix = newIxs[i];
    if (ix.data && ix.programAddress === COMPUTE_BUDGET_PROGRAM_ADDRESS) {
      const ixType = identifyComputeBudgetInstruction(ix.data);
      if (ixType === ComputeBudgetInstruction.SetComputeUnitPrice) {
        if (!priorityFeeIx) {
          newIxs.splice(i, 1);
        } else {
          newIxs[i] = priorityFeeIx;
        }
        replaced = true;
        break;
      }
    }
  }
  if (priorityFeeIx && !replaced) {
    newIxs.push(priorityFeeIx);
  }
  return newIxs;
}

export function removeComputeBudgetIxs(ixs: IInstruction[]): {
  computeBudgetIxs: IInstruction[];
  otherIxs: IInstruction[];
} {
  const computeBudgetIxs: IInstruction[] = [];
  const otherIxs: IInstruction[] = [];
  for (const ix of ixs) {
    if (ix.programAddress === COMPUTE_BUDGET_PROGRAM_ADDRESS) {
      computeBudgetIxs.push(ix);
    } else {
      otherIxs.push(ix);
    }
  }
  return { computeBudgetIxs, otherIxs };
}
