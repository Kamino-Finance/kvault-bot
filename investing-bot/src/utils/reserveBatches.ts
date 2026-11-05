import { DISCRIMINATOR as KVAULT_INVEST_DISCRIMINATOR } from '@kamino-finance/klend-sdk/dist/@codegen/kvault/instructions/invest.js';
import { DISCRIMINATOR as KVAULT_INVEST_WITH_MAX_AMOUNT_DISCRIMINATOR } from '@kamino-finance/klend-sdk/dist/@codegen/kvault/instructions/investWithMaxAmount.js';
import { Address, IInstruction } from '@solana/kit';

/**
 * Position of the `reserve` account in both invest instructions' account list (klend-sdk codegen). Not
 * trusted blindly: `planReserveInstructions` falls back to plain batches when the account there is not a vault reserve.
 */
const KVAULT_INVEST_RESERVE_ACCOUNT_INDEX = 7;

function startsWith(data: ArrayLike<number>, prefix: Uint8Array): boolean {
  if (data.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index++) {
    if (data[index] !== prefix[index]) return false;
  }
  return true;
}

/**
 * The reserve a kvault invest instruction moves funds into or out of; `undefined` for any other
 * instruction (for example the idempotent create-ATA the SDK prepends).
 */
export function getInvestIxReserve(ix: IInstruction, kvaultsProgramId: Address): Address | undefined {
  if (ix.programAddress !== kvaultsProgramId || !ix.data || !ix.accounts) return undefined;
  const isInvest =
    startsWith(ix.data, KVAULT_INVEST_DISCRIMINATOR) ||
    startsWith(ix.data, KVAULT_INVEST_WITH_MAX_AMOUNT_DISCRIMINATOR);
  if (!isInvest) return undefined;
  return ix.accounts[KVAULT_INVEST_RESERVE_ACCOUNT_INDEX]?.address;
}

export interface ReserveIx {
  reserve: Address;
  ix: IInstruction;
  ordinal: number;
}

export interface ReserveInstructionPlan {
  /** Non-invest instructions (the SDK's create-ATA), sent before or with the first reserve batch. */
  preamble: IInstruction[];
  reserveIxs: ReserveIx[];
}

/**
 * Attribute each instruction to its reserve while preserving the SDK ordinal. Returns a reason instead of
 * a plan when a kvault instruction is not recognised or its reserve slot holds a non-reserve: the ix layout
 * no longer matches this file's assumptions, so per-reserve policy must not be applied.
 */
export function planReserveInstructions(
  instructions: IInstruction[],
  kvaultsProgramId: Address,
  vaultReserves: Address[]
): ReserveInstructionPlan | { fallbackReason: string } {
  const knownReserves = new Set(vaultReserves);
  const plan: ReserveInstructionPlan = { preamble: [], reserveIxs: [] };
  for (const [ordinal, ix] of instructions.entries()) {
    const reserve = getInvestIxReserve(ix, kvaultsProgramId);
    if (reserve === undefined) {
      if (ix.programAddress === kvaultsProgramId) {
        return { fallbackReason: `kvault instruction #${ordinal} is not a known invest instruction` };
      }
      plan.preamble.push(ix);
    } else if (!knownReserves.has(reserve)) {
      return { fallbackReason: `invest instruction #${ordinal} names ${reserve}, which is not a reserve of the vault` };
    } else {
      plan.reserveIxs.push({ reserve, ix, ordinal });
    }
  }
  return plan;
}

/** Number of instructions contained in complete preamble-only batches before reserve instructions start. */
export function preambleOnlyInstructionCount(preambleLength: number, batchSize: number): number {
  return Math.floor(preambleLength / batchSize) * batchSize;
}

/** Reserve instruction capacity after the unconfirmed preamble consumes part of the first batch. */
export function reserveBatchCapacity(batchSize: number, preambleSent: boolean, pendingPreambleLength: number): number {
  return preambleSent ? batchSize : batchSize - pendingPreambleLength;
}

/** The send and failure policy of one caller of sendReserveBatches. `F` is a failure the policy handles. */
export interface ReserveBatchPolicy<F> {
  /** Sends complete batches that hold only preamble instructions. */
  sendPreamble(instructions: IInstruction[]): Promise<void>;
  /**
   * Sends `ixs`: the batch's instructions, after the preamble while it is unsent. Returns a failure to handle, or
   * undefined on success; rethrows any other error. `soloRetryOf` is the failure of the batch this send retries.
   */
  send(batch: ReserveIx[], ixs: IInstruction[], soloRetryOf?: F): Promise<F | undefined>;
  /** A batch of several reserves failed. Its reserves are then retried one at a time. */
  onBatchFailure(batch: ReserveIx[], failure: F): void;
  /** One reserve failed, alone or in its solo retry. */
  onReserveFailure(reserveIx: ReserveIx, failure: F): void;
}

/**
 * Sends the plan in SDK order, so that one failing reserve does not block the others. Complete preamble-only batches go
 * first when reserve instructions follow, and the rest of the preamble rides with the first reserve batch. A failed
 * batch of several reserves is retried one reserve at a time.
 */
export async function sendReserveBatches<F>(
  plan: ReserveInstructionPlan,
  batchSize: number,
  policy: ReserveBatchPolicy<F>
): Promise<void> {
  let pendingPreamble = plan.preamble;
  if (plan.reserveIxs.length > 0 && pendingPreamble.length >= batchSize) {
    const preambleOnlyCount = preambleOnlyInstructionCount(pendingPreamble.length, batchSize);
    await policy.sendPreamble(pendingPreamble.slice(0, preambleOnlyCount));
    pendingPreamble = pendingPreamble.slice(preambleOnlyCount);
  }
  let preambleSent = pendingPreamble.length === 0;
  const send = async (batch: ReserveIx[], soloRetryOf?: F): Promise<F | undefined> => {
    const ixs = preambleSent ? batch.map(({ ix }) => ix) : [...pendingPreamble, ...batch.map(({ ix }) => ix)];
    const failure = await policy.send(batch, ixs, soloRetryOf);
    if (failure === undefined) preambleSent = true;
    return failure;
  };

  for (let index = 0; index < plan.reserveIxs.length; ) {
    const batch = plan.reserveIxs.slice(
      index,
      index + reserveBatchCapacity(batchSize, preambleSent, pendingPreamble.length)
    );
    index += batch.length;
    const batchFailure = await send(batch);
    if (batchFailure === undefined) continue;
    if (batch.length === 1) {
      policy.onReserveFailure(batch[0], batchFailure);
      continue;
    }
    policy.onBatchFailure(batch, batchFailure);
    for (const reserveIx of batch) {
      const failure = await send([reserveIx], batchFailure);
      if (failure !== undefined) policy.onReserveFailure(reserveIx, failure);
    }
  }
}
