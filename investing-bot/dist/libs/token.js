import { getInitializeAccount3Instruction } from '@solana-program/token-2022';
import { getCreateAccountInstruction } from '@solana-program/system';
export async function createTokenAccountInstructions(rpc, newAccount, mint, owner, tokenProgram, lamports) {
    let rent;
    if (!lamports) {
        rent = (await rpc.getMinimumBalanceForRentExemption(165n).send());
    }
    else {
        rent = lamports;
    }
    return [
        getCreateAccountInstruction({
            newAccount,
            payer: owner,
            programAddress: tokenProgram,
            lamports: rent,
            space: 165,
        }),
        getInitializeAccount3Instruction({
            owner: owner.address,
            account: newAccount.address,
            mint,
        }, { programAddress: tokenProgram }),
    ];
}
//# sourceMappingURL=token.js.map