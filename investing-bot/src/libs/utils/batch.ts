/** The maximum number of chunk fetches `batchFetch` keeps in flight at one time. */
const MAX_IN_FLIGHT_BATCHES = 25;

export async function batchFetch<A, T>(
  addresses: Array<A>,
  fetchBatch: (chunk: Array<A>) => Promise<Array<T>>,
  chunkSize: number = 100 // limit for web3 client getMultipleAccounts fetch
): Promise<Array<T>> {
  const results: Array<Array<T>> = [];
  for (const group of chunks(chunks(addresses, chunkSize), MAX_IN_FLIGHT_BATCHES)) {
    results.push(...(await Promise.all(group.map((chunk) => fetchBatch(chunk)))));
  }
  return results.reduce((acc, curr) => acc.concat(...curr), new Array<T>());
}

export function chunks<T>(array: T[], size: number): T[][] {
  if (size <= 0) {
    throw new Error('chunk size must be greater than 0');
  }

  const result: T[][] = [];
  for (let index = 0; index < array.length; index += size) {
    result.push(array.slice(index, index + size));
  }
  return result;
}
