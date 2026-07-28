import { AddressLookupTable, decodeAddressLookupTable } from '@solana-program/address-lookup-table';
import { Account, Address, fetchEncodedAccount, GetAccountInfoApi, Rpc } from '@solana/kit';

export async function getLut(c: Rpc<GetAccountInfoApi>, lut: Address): Promise<Account<AddressLookupTable>> {
  const acc = await fetchEncodedAccount(c, lut);
  if (!acc.exists) {
    throw new Error(`LUT account not found: ${lut}`);
  }
  return decodeAddressLookupTable(acc);
}
