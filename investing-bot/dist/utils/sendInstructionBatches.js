import { sendAndConfirmTransactionV0 } from 'kvaults-investing-bot-tx/instruction';
/** Sends instructions in SDK order, yielding and reporting health between batches. */
export async function sendInstructionBatches({ connectionPool, payer, instructions, lookupTables, signers, description, batchSize, options, heartbeat, sendTx = sendAndConfirmTransactionV0, }) {
    for (let index = 0; index < instructions.length; index += batchSize) {
        await sendTx(connectionPool, payer, instructions.slice(index, index + batchSize), lookupTables, signers, description, options);
        await new Promise((resolve) => setImmediate(resolve));
        heartbeat?.();
    }
}
//# sourceMappingURL=sendInstructionBatches.js.map