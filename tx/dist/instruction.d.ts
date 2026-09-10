import { Rpc, Address, TransactionError as Web3TxError, SimulateTransactionApi, SendTransactionApi, Account, IInstruction, Blockhash, FullySignedTransaction, GetTransactionApi, TransactionWithBlockhashLifetime, Signature, TransactionSigner, SolanaError } from '@solana/kit';
import { AddressLookupTable } from '@solana-program/address-lookup-table';
import { ConnectionPool } from './ConnectionPool.js';
import { Cluster } from './model/Cluster.js';
import { BlockhashWithHeight } from './blockhash.js';
export declare const WRAPPED_SOL_MINT: Address<"So11111111111111111111111111111111111111112">;
export declare const DEFAULT_PUBLIC_KEY: Address<"11111111111111111111111111111111">;
export declare const MAX_LOCKED_ACCOUNTS = 64;
export declare function assertSimulationAllowsSend(simulationIsSuccessful: boolean, sendIfSimulationFailed: boolean): void;
export declare function base64EncodeTx(cluster: Cluster, payer: Address, instructions: IInstruction[], lookupTables?: Account<AddressLookupTable>[] | undefined): {
    encodedTx: string;
    simulationUrl: string;
};
export interface SendTransactionOptions {
    blockhash?: BlockhashWithHeight;
    reportSample?: boolean;
    sendIfSimulationFailed?: boolean;
}
export declare function sendAndConfirmTransactionV0(c: ConnectionPool, payer: TransactionSigner, instructions: IInstruction[], lookupTables: Account<AddressLookupTable>[], signers: TransactionSigner[], withDescription?: string, options?: SendTransactionOptions): Promise<Signature>;
export declare function txLink(sig: string, explorer?: 'SOLANA' | 'SOLSCAN'): string;
export declare function sendTx(rpc: Rpc<SendTransactionApi & GetTransactionApi>, tx: FullySignedTransaction, sig: Signature, blockhash: {
    blockhash: string;
    slot: bigint;
}, withDescription?: string): Promise<Signature>;
export declare function buildSignedTx(payer: TransactionSigner, instructions: IInstruction[], lookupTables: Account<AddressLookupTable>[], signers: TransactionSigner[], blockhash: {
    blockhash: Blockhash;
    lastValidBlockHeight: bigint;
}): Promise<FullySignedTransaction & TransactionWithBlockhashLifetime>;
export declare function getJitoTipInstruction(payer: TransactionSigner): IInstruction;
export declare function getTransactionInstructions(instructions: IInstruction[], payer: TransactionSigner, includeJitoTip: boolean): IInstruction[];
export declare function sendAndConfirmTx(c: ConnectionPool, tx: FullySignedTransaction & TransactionWithBlockhashLifetime, slot: bigint): Promise<void>;
export type TransactionResponse = ReturnType<GetTransactionApi['getTransaction']> | null;
export declare function transactionResponseIsSuccessful(response: TransactionResponse): boolean;
export declare function getSimulationComputeUnits(rpc: Rpc<SimulateTransactionApi>, instructions: Array<IInstruction>, payer: Address, lookupTables: Array<Account<AddressLookupTable>> | [], withDescription?: string, log?: boolean): Promise<number | null>;
export declare function simulateTxIsSuccessful(rpc: Rpc<SimulateTransactionApi>, instructions: Array<IInstruction>, payer: Address, lookupTables: Array<Account<AddressLookupTable>> | [], withDescription?: string, log?: boolean): Promise<boolean>;
export declare function maxLockedAccounts(count: number): number;
export declare function uniqueAccounts(ixs: IInstruction[], addressLookupTables?: Address[] | Account<AddressLookupTable>[], ...additional: Address[]): Set<Address>;
export declare class TransactionError extends Error {
    sig: string;
    logs: string[] | undefined;
    cause: Web3TxError | SolanaError | undefined;
    constructor(message: string, sig: string, logs?: string[] | undefined, cause?: Web3TxError | SolanaError);
}
export declare class SimulateTransactionError extends Error {
    logs: string[] | undefined;
    unitsConsumed: bigint | undefined;
    cause: Web3TxError | SolanaError | undefined;
    constructor(logs?: string[] | undefined, unitsConsumed?: bigint, cause?: Web3TxError | SolanaError);
}
//# sourceMappingURL=instruction.d.ts.map