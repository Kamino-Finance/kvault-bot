import { PriceIsZero } from '@kamino-finance/klend-sdk/dist/@codegen/klend/errors/custom.js';
import { InvestAmountBelowMinimum } from '@kamino-finance/klend-sdk/dist/@codegen/kvault/errors/custom.js';
import { TOKEN_ERROR__INSUFFICIENT_FUNDS, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { TOKEN_2022_ERROR__INSUFFICIENT_FUNDS, TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { Address, IInstruction } from '@solana/kit';
import { SimulateTransactionError, TransactionError } from 'kvaults-investing-bot-tx/instruction';

/**
 * A non-negative integer of the RPC error, as a number. The kit response transform upcasts the JSON
 * integers of `TransactionError` (instruction index, `Custom` code) to bigint; numbers are accepted too.
 */
function toNonNegativeInteger(value: unknown): number | undefined {
  const asNumber = typeof value === 'bigint' && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
  return typeof asNumber === 'number' && Number.isSafeInteger(asNumber) && asNumber >= 0 ? asNumber : undefined;
}

function hasInstructionError(cause: unknown): cause is { InstructionError: [number | bigint, string | object] } {
  if (!cause || typeof cause !== 'object' || !('InstructionError' in cause)) return false;
  const instructionError = cause.InstructionError;
  if (!Array.isArray(instructionError) || instructionError.length !== 2) return false;
  const [instructionIndex, error] = instructionError;
  return (
    toNonNegativeInteger(instructionIndex) !== undefined &&
    (typeof error === 'string' || (error !== null && typeof error === 'object' && !Array.isArray(error)))
  );
}

/** The `Custom` program error code of an instruction error, when it carries a valid one. */
function getCustomErrorCode(error: unknown): number | undefined {
  if (error === null || typeof error !== 'object' || !('Custom' in error)) return undefined;
  return toNonNegativeInteger(error.Custom);
}

/** The logs and program error of a failed simulation or landed transaction; `undefined` for any other error. */
function programFailureOf(error: unknown): { logs: string[] | undefined; cause: unknown } | undefined {
  if (error instanceof SimulateTransactionError) {
    return { logs: error.logs, cause: error.cause };
  }
  if (error instanceof TransactionError) {
    return { logs: error.logs, cause: error.transactionError ?? error.cause };
  }
  return undefined;
}

const PROGRAM_FAILURE_PATTERN = /^Program \w+ failed: /;
const ANCHOR_ERROR_PATTERN = /Error Code: (\w+)\. Error Number: (\d+)\./;

/** Index of the last `Program X failed: ...` log line (the outermost failing program's verdict), or -1. */
function lastProgramFailureIndex(logs: string[]): number {
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    if (PROGRAM_FAILURE_PATTERN.test(logs[index])) return index;
  }
  return -1;
}

interface TerminalCustomFailure {
  code: number;
  programs: string[];
}

function getTerminalCustomFailure(logs: string[], kvaultsProgramId: Address): TerminalCustomFailure | undefined {
  const customFailurePattern = /^Program (\w+) failed: custom program error: 0x([\da-f]+)$/i;
  const terminalIndex = lastProgramFailureIndex(logs);
  const terminalMatch = terminalIndex >= 0 ? customFailurePattern.exec(logs[terminalIndex]) : null;
  if (!terminalMatch || terminalMatch[1] !== kvaultsProgramId) return undefined;

  const code = Number.parseInt(terminalMatch[2], 16);
  const programs = [terminalMatch[1]];
  for (let index = terminalIndex - 1; index >= 0; index -= 1) {
    const line = logs[index];
    if (/^Program \w+ (?:invoke \[\d+\]|success)$/.test(line)) break;
    const match = customFailurePattern.exec(line);
    if (match) {
      if (Number.parseInt(match[2], 16) !== code) break;
      programs.push(match[1]);
    } else if (PROGRAM_FAILURE_PATTERN.test(line)) {
      break;
    }
  }
  return { code, programs };
}

export function failureCanFollowMissingWithdrawalProceeds(error: unknown, kvaultsProgramId: Address): boolean {
  const failure = programFailureOf(error);
  if (!failure) return false;
  const { logs, cause } = failure;
  if (cause && typeof cause === 'object' && 'InstructionError' in cause && !hasInstructionError(cause)) return false;
  const instructionError = hasInstructionError(cause) ? cause.InstructionError[1] : undefined;
  const customCode = getCustomErrorCode(instructionError);
  if (instructionError !== undefined && instructionError !== 'InsufficientFunds' && customCode === undefined) {
    return false;
  }

  const terminalIndex = logs ? lastProgramFailureIndex(logs) : -1;
  const terminalProgramFailure = logs && terminalIndex >= 0 ? logs[terminalIndex] : undefined;
  const terminalInsufficientFunds = terminalProgramFailure === `Program ${kvaultsProgramId} failed: insufficient funds`;
  if (instructionError === 'InsufficientFunds') {
    return terminalProgramFailure === undefined || terminalInsufficientFunds;
  }
  if (instructionError === undefined && terminalInsufficientFunds) return true;
  if (!logs) return false;

  const terminalFailure = getTerminalCustomFailure(logs, kvaultsProgramId);
  if (!terminalFailure) return false;
  if (customCode !== undefined && customCode !== terminalFailure.code) return false;

  if (terminalFailure.code === InvestAmountBelowMinimum.code) {
    return lastAnchorErrorIsInvestAmountBelowMinimum(logs);
  }

  return (
    (terminalFailure.code === TOKEN_ERROR__INSUFFICIENT_FUNDS &&
      terminalFailure.programs.includes(TOKEN_PROGRAM_ADDRESS)) ||
    (terminalFailure.code === TOKEN_2022_ERROR__INSUFFICIENT_FUNDS &&
      terminalFailure.programs.includes(TOKEN_2022_PROGRAM_ADDRESS))
  );
}

function lastAnchorErrorIsInvestAmountBelowMinimum(logs: string[]): boolean {
  const lastAnchorError = [...logs].reverse().find((line) => ANCHOR_ERROR_PATTERN.test(line));
  return (
    lastAnchorError?.includes(
      `Error Code: ${InvestAmountBelowMinimum.name}. Error Number: ${InvestAmountBelowMinimum.code}.`
    ) === true
  );
}

/**
 * Whether kvault rejected the instruction because its move is at or below the vault's min invest amount. This
 * happens when another invest of the vault lands first (the allocation loop invests after a weight update), so it
 * says nothing about the reserve: the next pass rebuilds the move from fresh state.
 */
export function isInvestAmountBelowMinimumFailure(error: unknown, kvaultsProgramId: Address): boolean {
  const failure = programFailureOf(error);
  if (!failure?.logs) return false;
  const { logs, cause } = failure;
  if (hasInstructionError(cause) && getCustomErrorCode(cause.InstructionError[1]) !== InvestAmountBelowMinimum.code) {
    return false;
  }
  return (
    getTerminalCustomFailure(logs, kvaultsProgramId)?.code === InvestAmountBelowMinimum.code &&
    lastAnchorErrorIsInvestAmountBelowMinimum(logs)
  );
}

/**
 * Whether the error is a verdict about the transaction's instructions (failed simulation with program
 * logs, or a landed transaction that failed) rather than an infrastructure failure (RPC down, blockhash
 * exhausted). Only the former can be attributed to a reserve.
 */
export function isReserveAttributableFailure(error: unknown): boolean {
  if (error instanceof SimulateTransactionError) {
    // Empty logs with a bare-string error (InsufficientFundsForFee, AccountNotFound): nothing ran, payer problem.
    return (error.logs !== undefined && error.logs.length > 0) || hasInstructionError(error.cause);
  }
  return (
    error instanceof TransactionError &&
    ((error.logs !== undefined && error.logs.length > 0) || hasInstructionError(error.transactionError ?? error.cause))
  );
}

/** Short human-readable cause: the Anchor error name and number when the logs carry one, else the raw error. */
export function describeProgramFailure(error: unknown): string {
  const failure = programFailureOf(error);
  for (const line of [...(failure?.logs ?? [])].reverse()) {
    const anchorError = ANCHOR_ERROR_PATTERN.exec(line);
    if (anchorError) {
      return `${anchorError[1]} (${anchorError[2]})`;
    }
  }
  const cause = failure?.cause;
  if (hasInstructionError(cause) && getCustomErrorCode(cause.InstructionError[1]) === PriceIsZero.code) {
    return `PriceIsZero (${PriceIsZero.code})`;
  }
  if (cause !== undefined) {
    return JSON.stringify(cause, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
  }
  return error instanceof Error ? error.message : String(error);
}

/** The submitted instruction identified by a structured program failure, when its index is valid. */
export function getFailedInstruction(error: unknown, sentIxs: IInstruction[]): IInstruction | undefined {
  const cause = programFailureOf(error)?.cause;
  if (!hasInstructionError(cause)) return undefined;
  const failedIndex = toNonNegativeInteger(cause.InstructionError[0]);
  return failedIndex === undefined ? undefined : sentIxs[failedIndex];
}

/**
 * Whether a structured error identifies a sent instruction outside `targetIxs`, such as a preamble.
 * An out-of-range index is inconclusive because the sender can append instructions such as a tip.
 */
export function failedOutsideInstructions(error: unknown, sentIxs: IInstruction[], targetIxs: IInstruction[]): boolean {
  const failedIx = getFailedInstruction(error, sentIxs);
  return failedIx !== undefined && !targetIxs.includes(failedIx);
}
