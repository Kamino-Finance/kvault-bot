import { address, createTransactionMessage, setTransactionMessageFeePayer, appendTransactionMessageInstructions, pipe, setTransactionMessageLifetimeUsingBlockhash, setTransactionMessageFeePayerSigner, signTransactionMessageWithSigners, addSignersToTransactionMessage, sendAndConfirmTransactionFactory, getSignatureFromTransaction, getBase64EncodedWireTransaction, compileTransaction, isSolanaError, SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED, } from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import { logger, magenta } from 'kvaults-investing-bot-logger';
import { Decimal } from 'decimal.js';
import { compileTransactionMessage, getCompiledTransactionMessageEncoder } from '@solana/transaction-messages';
import { compressTransactionMessageUsingAddressLookupTables, } from '@solana/transaction-messages';
import { overwriteComputeBudget, overwritePriorityFee } from './computeBudget.js';
import { WRITE_CONNECTION_FINALITY } from './ConnectionPool.js';
import { getPriorityFeeForIxs } from './priority/index.js';
import { fetchBlockhash } from './blockhash.js';
import { reportTransactionSample } from './utils/replaySampling.js';
export const WRAPPED_SOL_MINT = address('So11111111111111111111111111111111111111112');
export const DEFAULT_PUBLIC_KEY = address('11111111111111111111111111111111');
const INVALID_BUT_SUFFICIENT_FOR_COMPILATION_BLOCKHASH = {
    blockhash: '11111111111111111111111111111111',
    lastValidBlockHeight: 0n,
};
export const MAX_LOCKED_ACCOUNTS = 64;
export function assertSimulationAllowsSend(simulationIsSuccessful, sendIfSimulationFailed) {
    if (!simulationIsSuccessful && !sendIfSimulationFailed) {
        throw new SimulateTransactionError();
    }
}
export function base64EncodeTx(cluster, payer, instructions, lookupTables = undefined) {
    const luts = {};
    (lookupTables || []).forEach((lut) => {
        luts[lut.address] = lut.data.addresses;
    });
    const transactionMessage = pipe(createTransactionMessage({ version: 0 }), (tx) => setTransactionMessageFeePayer(payer, tx), (tx) => appendTransactionMessageInstructions(instructions, tx), (tx) => compressTransactionMessageUsingAddressLookupTables(tx, luts), (tx) => setTransactionMessageLifetimeUsingBlockhash(INVALID_BUT_SUFFICIENT_FOR_COMPILATION_BLOCKHASH, tx));
    const compiled = compileTransactionMessage(transactionMessage);
    const encodedMessageBytes = getCompiledTransactionMessageEncoder().encode(compiled);
    // const encodedTxBytes = getTransactionVersionEncoder().encode(0); // todo
    const encodedTxMessage = Buffer.from(encodedMessageBytes).toString('base64');
    const clusterString = cluster === 'localnet' ? '?cluster=custom&customUrl=http://localhost:8899' : `?cluster=${cluster.toString()}`;
    const simulationUrl = `https://explorer.solana.com/tx/inspector${clusterString}&message=${encodeURIComponent(encodedTxMessage)}&signatures=${encodeURIComponent(`[${payer}]`)}`;
    return { encodedTx: encodedTxMessage, simulationUrl }; // todo this is not correct
}
export async function sendAndConfirmTransactionV0(c, payer, instructions, lookupTables, signers, withDescription = '', options = {}) {
    const { blockhash: suppliedBlockhash, reportSample = true, sendIfSimulationFailed = false } = options;
    const luts = {};
    (lookupTables || []).forEach((lut) => {
        luts[lut.address] = lut.data.addresses;
    });
    // add priority fee to simulation
    let ixs = overwritePriorityFee(instructions, new Decimal('1'));
    let blockhash;
    if (c.shouldSimulate()) {
        const [cu, bh, fee] = await Promise.all([
            getSimulationComputeUnits(c.getRpc(), instructions, payer.address, lookupTables, withDescription),
            suppliedBlockhash ? Promise.resolve(suppliedBlockhash) : fetchBlockhash(c.getRpc()),
            getPriorityFeeForIxs(c, instructions),
        ]);
        if (cu === null) {
            logger.warn(`${withDescription} failed to simulate and get estimated compute units`);
        }
        else {
            let cuBuffer;
            if (cu >= 1_200_000) {
                cuBuffer = Math.max(1_400_000 - cu, 0);
            }
            else if (cu >= 150_000) {
                cuBuffer = Math.min(200_000, Math.max(100_000, cu * 0.2));
            }
            else if (cu >= 85_000) {
                cuBuffer = Math.min(150_000, Math.max(50_000, cu * 0.2));
            }
            else if (cu >= 15_000) {
                cuBuffer = Math.min(100_000, Math.max(30_000, cu * 0.2));
            }
            else {
                cuBuffer = 2_500;
            }
            cuBuffer = Math.ceil(cuBuffer);
            const totalCu = cu + cuBuffer;
            logger.info(`${withDescription} estimated compute units: ${cu.toLocaleString('en-US')} adding buffer ${cuBuffer.toLocaleString('en-US')} for a total of ${totalCu.toLocaleString('en-US')} CU`);
            ixs = overwriteComputeBudget(instructions, totalCu);
        }
        if (fee) {
            logger.info(`${withDescription} setting priority fee: ${fee.toString()} uLamports/CU`);
        }
        else {
            logger.info(`${withDescription} no priority fee set`);
        }
        ixs = overwritePriorityFee(ixs, fee);
        blockhash = bh;
    }
    else {
        const [bh, fee] = await Promise.all([
            suppliedBlockhash ? Promise.resolve(suppliedBlockhash) : fetchBlockhash(c.getRpc()),
            getPriorityFeeForIxs(c, instructions),
        ]);
        if (fee) {
            logger.info(`${withDescription} setting priority fee: ${fee.toString()} uLamports/CU`);
        }
        else {
            logger.info(`${withDescription} no priority fee set`);
        }
        ixs = overwritePriorityFee(instructions, fee);
        blockhash = bh;
    }
    const MAX_BLOCK_HEIGHT_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_BLOCK_HEIGHT_RETRIES; attempt++) {
        // On retry, fetch a fresh blockhash and rebuild the tx
        if (attempt > 1) {
            logger.info(`${withDescription} retry ${attempt}/${MAX_BLOCK_HEIGHT_RETRIES}: fetching fresh blockhash`);
            blockhash = await fetchBlockhash(c.getRpc());
        }
        // Use one signed payload per attempt. Previously MULTICAST_JITO sent both the normal transaction
        // and a separately-signed tipped transaction, so both could execute. A tipped send is now
        // mutually exclusive and follows the same confirmation/retry path as a normal send.
        const transactionIxs = getTransactionInstructions(ixs, payer, c.shouldMulticastJito());
        const tx = await buildSignedTx(payer, transactionIxs, lookupTables, signers, blockhash);
        if (reportSample) {
            // Serialize transaction as buffer (if needed for logging or analysis)
            const serializedBuffer = Buffer.from(getBase64EncodedWireTransaction(tx), 'base64');
            const description = withDescription.length > 0 ? withDescription : undefined;
            reportTransactionSample(serializedBuffer, description);
        }
        const sig = getSignatureFromTransaction(tx);
        const simulationIsSuccessful = await simulateTxIsSuccessful(c.getRpc(), transactionIxs, payer.address, lookupTables, withDescription);
        assertSimulationAllowsSend(simulationIsSuccessful, sendIfSimulationFailed);
        try {
            if (c.shouldSpam()) {
                let confirmed = false;
                // eslint-disable-next-line prefer-const
                let intervalId;
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
                    sendTx(c.getRpc(), tx, sig, blockhash, `${withDescription} (spam)`).catch((e) => logger.warn(`Spamming tx failed`, e));
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
            }
            else {
                await sendAndConfirmTransactionV0Impl(c, sig, tx, blockhash.slot, `${withDescription} (confirm)`);
                return sig;
            }
        }
        catch (e) {
            const isBlockHeightExceeded = (e instanceof TransactionError && isSolanaError(e.cause, SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED)) ||
                isSolanaError(e, SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED);
            if (isBlockHeightExceeded && attempt < MAX_BLOCK_HEIGHT_RETRIES) {
                logger.warn(`${withDescription} block height exceeded on attempt ${attempt}/${MAX_BLOCK_HEIGHT_RETRIES}, retrying with fresh blockhash...`);
                continue;
            }
            throw e;
        }
    }
    // This should be unreachable, but TypeScript needs it
    throw new Error(`${withDescription} exhausted all ${MAX_BLOCK_HEIGHT_RETRIES} retry attempts`);
}
export function txLink(sig, explorer = 'SOLSCAN') {
    switch (explorer) {
        case 'SOLSCAN':
            return `https://solscan.io/tx/${sig}`;
        case 'SOLANA':
        default:
            return `https://explorer.solana.com/tx/${sig}`;
    }
}
export async function sendTx(rpc, tx, sig, blockhash, withDescription = '') {
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
    }
    catch (e) {
        logger.error(`${withDescription} ${sig}`, e);
        const errString = e.toString();
        if (errString.includes('failed')) {
            // todo we have the sig
            const sig = e.toString().split(' failed ')[0].split('Transaction ')[1];
            if (!sig) {
                throw e;
            }
            const failedTx = await forceGetConfirmedTx(rpc, sig);
            if (!failedTx) {
                throw new TransactionError(e.message, sig, undefined, e);
            }
            else if (transactionResponseIsSuccessful(failedTx)) {
                logger.info(`${withDescription} recovered successful transaction ${sig}`);
                return sig;
            }
            else {
                let logs = undefined;
                if (failedTx.meta?.logMessages) {
                    logs = [...failedTx.meta.logMessages];
                }
                throw new TransactionError(e.message, sig, logs, e);
            }
        }
        else {
            throw e;
        }
    }
}
async function sendAndConfirmTransactionV0Impl(c, sig, tx, slot, withDescription = '') {
    try {
        const link = magenta(txLink(sig));
        logger.info(`${withDescription} ${link}`);
        await sendAndConfirmTx(c, tx, slot);
    }
    catch (e) {
        const failedTx = await forceGetConfirmedTx(c.getRpc(), sig);
        if (!failedTx) {
            throw new TransactionError(`Failed to send transaction: ${withDescription} ${sig}`, sig, undefined, e);
        }
        else if (transactionResponseIsSuccessful(failedTx)) {
            logger.info(`${withDescription} recovered successful transaction ${sig}`);
            return;
        }
        else {
            let logs = undefined;
            if (failedTx.meta?.logMessages) {
                logs = [...failedTx.meta.logMessages];
            }
            throw new TransactionError(`Failed to send transaction: ${withDescription} ${sig}`, sig, logs, e);
        }
    }
}
export async function buildSignedTx(payer, instructions, lookupTables, signers, blockhash) {
    const luts = {};
    (lookupTables || []).forEach((lut) => {
        luts[lut.address] = lut.data.addresses;
    });
    const tx = await pipe(createTransactionMessage({ version: 0 }), (tx) => appendTransactionMessageInstructions(instructions, tx), (tx) => setTransactionMessageFeePayerSigner(payer, tx), (tx) => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx), (tx) => compressTransactionMessageUsingAddressLookupTables(tx, luts), (tx) => addSignersToTransactionMessage(signers, tx), (tx) => signTransactionMessageWithSigners(tx));
    return tx;
}
export function getJitoTipInstruction(payer) {
    return getTransferSolInstruction({
        source: payer,
        destination: address('DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL' // Jito tip account
        ),
        amount: 5_000, // tip
    });
}
export function getTransactionInstructions(instructions, payer, includeJitoTip) {
    return includeJitoTip ? [...instructions, getJitoTipInstruction(payer)] : instructions;
}
export async function sendAndConfirmTx(c, tx, slot) {
    await sendAndConfirmTransactionFactory({ rpc: c.getRpc(), rpcSubscriptions: c.getWsRpc() })(tx, {
        commitment: WRITE_CONNECTION_FINALITY,
        preflightCommitment: WRITE_CONNECTION_FINALITY,
        maxRetries: 0n,
        skipPreflight: true,
        minContextSlot: slot,
    });
}
export function transactionResponseIsSuccessful(response) {
    return response !== null && response.meta !== null && response.meta.err === null;
}
async function forceGetConfirmedTx(rpc, sig) {
    logger.info(`forceGetConfirmedTx: ${sig}`);
    const endTime = Date.now() + 5000;
    const pollIntervalMs = 200;
    let lastErr = null;
    let failedTx = null;
    while (true) {
        try {
            failedTx = await rpc
                .getTransaction(sig, {
                commitment: 'confirmed',
                // Reading a v1 transaction fails outright unless the call asks for 1.
                // @solana/kit 2.3 types this field as `'legacy' | 0`, from before
                // transaction v1 existed, so the value needs a cast to reach the wire.
                maxSupportedTransactionVersion: 1,
                encoding: 'json',
            })
                .send();
            if (failedTx) {
                return failedTx;
            }
        }
        catch (e) {
            lastErr = e;
        }
        if (Date.now() > endTime) {
            if (lastErr) {
                throw lastErr;
            }
            else {
                return failedTx;
            }
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
}
export async function getSimulationComputeUnits(rpc, instructions, payer, lookupTables, withDescription = '', log = true) {
    const luts = {};
    (lookupTables || []).forEach((lut) => {
        luts[lut.address] = lut.data.addresses;
    });
    const ixs = overwriteComputeBudget(instructions, 1_400_000);
    const transactionMessage = pipe(createTransactionMessage({ version: 0 }), (tx) => setTransactionMessageFeePayer(payer, tx), (tx) => appendTransactionMessageInstructions(ixs, tx), (tx) => compressTransactionMessageUsingAddressLookupTables(tx, luts), (tx) => setTransactionMessageLifetimeUsingBlockhash(INVALID_BUT_SUFFICIENT_FOR_COMPILATION_BLOCKHASH, tx));
    const compiledTransaction = compileTransaction(transactionMessage);
    const wireTransactionBytes = getBase64EncodedWireTransaction(compiledTransaction);
    try {
        const res = await rpc
            .simulateTransaction(wireTransactionBytes, {
            encoding: 'base64',
            replaceRecentBlockhash: true,
            sigVerify: false,
        })
            .send();
        if (res.value.err) {
            if (log) {
                logger.warn(`${withDescription} Error simulating transaction`, new SimulateTransactionError(res.value.logs || undefined, res.value.unitsConsumed, res.value.err));
            }
            return null;
        }
        return res.value.unitsConsumed ? Number(res.value.unitsConsumed) : null;
    }
    catch (e) {
        if (log) {
            logger.warn(`${withDescription} Error simulating transaction`, e);
        }
        return null;
    }
}
export async function simulateTxIsSuccessful(rpc, instructions, payer, lookupTables, withDescription = '', log = true) {
    const luts = {};
    (lookupTables || []).forEach((lut) => {
        luts[lut.address] = lut.data.addresses;
    });
    const ixs = overwriteComputeBudget(instructions, 1_400_000);
    const transactionMessage = pipe(createTransactionMessage({ version: 0 }), (tx) => setTransactionMessageFeePayer(payer, tx), (tx) => appendTransactionMessageInstructions(ixs, tx), (tx) => compressTransactionMessageUsingAddressLookupTables(tx, luts), (tx) => setTransactionMessageLifetimeUsingBlockhash(INVALID_BUT_SUFFICIENT_FOR_COMPILATION_BLOCKHASH, tx));
    const compiledTransaction = compileTransaction(transactionMessage);
    const wireTransactionBytes = getBase64EncodedWireTransaction(compiledTransaction);
    try {
        const res = await rpc
            .simulateTransaction(wireTransactionBytes, {
            encoding: 'base64',
            replaceRecentBlockhash: true,
            sigVerify: false,
        })
            .send();
        if (res.value.err) {
            if (log) {
                logger.warn(`${withDescription} Error simulating transaction`, new SimulateTransactionError(res.value.logs || undefined, res.value.unitsConsumed, res.value.err));
            }
            return false;
        }
        return true;
    }
    catch (e) {
        if (log) {
            logger.warn(`${withDescription} Error simulating transaction`, e);
        }
        return false;
    }
}
export function maxLockedAccounts(count) {
    return MAX_LOCKED_ACCOUNTS - count;
}
export function uniqueAccounts(ixs, addressLookupTables = [], ...additional) {
    let luts;
    if (addressLookupTables.length > 0 && 'address' in addressLookupTables[0]) {
        luts = addressLookupTables.map((lut) => lut.address);
    }
    else {
        luts = addressLookupTables;
    }
    const uniqueAccounts = ixs
        .map((ix) => [ix.programAddress, ...(ix.accounts || []).map((k) => k.address)])
        .flat()
        .concat(...luts, ...additional);
    return new Set(uniqueAccounts);
}
export class TransactionError extends Error {
    sig;
    logs;
    cause;
    constructor(message, sig, logs, cause) {
        super(message);
        this.sig = sig;
        this.logs = logs;
        this.cause = cause;
    }
}
export class SimulateTransactionError extends Error {
    logs;
    unitsConsumed;
    cause;
    constructor(logs, unitsConsumed, cause) {
        super('Failed to simulate transaction');
        this.logs = logs;
        this.unitsConsumed = unitsConsumed;
        this.cause = cause;
    }
}
//# sourceMappingURL=instruction.js.map