import {
  ADDRESS_LOOKUP_TABLE_DISCRIMINATOR,
  ADDRESS_LOOKUP_TABLE_PROGRAM_ADDRESS,
  AddressLookupTable,
  decodeAddressLookupTable,
} from '@solana-program/address-lookup-table';
import { Account, Address, fetchEncodedAccount, GetAccountInfoApi, isAddress, Rpc } from '@solana/kit';
import { U64_MAX, VaultState } from '@kamino-finance/klend-sdk';
import axios from 'axios';
import { logger } from 'kvaults-investing-bot-logger';
import { DEFAULT_PUBLIC_KEY, sendAndConfirmTransactionV0 } from 'kvaults-investing-bot-tx/instruction';
import { EXTERNAL_REQUEST_TIMEOUT_MS, RPC_REQUEST_TIMEOUT_MS, withTimeout } from '../utils/timeout.js';

const MANAGED_LUTS_URL = 'https://api.kamino.finance/luts/managed';
const MANAGED_LUTS_CACHE_MS = 5 * 60 * 1000;
const MANAGED_LUTS_FAILURE_CACHE_MS = 30 * 1000;

/** Cache API addresses only. Each caller supplies the current state LUT separately. */
export class ManagedVaultLookupTableCache {
  private readonly cache = new Map<Address, { addresses: Address[]; expiresAtMs: number; failed: boolean }>();
  private readonly pending = new Map<Address, Promise<Address[]>>();
  private readonly excluded = new Set<Address>();

  constructor(
    private readonly apiUrl: string = MANAGED_LUTS_URL,
    private readonly nowMilliseconds: () => number = () => performance.now()
  ) {}

  async get(vaultAddress: Address): Promise<Address[]> {
    const cached = this.cache.get(vaultAddress);
    if (cached !== undefined && cached.expiresAtMs > this.nowMilliseconds()) {
      return cached.addresses;
    }
    const pending = this.pending.get(vaultAddress);
    if (pending !== undefined) {
      return pending;
    }

    const request = this.fetch(vaultAddress);
    this.pending.set(vaultAddress, request);
    try {
      return await request;
    } finally {
      this.pending.delete(vaultAddress);
    }
  }

  /** Refreshes successful cached data. API failures retain their short retry delay. */
  async refresh(vaultAddress: Address): Promise<Address[]> {
    const cached = this.cache.get(vaultAddress);
    if (cached?.failed && cached.expiresAtMs > this.nowMilliseconds()) return cached.addresses;
    this.cache.delete(vaultAddress);
    return this.get(vaultAddress);
  }

  exclude(address: Address): void {
    this.excluded.add(address);
  }

  isExcluded(address: Address): boolean {
    return this.excluded.has(address);
  }

  private async fetch(vaultAddress: Address): Promise<Address[]> {
    let addresses: Address[];
    let cacheMs: number;
    let failed = false;
    try {
      const { data } = await axios.get<unknown>(this.apiUrl, {
        params: { productIdentifierAddress: vaultAddress },
        timeout: EXTERNAL_REQUEST_TIMEOUT_MS,
      });
      if (
        typeof data !== 'object' ||
        data === null ||
        !('productIdentifierAddress' in data) ||
        data.productIdentifierAddress !== vaultAddress ||
        !('lutAddresses' in data) ||
        !Array.isArray(data.lutAddresses) ||
        !data.lutAddresses.every((value): value is Address => typeof value === 'string' && isAddress(value))
      ) {
        throw new Error(`Invalid managed LUT response for vault ${vaultAddress}`);
      }
      addresses = data.lutAddresses;
      cacheMs = MANAGED_LUTS_CACHE_MS;
    } catch (error) {
      logger.warn(`[managed-luts] API read failed for vault ${vaultAddress}: ${error}. Ignoring managed API tables.`);
      addresses = [];
      cacheMs = MANAGED_LUTS_FAILURE_CACHE_MS;
      failed = true;
    }
    this.cache.set(vaultAddress, { addresses, expiresAtMs: this.nowMilliseconds() + cacheMs, failed });
    return addresses;
  }
}

const managedVaultLookupTables = new ManagedVaultLookupTableCache();
const activeDeactivationSlot = BigInt(U64_MAX);

interface LookupTableRecoveryContext {
  rpc: Rpc<GetAccountInfoApi>;
  vaultAddress: Address;
  vaultState: VaultState;
  logPrefix: string;
  managedLookupTables: ManagedVaultLookupTableCache;
  pending?: Promise<void>;
}

const recoveryContexts = new WeakMap<Account<AddressLookupTable>[], LookupTableRecoveryContext>();
const recoverySenders = new WeakSet<typeof sendAndConfirmTransactionV0>();

export async function getLut(c: Rpc<GetAccountInfoApi>, lut: Address): Promise<Account<AddressLookupTable>> {
  const acc = await fetchEncodedAccount(c, lut);
  if (!acc.exists) {
    throw new Error(`LUT account not found: ${lut}`);
  }
  return decodeAddressLookupTable(acc);
}

/** Merge the current state LUT with cached API LUTs. Optional API LUT failures preserve the state LUT. */
export async function loadVaultLookupTables(
  rpc: Rpc<GetAccountInfoApi>,
  vaultAddress: Address,
  vaultState: VaultState,
  logPrefix: string,
  managedLookupTables: ManagedVaultLookupTableCache = managedVaultLookupTables
): Promise<Account<AddressLookupTable>[]> {
  const load = (lutAddress: Address) =>
    withTimeout(getLut(rpc, lutAddress), RPC_REQUEST_TIMEOUT_MS, `${logPrefix} get lut ${lutAddress}`);
  const stateTables =
    vaultState.vaultLookupTable === DEFAULT_PUBLIC_KEY || managedLookupTables.isExcluded(vaultState.vaultLookupTable)
      ? []
      : [await load(vaultState.vaultLookupTable)];
  const addresses = await managedLookupTables.get(vaultAddress);
  const managedAddresses = [...new Set(addresses)].filter(
    (lutAddress) =>
      lutAddress !== DEFAULT_PUBLIC_KEY &&
      lutAddress !== vaultState.vaultLookupTable &&
      !managedLookupTables.isExcluded(lutAddress)
  );
  let tables: Account<AddressLookupTable>[];
  try {
    tables = [...stateTables, ...(await Promise.all(managedAddresses.map(load)))];
  } catch (error) {
    logger.warn(
      `${logPrefix} managed LUT read failed for vault ${vaultAddress}: ${error}. Keeping available state LUTs.`
    );
    tables = stateTables;
  }
  recoveryContexts.set(tables, { rpc, vaultAddress, vaultState, logPrefix, managedLookupTables });
  return tables;
}

/**
 * Checks LUT metadata only after a failed send. Recovery never resends that transaction, including unknown outcomes.
 * The original table array is updated for later attempts. Callers must preserve its identity.
 */
export function withVaultLookupTableRecovery(
  sendTx: typeof sendAndConfirmTransactionV0 = sendAndConfirmTransactionV0
): typeof sendAndConfirmTransactionV0 {
  if (recoverySenders.has(sendTx)) return sendTx;
  const send: typeof sendAndConfirmTransactionV0 = async (...args) => {
    try {
      return await sendTx(...args);
    } catch (error) {
      const tables = args[3];
      const context = recoveryContexts.get(tables);
      if (context && tables.length > 0) {
        const pending = (context.pending ??= refreshLookupTables(tables, context));
        try {
          await pending;
        } catch (refreshError) {
          logger.warn(`${context.logPrefix} LUT recovery failed for vault ${context.vaultAddress}: ${refreshError}`);
        } finally {
          if (context.pending === pending) context.pending = undefined;
        }
      }
      throw error;
    }
  };
  recoverySenders.add(send);
  return send;
}

function hasVerifiedMetadata(table: Account<AddressLookupTable>): boolean {
  return (
    table.programAddress === ADDRESS_LOOKUP_TABLE_PROGRAM_ADDRESS &&
    table.data.discriminator === ADDRESS_LOOKUP_TABLE_DISCRIMINATOR
  );
}

async function refreshLookupTables(
  tables: Account<AddressLookupTable>[],
  { rpc, vaultAddress, vaultState, logPrefix, managedLookupTables }: LookupTableRecoveryContext
): Promise<void> {
  const observations = await Promise.all(
    tables.map(async ({ address }) => {
      const account = await withTimeout(
        fetchEncodedAccount(rpc, address),
        RPC_REQUEST_TIMEOUT_MS,
        `${logPrefix} check lut ${address}`
      );
      return account.exists ? decodeAddressLookupTable(account) : undefined;
    })
  );
  // Missing or unverifiable metadata does not prove deactivation. Keep the prior tables and cache unchanged.
  if (observations.some((table) => table === undefined || !hasVerifiedMetadata(table))) return;
  const verified = observations.filter((table) => table !== undefined);
  const inactive = verified.filter((table) => table.data.deactivationSlot !== activeDeactivationSlot);
  if (inactive.length === 0) return;
  // Solana permits lookups during the SlotHashes cooldown. After a failure, omit deactivating tables conservatively.
  for (const { address } of inactive) managedLookupTables.exclude(address);
  const addresses = await managedLookupTables.refresh(vaultAddress);
  const refreshed = await Promise.all(
    [...new Set([vaultState.vaultLookupTable, ...addresses])]
      .filter((address) => address !== DEFAULT_PUBLIC_KEY && !managedLookupTables.isExcluded(address))
      .map(
        (address) =>
          verified.find((table) => table.address === address) ??
          withTimeout(getLut(rpc, address), RPC_REQUEST_TIMEOUT_MS, `${logPrefix} get lut ${address}`)
      )
  );
  if (refreshed.some((table) => !hasVerifiedMetadata(table))) return;
  const usable = refreshed.filter((table) => {
    if (table.data.deactivationSlot === activeDeactivationSlot) return true;
    managedLookupTables.exclude(table.address);
    return false;
  });
  tables.splice(0, tables.length, ...usable);
}
