import { decodeAddressLookupTable } from '@solana-program/address-lookup-table';
import { fetchEncodedAccount } from '@solana/kit';
export async function getLut(c, lut) {
    const acc = await fetchEncodedAccount(c, lut);
    if (!acc.exists) {
        throw new Error(`LUT account not found: ${lut}`);
    }
    return decodeAddressLookupTable(acc);
}
//# sourceMappingURL=lut.js.map