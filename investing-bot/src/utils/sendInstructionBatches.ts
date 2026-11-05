import { AddressLookupTable } from '@solana-program/address-lookup-table';
import { Account, IInstruction, TransactionSigner } from '@solana/kit';
import { ConnectionPool } from 'kvaults-investing-bot-tx/ConnectionPool';
import { sendAndConfirmTransactionV0, SendTransactionOptions } from 'kvaults-investing-bot-tx/instruction';
import { withVaultLookupTableRecovery } from '../libs/lut.js';
import { LoopHeartbeat, whileBeating, yieldAndBeat } from './loop.js';

interface SendInstructionBatchesRequest {
  connectionPool: ConnectionPool;
  payer: TransactionSigner;
  instructions: IInstruction[];
  lookupTables: Account<AddressLookupTable>[];
  description: string;
  batchSize: number;
  options?: SendTransactionOptions;
  heartbeat?: LoopHeartbeat;
  sendTx?: typeof sendAndConfirmTransactionV0;
  /** Called after each batch lands, so a later failure cannot hide the batches that landed. */
  onBatchLanded?: () => void;
}

/** Sends instructions in SDK order, yielding and reporting health between batches. */
export async function sendInstructionBatches({
  connectionPool,
  payer,
  instructions,
  lookupTables,
  description,
  batchSize,
  options,
  heartbeat,
  sendTx = sendAndConfirmTransactionV0,
  onBatchLanded,
}: SendInstructionBatchesRequest): Promise<void> {
  const send = withVaultLookupTableRecovery(sendTx);
  const batchCount = Math.ceil(instructions.length / batchSize);
  for (let batchIndex = 0; batchIndex < batchCount; batchIndex += 1) {
    const index = batchIndex * batchSize;
    await whileBeating(heartbeat, () =>
      send(
        connectionPool,
        payer,
        instructions.slice(index, index + batchSize),
        lookupTables,
        [payer],
        description,
        options
      )
    );
    onBatchLanded?.();
    await yieldAndBeat(heartbeat);
  }
}
