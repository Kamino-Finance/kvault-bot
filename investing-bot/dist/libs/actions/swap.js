import { Decimal } from 'decimal.js';
import { lamportsToDecimal } from '@kamino-finance/klend-sdk';
import { WRAPPED_SOL_MINT } from 'kvaults-investing-bot-tx/instruction';
import { getAssociatedTokenAddress } from '../tokenOperations.js';
import { wrapSol } from '../rebalanceWallet.js';
export var SwapMode;
(function (SwapMode) {
    SwapMode["ExactIn"] = "exactIn";
    SwapMode["ExactOut"] = "exactOut";
})(SwapMode || (SwapMode = {}));
/**
 * If the swap is between SOL and SOL wrap
 */
export async function wrapOrSwap(c, swapper, payer, fromToken, toToken, amountLamports, swapConfig, userLuts, description = 'SOL wrap/unwrap') {
    if (fromToken === WRAPPED_SOL_MINT && toToken === WRAPPED_SOL_MINT) {
        const wsolAta = await getAssociatedTokenAddress(WRAPPED_SOL_MINT, payer.address);
        return await wrapSol(c, payer, wsolAta, lamportsToDecimal(new Decimal(amountLamports.toString()), 9));
    }
    else {
        return (await swapper.swap(c, fromToken, toToken, amountLamports, swapConfig, userLuts, description)).tx;
    }
}
//# sourceMappingURL=swap.js.map