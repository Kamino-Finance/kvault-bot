import { Address, IInstruction } from '@solana/kit';
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS } from '@solana-program/token-2022';

export function removeAtaIxsForMints(ixs: IInstruction[], ...mints: Address[]): IInstruction[] {
  const mintsSet = new Set<Address>(mints);
  return ixs.filter((ix) => {
    if (ix.programAddress === ASSOCIATED_TOKEN_PROGRAM_ADDRESS) {
      if (ix.accounts && mintsSet.has(ix.accounts[3].address)) {
        return false;
      }
    }
    return true;
  });
}
