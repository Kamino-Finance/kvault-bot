import { createAddExtraComputeUnitsTransaction } from 'kvaults-investing-bot-tx/computeBudget';
import { sendAndConfirmTransactionV0 } from 'kvaults-investing-bot-tx/instruction';
import { getDepositWsolIxns } from './tokenOperations.js';
export async function wrapSol(c, owner, wsolDestinationAta, decimalAmount) {
    const budgetIxs = createAddExtraComputeUnitsTransaction(5000);
    const syncNativeIxs = getDepositWsolIxns(owner, wsolDestinationAta, decimalAmount.mul(10 ** 9).floor());
    return sendAndConfirmTransactionV0(c, owner, [...budgetIxs, ...syncNativeIxs], [], [], 'RebalanceWalletWrapSol', {
        reportSample: false,
        sendIfSimulationFailed: true,
    });
}
//# sourceMappingURL=rebalanceWallet.js.map