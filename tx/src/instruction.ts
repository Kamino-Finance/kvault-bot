import {
  Rpc,
  Address,
  TransactionError as Web3TxError,
  SimulateTransactionApi,
  SendTransactionApi,
  Account,
  address,
  IInstruction,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  appendTransactionMessageInstructions,
  pipe,
  setTransactionMessageLifetimeUsingBlockhash,
  Blockhash,
  FullySignedTransaction,
  setTransactionMessageFeePayerSigner,
  signTransactionMessageWithSigners,
  addSignersToTransactionMessage,
  GetTransactionApi,
  sendAndConfirmTransactionFactory,
  TransactionWithBlockhashLifetime,
  getSignatureFromTransaction,
  getBase64EncodedWireTransaction,
  Signature,
  TransactionSigner,
  compileTransaction,
  SolanaError,
  isSolanaError,
  SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED,
  GetLatestBlockhashApi,
} from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import { AddressLookupTable } from '@solana-program/address-lookup-table';
import { logger, magenta } from 'kvaults-investing-bot-logger';
import { Decimal } from 'decimal.js';
import { compileTransactionMessage, getCompiledTransactionMessageEncoder } from '@solana/transaction-messages';
import {
  compressTransactionMessageUsingAddressLookupTables,
  AddressesByLookupTableAddress,
} from '@solana/transaction-messages';
import { overwriteComputeBudget, overwritePriorityFee } from './computeBudget.js';
import { ConnectionPool, WRITE_CONNECTION_FINALITY } from './ConnectionPool.js';
import { Cluster } from './model/Cluster.js';
import { getPriorityFeeForIxs } from './priority/index.js';
import { BlockhashWithHeight, fetchBlockhash } from './blockhash.js';
import { reportTransactionSample } from './utils/replaySampling.js';

export const WRAPPED_SOL_MINT = address('So11111111111111111111111111111111111111112');
export const DEFAULT_PUBLIC_KEY = address('11111111111111111111111111111111');

const INVALID_BUT_SUFFICIENT_FOR_COMPILATION_BLOCKHASH = {
  blockhash: '11111111111111111111111111111111' as Blockhash,
  lastValidBlockHeight: 0n,
};

/** Compute budget of every preflight simulation, and of a send whose own estimate failed. */
export const SIMULATION_COMPUTE_UNIT_LIMIT = 1_400_000;

/**
 * Throws when a failed simulation must block the send. The thrown error carries the simulation's logs
 * and program error when the caller passes them, so callers can attribute the failure.
 */
export function assertSimulationAllowsSend(
  simulationIsSuccessful: boolean,
  sendIfSimulationFailed: boolean,
  simulationError?: SimulateTransactionError,
  shouldSendAfterSimulationFailure?: (error: SimulateTransactionError) => boolean
): void {
  if (simulationIsSuccessful) return;
  const error = simulationError ?? new SimulateTransactionError();
  if (!sendIfSimulationFailed || shouldSendAfterSimulationFailure?.(error) === false) throw error;
}

export function base64EncodeTx(
  cluster: Cluster,
  payer: Address,
  instructions: IInstruction[],
  lookupTables: Account<AddressLookupTable>[] | undefined = undefined
): {
  encodedTx: string;
  simulationUrl: string;
} {
  const compiled = compileTransactionMessage(unsignedV0Message(payer, instructions, lookupTables));
  const encodedMessageBytes = getCompiledTransactionMessageEncoder().encode(compiled);
  const encodedTxMessage = Buffer.from(encodedMessageBytes).toString('base64');

  const clusterString =
    cluster === 'localnet' ? '?cluster=custom&customUrl=http://localhost:8899' : `?cluster=${cluster.toString()}`;
  const simulationUrl = `https://explorer.solana.com/tx/inspector${clusterString}&message=${encodeURIComponent(encodedTxMessage)}&signatures=${encodeURIComponent(`[${payer}]`)}`;
  return { encodedTx: encodedTxMessage, simulationUrl };
}

function toLutMap(lookupTables: Account<AddressLookupTable>[] | undefined): AddressesByLookupTableAddress {
  const luts: AddressesByLookupTableAddress = {};
  (lookupTables || []).forEach((lut) => {
    luts[lut.address] = lut.data.addresses;
  });
  return luts;
}

/** A v0 message with a placeholder blockhash: enough to compile, size or simulate the transaction, not to send it. */
function unsignedV0Message(
  payer: Address,
  instructions: IInstruction[],
  lookupTables: Account<AddressLookupTable>[] | undefined
) {
  return pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(payer, tx),
    (tx) => appendTransactionMessageInstructions(instructions, tx),
    (tx) => compressTransactionMessageUsingAddressLookupTables(tx, toLutMap(lookupTables)),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(INVALID_BUT_SUFFICIENT_FOR_COMPILATION_BLOCKHASH, tx)
  );
}

export interface SendTransactionOptions {
  blockhash?: BlockhashWithHeight;
  reportSample?: boolean;
  sendIfSimulationFailed?: boolean;
  /** Optional final-preflight guard for callers that force only selected simulation failures. */
  shouldSendAfterSimulationFailure?: (error: SimulateTransactionError) => boolean;
}

export async function sendAndConfirmTransactionV0(
  c: ConnectionPool,
  payer: TransactionSigner,
  instructions: IInstruction[],
  lookupTables: Account<AddressLookupTable>[],
  signers: TransactionSigner[],
  withDescription: string = '',
  options: SendTransactionOptions = {}
): Promise<Signature> {
  const {
    blockhash: suppliedBlockhash,
    reportSample = true,
    sendIfSimulationFailed = false,
    shouldSendAfterSimulationFailure,
  } = options;
  const [cu, fetchedBlockhash, fee] = await Promise.all([
    c.shouldSimulate()
      ? getSimulationComputeUnits(c.getRpc(), instructions, payer.address, lookupTables, withDescription)
      : undefined,
    suppliedBlockhash ? Promise.resolve(suppliedBlockhash) : fetchBlockhash(c.getRpc()),
    getPriorityFeeForIxs(c, instructions),
  ]);
  let blockhash: BlockhashWithHeight = fetchedBlockhash;
  let ixs = instructions;
  if (cu === null || cu === undefined) {
    // Without an estimate (simulation failed, or SIMULATE is off), send with the budget the final preflight simulates
    // at, so a transaction cannot pass simulation and then run out of compute on-chain under the far lower
    // per-instruction default.
    if (cu === null) {
      logger.warn(
        `${withDescription} failed to simulate and get estimated compute units; sending with the ${SIMULATION_COMPUTE_UNIT_LIMIT.toLocaleString('en-US')} CU preflight budget`
      );
    }
    ixs = overwriteComputeBudget(instructions, SIMULATION_COMPUTE_UNIT_LIMIT);
  } else {
    let cuBuffer;
    if (cu >= 1_200_000) {
      cuBuffer = Math.max(SIMULATION_COMPUTE_UNIT_LIMIT - cu, 0);
    } else if (cu >= 150_000) {
      cuBuffer = Math.min(200_000, Math.max(100_000, cu * 0.2));
    } else if (cu >= 85_000) {
      cuBuffer = Math.min(150_000, Math.max(50_000, cu * 0.2));
    } else if (cu >= 15_000) {
      cuBuffer = Math.min(100_000, Math.max(30_000, cu * 0.2));
    } else {
      cuBuffer = 2_500;
    }
    cuBuffer = Math.ceil(cuBuffer);
    const totalCu = cu + cuBuffer;
    logger.info(
      `${withDescription} estimated compute units: ${cu.toLocaleString('en-US')} adding buffer ${cuBuffer.toLocaleString('en-US')} for a total of ${totalCu.toLocaleString('en-US')} CU`
    );
    ixs = overwriteComputeBudget(instructions, totalCu);
  }
  if (fee) {
    logger.info(`${withDescription} setting priority fee: ${fee.toString()} uLamports/CU`);
  } else {
    logger.info(`${withDescription} no priority fee set`);
  }
  ixs = overwritePriorityFee(ixs, fee);

  const MAX_BLOCK_HEIGHT_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_BLOCK_HEIGHT_RETRIES; attempt++) {
    // On retry, fetch a fresh blockhash and rebuild the tx
    if (attempt > 1) {
      logger.info(`${withDescription} retry ${attempt}/${MAX_BLOCK_HEIGHT_RETRIES}: fetching fresh blockhash`);
      blockhash = await fetchBlockhash(c.getRpc() as Rpc<GetLatestBlockhashApi>);
    }

    // Use one signed payload per attempt. Previously MULTICAST_JITO sent both the normal transaction
    // and a separately-signed tipped transaction, so both could execute. A tipped send is now
    // mutually exclusive and follows the same confirmation/retry path as a normal send.
    const transactionIxs = getTransactionInstructions(ixs, payer, c.shouldMulticastJito());
    const tx = await buildSignedTx(payer, transactionIxs, lookupTables, signers, blockhash);

    const sig = getSignatureFromTransaction(tx);
    const simulationError = await simulateTx(c.getRpc(), transactionIxs, payer.address, lookupTables, withDescription);
    assertSimulationAllowsSend(
      simulationError === undefined,
      sendIfSimulationFailed,
      simulationError,
      shouldSendAfterSimulationFailure
    );

    if (reportSample) {
      // Only after the send decision: the collector receives signed bytes of transactions the bot sends.
      const serializedBuffer = Buffer.from(getBase64EncodedWireTransaction(tx), 'base64');
      const description = withDescription.length > 0 ? withDescription : undefined;
      reportTransactionSample(serializedBuffer, description);
    }

    try {
      if (c.shouldSpam()) {
        let confirmed = false;
        // eslint-disable-next-line prefer-const
        let intervalId: NodeJS.Timeout;
        const stopSendingTx = () => {
          if (intervalId) {
            clearInterval(intervalId);
          }
        };

        // eslint-disable-next-line no-loop-func
        const send = () => {
          if (confirmed) {
            return;
          }
          sendTx(c.getRpc(), tx, sig, blockhash, `${withDescription} (spam)`).catch((e) =>
            logger.warn(`Spamming tx failed`, e)
          );
        };

        intervalId = setInterval(() => {
          send();
        }, 2000);

        await sendAndConfirmTransactionV0Impl(c, sig, tx, blockhash.slot, `${withDescription} (confirm)`)
          .then(() => {
            confirmed = true;
            logger.info(`${withDescription} success ${sig}`);
            stopSendingTx();
            return sig;
          })
          .catch((e) => {
            stopSendingTx();
            throw e;
          })
          .finally(() => stopSendingTx());
        return sig;
      } else {
        await sendAndConfirmTransactionV0Impl(c, sig, tx, blockhash.slot, `${withDescription} (confirm)`);
        return sig;
      }
    } catch (e) {
      // Retry only an expired transaction that never landed: when the lookup found it on the ledger, it carries the
      // program error and a new transaction would act a second time.
      const isBlockHeightExceeded =
        e instanceof TransactionError &&
        e.transactionError === undefined &&
        isSolanaError(e.cause, SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED);
      if (isBlockHeightExceeded && attempt < MAX_BLOCK_HEIGHT_RETRIES) {
        logger.warn(
          `${withDescription} block height exceeded on attempt ${attempt}/${MAX_BLOCK_HEIGHT_RETRIES}, retrying with fresh blockhash...`
        );
        continue;
      }
      throw e;
    }
  }

  // This should be unreachable, but TypeScript needs it
  throw new Error(`${withDescription} exhausted all ${MAX_BLOCK_HEIGHT_RETRIES} retry attempts`);
}

export function txLink(sig: string, explorer: 'SOLANA' | 'SOLSCAN' = 'SOLSCAN'): string {
  switch (explorer) {
    case 'SOLSCAN':
      return `https://solscan.io/tx/${sig}`;
    case 'SOLANA':
    default:
      return `https://explorer.solana.com/tx/${sig}`;
  }
}

export async function sendTx(
  rpc: Rpc<SendTransactionApi & GetTransactionApi>,
  tx: FullySignedTransaction,
  sig: Signature,
  blockhash: { blockhash: string; slot: bigint },
  withDescription: string = ''
): Promise<Signature> {
  const serialized = getBase64EncodedWireTransaction(tx);
  const link = magenta(txLink(sig));
  logger.info(`${withDescription} ${link}`);
  try {
    await rpc
      .sendTransaction(serialized, {
        encoding: 'base64',
        preflightCommitment: WRITE_CONNECTION_FINALITY,
        maxRetries: 0n,
        skipPreflight: true,
        minContextSlot: blockhash.slot,
      })
      .send();
    return sig;
  } catch (e) {
    logger.error(`${withDescription} ${sig}`, e);
    // The send was attempted, so the outcome is decided by the ledger, not by the error text.
    await reconcileSendFailure(
      rpc,
      sig,
      e,
      e.message,
      (recoveryError) => `${e.message}; outcome unknown, confirmation lookup failed: ${recoveryError}`,
      withDescription
    );
    return sig;
  }
}

/**
 * Decides a send that threw from the ledger: returns when the transaction landed and succeeded, and otherwise throws a
 * TransactionError that carries the signature. When the lookup fails too, the outcome is unknown: a raw RPC error here
 * would let callers send a second transaction. That error's cause is the lookup error, so the block-height retry does
 * not re-sign an unresolved send.
 */
async function reconcileSendFailure(
  rpc: Rpc<GetTransactionApi>,
  sig: Signature,
  sendError: Web3TxError | SolanaError,
  failureMessage: string,
  lookupFailedMessage: (recoveryError: unknown) => string,
  withDescription: string
): Promise<void> {
  let landedTx: TransactionResponse | null;
  try {
    landedTx = await forceGetConfirmedTx(rpc, sig);
  } catch (recoveryError) {
    throw new TransactionError(lookupFailedMessage(recoveryError), sig, undefined, recoveryError);
  }
  if (!landedTx) {
    throw new TransactionError(failureMessage, sig, undefined, sendError);
  }
  if (transactionResponseIsSuccessful(landedTx)) {
    logger.info(`${withDescription} recovered successful transaction ${sig}`);
    return;
  }
  const logs = landedTx.meta?.logMessages ? [...landedTx.meta.logMessages] : undefined;
  throw new TransactionError(failureMessage, sig, logs, sendError, landedTx.meta?.err ?? undefined);
}

async function sendAndConfirmTransactionV0Impl(
  c: ConnectionPool,
  sig: Signature,
  tx: FullySignedTransaction & TransactionWithBlockhashLifetime,
  slot: bigint,
  withDescription: string = ''
): Promise<void> {
  try {
    const link = magenta(txLink(sig));
    logger.info(`${withDescription} ${link}`);
    await sendAndConfirmTx(c, tx, slot);
  } catch (e) {
    await reconcileSendFailure(
      c.getRpc(),
      sig,
      e,
      `Failed to send transaction: ${withDescription} ${sig}`,
      (recoveryError) =>
        `Failed to confirm transaction outcome: ${withDescription} ${sig}; send error: ${e}; confirmation lookup failed: ${recoveryError}`,
      withDescription
    );
  }
}

export async function buildSignedTx(
  payer: TransactionSigner,
  instructions: IInstruction[],
  lookupTables: Account<AddressLookupTable>[],
  signers: TransactionSigner[],
  blockhash: { blockhash: Blockhash; lastValidBlockHeight: bigint }
): Promise<FullySignedTransaction & TransactionWithBlockhashLifetime> {
  const luts = toLutMap(lookupTables);
  const tx = await pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => appendTransactionMessageInstructions(instructions, tx),
    (tx) => setTransactionMessageFeePayerSigner(payer, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx),
    (tx) => compressTransactionMessageUsingAddressLookupTables(tx, luts),
    (tx) => addSignersToTransactionMessage(signers, tx),
    (tx) => signTransactionMessageWithSigners(tx)
  );

  return tx;
}

export function getJitoTipInstruction(payer: TransactionSigner): IInstruction {
  return getTransferSolInstruction({
    source: payer,
    destination: address(
      'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL' // Jito tip account
    ),
    amount: 5_000, // tip
  });
}

export function getTransactionInstructions(
  instructions: IInstruction[],
  payer: TransactionSigner,
  includeJitoTip: boolean
): IInstruction[] {
  return includeJitoTip ? [...instructions, getJitoTipInstruction(payer)] : instructions;
}

/** The largest serialized transaction that fits in one Solana packet. */
export const MAX_TRANSACTION_SIZE_BYTES = 1232;

/**
 * Wire size in bytes of the transaction that sendAndConfirmTransactionV0 builds from `instructions`: with its compute
 * unit limit and price instructions, the Jito tip when `includeJitoTip` is set, and one signature per signer.
 */
export function getTransactionV0SizeBytes(
  payer: TransactionSigner,
  instructions: IInstruction[],
  lookupTables: Account<AddressLookupTable>[],
  includeJitoTip: boolean
): number {
  // Both compute budget instructions carry fixed-size data, so the limit and price values do not change the size.
  const sentIxs = getTransactionInstructions(
    overwritePriorityFee(overwriteComputeBudget(instructions, SIMULATION_COMPUTE_UNIT_LIMIT), new Decimal(1)),
    payer,
    includeJitoTip
  );
  const transactionMessage = unsignedV0Message(payer.address, sentIxs, lookupTables);
  return Buffer.from(getBase64EncodedWireTransaction(compileTransaction(transactionMessage)), 'base64').length;
}

export async function sendAndConfirmTx(
  c: ConnectionPool,
  tx: FullySignedTransaction & TransactionWithBlockhashLifetime,
  slot: bigint
): Promise<void> {
  // The confirmation waits on WebSocket streams that no HTTP deadline bounds; give the whole operation a
  // deadline. An abort is reconciled through the signature lookup by the caller, never re-sent blindly.
  await sendAndConfirmTransactionFactory({ rpc: c.getRpc(), rpcSubscriptions: c.getWsRpc() })(tx, {
    abortSignal: AbortSignal.timeout(c.getRpcRequestTimeoutMs()),
    commitment: WRITE_CONNECTION_FINALITY,
    preflightCommitment: WRITE_CONNECTION_FINALITY,
    maxRetries: 0n,
    skipPreflight: true,
    minContextSlot: slot,
  });
  // Kit's signature-status lookup accepts a confirmed status without reading its error, so a transaction that landed and
  // failed can resolve as confirmed. Read the status once more; the caller reconciles the error through the ledger.
  const sig = getSignatureFromTransaction(tx);
  const {
    value: [status],
  } = await c.getRpc().getSignatureStatuses([sig]).send();
  if (status === null) {
    throw new Error(`transaction ${sig} status is unavailable after confirmation`);
  }
  if (status.err) {
    const error = JSON.stringify(status.err, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
    throw new Error(`transaction ${sig} confirmed with error ${error}`);
  }
}

export type TransactionResponse = ReturnType<GetTransactionApi['getTransaction']> | null;

export function transactionResponseIsSuccessful(response: TransactionResponse): boolean {
  return response !== null && response.meta !== null && response.meta.err === null;
}

async function forceGetConfirmedTx(rpc: Rpc<GetTransactionApi>, sig: Signature): Promise<TransactionResponse | null> {
  logger.info(`forceGetConfirmedTx: ${sig}`);
  const endTime = Date.now() + 5000;
  const pollIntervalMs = 200;
  let lastErr = null;
  let failedTx: TransactionResponse | null = null;

  while (true) {
    try {
      failedTx = await rpc
        .getTransaction(sig, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
          encoding: 'json',
        })
        .send();
      if (failedTx) {
        return failedTx;
      }
    } catch (e) {
      lastErr = e;
    }
    if (Date.now() > endTime) {
      if (lastErr) {
        throw lastErr;
      } else {
        return failedTx;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

export async function getSimulationComputeUnits(
  rpc: Rpc<SimulateTransactionApi>,
  instructions: Array<IInstruction>,
  payer: Address,
  lookupTables: Array<Account<AddressLookupTable>> | [],
  withDescription: string = ''
): Promise<number | null> {
  const { error, unitsConsumed } = await simulate(rpc, instructions, payer, lookupTables, withDescription);
  return !error && unitsConsumed ? Number(unitsConsumed) : null;
}

export async function simulateTxIsSuccessful(
  rpc: Rpc<SimulateTransactionApi>,
  instructions: Array<IInstruction>,
  payer: Address,
  lookupTables: Array<Account<AddressLookupTable>> | [],
  withDescription: string = ''
): Promise<boolean> {
  return (await simulateTx(rpc, instructions, payer, lookupTables, withDescription)) === undefined;
}

/**
 * Simulates the instructions as one transaction. Resolves to `undefined` on success, otherwise to the
 * `SimulateTransactionError` describing the failure (program logs, units consumed, and the RPC error).
 */
export async function simulateTx(
  rpc: Rpc<SimulateTransactionApi>,
  instructions: Array<IInstruction>,
  payer: Address,
  lookupTables: Array<Account<AddressLookupTable>> | [],
  withDescription: string = ''
): Promise<SimulateTransactionError | undefined> {
  return (await simulate(rpc, instructions, payer, lookupTables, withDescription)).error;
}

/** Simulates the instructions at the preflight compute budget, and logs a failure. */
async function simulate(
  rpc: Rpc<SimulateTransactionApi>,
  instructions: Array<IInstruction>,
  payer: Address,
  lookupTables: Array<Account<AddressLookupTable>> | [],
  withDescription: string
): Promise<{ error?: SimulateTransactionError; unitsConsumed?: bigint }> {
  const ixs = overwriteComputeBudget(instructions, SIMULATION_COMPUTE_UNIT_LIMIT);
  const wireTransactionBytes = getBase64EncodedWireTransaction(
    compileTransaction(unsignedV0Message(payer, ixs, lookupTables))
  );

  try {
    const res = await rpc
      .simulateTransaction(wireTransactionBytes, {
        encoding: 'base64',
        replaceRecentBlockhash: true,
        sigVerify: false,
      })
      .send();
    if (res.value.err) {
      const error = new SimulateTransactionError(res.value.logs || undefined, res.value.unitsConsumed, res.value.err);
      logger.warn(`${withDescription} Error simulating transaction`, error);
      return { error };
    }
    return { unitsConsumed: res.value.unitsConsumed };
  } catch (e) {
    logger.warn(`${withDescription} Error simulating transaction`, e);
    // The RPC call itself failed; there is no program-level verdict to attribute.
    return { error: new SimulateTransactionError(undefined, undefined, e instanceof Error ? e : undefined) };
  }
}

export function uniqueAccounts(
  ixs: IInstruction[],
  addressLookupTables: Address[] | Account<AddressLookupTable>[] = [],
  ...additional: Address[]
): Set<Address> {
  let luts: Address[];
  if (addressLookupTables.length > 0 && 'address' in addressLookupTables[0]) {
    luts = (addressLookupTables as Account<AddressLookupTable>[]).map((lut) => lut.address);
  } else {
    luts = addressLookupTables as Address[];
  }
  const uniqueAccounts = ixs
    .map((ix) => [ix.programAddress, ...(ix.accounts || []).map((k) => k.address)])
    .flat()
    .concat(...luts, ...additional);
  return new Set(uniqueAccounts);
}

export class TransactionError extends Error {
  sig: string;
  logs: string[] | undefined;
  cause: Web3TxError | SolanaError | undefined;
  transactionError: Web3TxError | undefined;
  constructor(
    message: string,
    sig: string,
    logs?: string[] | undefined,
    cause?: Web3TxError | SolanaError,
    transactionError?: Web3TxError
  ) {
    super(message);
    this.sig = sig;
    this.logs = logs;
    this.cause = cause;
    this.transactionError = transactionError;
  }
}

export class SimulateTransactionError extends Error {
  logs: string[] | undefined;
  unitsConsumed: bigint | undefined;
  cause: Web3TxError | SolanaError | Error | undefined;
  constructor(logs?: string[] | undefined, unitsConsumed?: bigint, cause?: Web3TxError | SolanaError | Error) {
    super('Failed to simulate transaction');
    this.logs = logs;
    this.unitsConsumed = unitsConsumed;
    this.cause = cause;
  }
}
