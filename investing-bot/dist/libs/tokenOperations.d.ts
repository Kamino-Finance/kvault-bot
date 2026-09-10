import { Address, Instruction, Rpc, GetMultipleAccountsApi, TransactionSigner } from '@solana/kit';
import { Decimal } from 'decimal.js';
export declare function getDepositWsolIxns(owner: TransactionSigner<string>, ata: Address, amountLamports: Decimal): Instruction<string, readonly (import("@solana/kit").AccountLookupMeta<string, string> | import("@solana/kit").AccountMeta<string>)[]>[];
export declare function getAssociatedTokenAddress(mint: Address, owner: Address, tokenProgram?: Address): Promise<Address>;
export declare function batchFetchAllMaybeToken(rpc: Rpc<GetMultipleAccountsApi>, addresses: Address[]): Promise<import("@solana/kit").MaybeAccount<import("@solana-program/token-2022").Token>[]>;
//# sourceMappingURL=tokenOperations.d.ts.map