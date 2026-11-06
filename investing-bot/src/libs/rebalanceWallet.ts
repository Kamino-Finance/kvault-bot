import { Decimal } from 'decimal.js';
import { Address, TransactionSigner } from '@solana/kit';
import { ConnectionPool } from 'kvaults-investing-bot-tx/ConnectionPool';
import { createAddExtraComputeUnitsTransaction } from 'kvaults-investing-bot-tx/computeBudget';
import { sendAndConfirmTransactionV0 } from 'kvaults-investing-bot-tx/instruction';
import { getDepositWsolIxns } from './tokenOperations.js';

export async function wrapSol(
  c: ConnectionPool,
  owner: TransactionSigner,
  wsolDestinationAta: Address,
  lamports: Decimal
): Promise<string> {
  const budgetIxs = createAddExtraComputeUnitsTransaction(5000);
  const syncNativeIxs = getDepositWsolIxns(owner, wsolDestinationAta, lamports.floor());
  return sendAndConfirmTransactionV0(c, owner, [...budgetIxs, ...syncNativeIxs], [], [], 'RebalanceWalletWrapSol', {
    reportSample: false,
    sendIfSimulationFailed: true,
  });
}
