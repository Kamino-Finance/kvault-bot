export async function fetchBlockhash(rpc) {
    const res = await rpc.getLatestBlockhash({ commitment: 'finalized' }).send();
    return {
        blockhash: res.value.blockhash,
        lastValidBlockHeight: res.value.lastValidBlockHeight,
        slot: res.context.slot,
    };
}
//# sourceMappingURL=blockhash.js.map