export async function batchFetch(addresses, fetchBatch, chunkSize = 100 // limit for web3 client getMultipleAccounts fetch
) {
    const results = await Promise.all(chunks(addresses, chunkSize).map((chunk) => fetchBatch(chunk)));
    return results.reduce((acc, curr) => acc.concat(...curr), new Array());
}
export function chunks(array, size) {
    return [...new Array(Math.ceil(array.length / size)).keys()].map((_, index) => array.slice(index * size, (index + 1) * size));
}
//# sourceMappingURL=batch.js.map