import { AccountRole, IInstruction } from '@solana/kit';
import { Decimal } from 'decimal.js';
import { logger } from 'kvaults-investing-bot-logger';
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

export function isComputeBudgetComputeUnitLimit(ix: ComputeBudgetInstructionType): ix is 'SetComputeUnitLimit' {
  return ix === 'SetComputeUnitLimit';
}

export function isComputeBudgetComputeUnitPrice(ix: ComputeBudgetInstructionType): ix is 'SetComputeUnitPrice' {
  return ix === 'SetComputeUnitPrice';
}

export type ComputeBudgetInstructionType =
  | 'RequestUnits'
  | 'RequestHeapFrame'
  | 'SetComputeUnitLimit'
  | 'SetComputeUnitPrice';

export function markOptionalAccountsReadonly(ixs: IInstruction[]): IInstruction[] {
  return ixs.map((ix) => {
    const ixAccs = ix.accounts || [];
    const newAccs = ixAccs.map((acc) => {
      if (acc.address === ix.programAddress && acc.role === AccountRole.WRITABLE) {
        return { ...acc, role: AccountRole.READONLY };
      }
      return acc;
    });
    return { ...ix, accounts: newAccs };
  });
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

export function overwriteComputeBudgetAndPriorityFee(
  ixs: IInstruction[],
  units: number,
  feePerCUMicroLamports: Decimal | undefined
): IInstruction[] {
  const newIxs = [...ixs];
  const priorityFeeIx: IInstruction | undefined = feePerCUMicroLamports
    ? getSetComputeUnitPriceInstruction({ microLamports: feePerCUMicroLamports.ceil().toNumber() })
    : undefined;
  const computeBudgetIx = getSetComputeUnitLimitInstruction({ units });
  let replacedPriorityFee = false;
  let replacedComputeBudget = false;
  for (let i = 0; i < newIxs.length; i += 1) {
    const ix = newIxs[i];
    if (ix.data && ix.programAddress === COMPUTE_BUDGET_PROGRAM_ADDRESS) {
      const ixType = identifyComputeBudgetInstruction(ix.data);
      if (ixType === ComputeBudgetInstruction.SetComputeUnitLimit) {
        logger.info(`Overwriting compute budget instruction at index ${i} with new compute unit limit: ${units}`);
        newIxs[i] = computeBudgetIx;
        replacedComputeBudget = true;
      } else if (ixType === ComputeBudgetInstruction.SetComputeUnitPrice) {
        if (!priorityFeeIx) {
          logger.info(`Removing priority fee instruction at index ${i}`);
          newIxs.splice(i, 1);
        } else {
          logger.info(`Overwriting priority fee instruction at index ${i} with new fee: ${feePerCUMicroLamports}`);
          newIxs[i] = priorityFeeIx;
        }
        replacedPriorityFee = true;
      }
      if (replacedComputeBudget && replacedPriorityFee) {
        break;
      }
    }
  }
  if (!replacedComputeBudget) {
    newIxs.push(computeBudgetIx);
  }
  if (priorityFeeIx && !replacedPriorityFee) {
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

/**
 * Move all compute budget instructions to the end of the array
 * Useful for getting more log output before truncation
 * @param ixns
 */
export function moveComputeBudgetIxsLast(ixns: IInstruction[]): IInstruction[] {
  const [computeBudgetIxns, otherIxns] = splitArray(
    ixns,
    ({ programAddress }) => programAddress === COMPUTE_BUDGET_PROGRAM_ADDRESS
  );
  return [...otherIxns, ...computeBudgetIxns];
}

function splitArray<T>(arr: T[], condition: (element: T) => boolean): [T[], T[]] {
  return arr.reduce<[T[], T[]]>(
    (result, element) => {
      if (condition(element)) {
        result[0].push(element);
      } else {
        result[1].push(element);
      }
      return result;
    },
    [[], []]
  );
}
