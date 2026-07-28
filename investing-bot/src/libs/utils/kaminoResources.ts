import { Address, address } from '@solana/kit';
import axios from 'axios';
import { EXTERNAL_REQUEST_TIMEOUT_MS } from '../../utils/timeout.js';

export const KAMINO_RESOURCES_URL = 'https://cdn.kamino.finance/resources.json';

export async function getAllUIEnabledVaults(): Promise<Address[]> {
  const resources = (await axios.get(KAMINO_RESOURCES_URL, { timeout: EXTERNAL_REQUEST_TIMEOUT_MS })).data;
  const uiVaults = resources['mainnet-beta']['vaults'];
  const shadowVaults = resources['mainnet-beta']['shadowVaults'];
  // Extract just the keys from the vaults object
  const vaultAddresses = Object.keys(uiVaults).concat(Object.keys(shadowVaults));
  const vaultsSet = new Set(vaultAddresses);
  return Array.from(vaultsSet).map((vault) => address(vault));
}
