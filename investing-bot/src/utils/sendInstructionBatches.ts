import { AddressLookupTable } from '@solana-program/address-lookup-table';
import { Account, IInstruction, TransactionSigner } from '@solana/kit';
import { ConnectionPool } from 'kvaults-investing-bot-tx/ConnectionPool';
import { sendAndConfirmTransactionV0, SendTransactionOptions } from 'kvaults-investing-bot-tx/instruction';
import { LoopHeartbeat } from './loop.js';

interface SendInstructionBatchesRequest {
  connectionPool: ConnectionPool;
  payer: TransactionSigner;
  instructions: IInstruction[];
  lookupTables: Account<AddressLookupTable>[];
  signers: TransactionSigner[];
  description: string;
  batchSize: number;
  options?: SendTransactionOptions;
  heartbeat?: LoopHeartbeat;
  sendTx?: typeof sendAndConfirmTransactionV0;
}

/** Sends instructions in SDK order, yielding and reporting health between batches. */
export async function sendInstructionBatches({
  connectionPool,
  payer,
  instructions,
  lookupTables,
  signers,
  description,
  batchSize,
  options,
  heartbeat,
  sendTx = sendAndConfirmTransactionV0,
}: SendInstructionBatchesRequest): Promise<void> {
  for (let index = 0; index < instructions.length; index += batchSize) {
    await sendTx(
      connectionPool,
      payer,
      instructions.slice(index, index + batchSize),
      lookupTables,
      signers,
      description,
      options
    );
    await new Promise((resolve) => setImmediate(resolve));
    heartbeat?.();
  }
}
