import { AddressLookupTable } from '@solana-program/address-lookup-table';
import { Account, Address, GetAccountInfoApi, Rpc } from '@solana/kit';
export declare function getLut(c: Rpc<GetAccountInfoApi>, lut: Address): Promise<Account<AddressLookupTable>>;
//# sourceMappingURL=lut.d.ts.map