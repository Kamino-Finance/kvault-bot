import { GetLatestBlockhashApi, Rpc, Blockhash } from '@solana/kit';
export type BlockhashWithHeight = {
    blockhash: Blockhash;
    lastValidBlockHeight: bigint;
    slot: bigint;
};
export declare function fetchBlockhash(rpc: Rpc<GetLatestBlockhashApi>): Promise<BlockhashWithHeight>;
//# sourceMappingURL=blockhash.d.ts.map