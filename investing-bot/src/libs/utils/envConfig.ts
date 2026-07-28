import { PROGRAM_ID as KLendProgramId, KVAULTS_PROGRAM_ID } from '@kamino-finance/klend-sdk';

import {
  ConnectionPoolConfig,
  MulticastTransportConfig,
  PriorityFeeConfig,
} from 'kvaults-investing-bot-tx/ConnectionPool';
import { address, Address } from '@solana/kit';
import { RpcEndpointsConfig } from 'kvaults-investing-bot-tx/model';

import { DEFAULT_GRID_SEARCH_RESOLUTION } from '../../allocationsRebalance/utils/maxYieldOptimizers.js';
import { DEFAULT_MARKET_PRICE_MAX_AGE_SECONDS } from '../../utils/price.js';
import {
  DEFAULT_BLACKLIST_PATH,
  DEFAULT_LOOP_INTERVAL_MS,
  DEFAULT_MIN_INVEST_TOKENS,
  DEFAULT_MIN_SECONDS_SINCE_LAST_INVEST,
} from './consts.js';
import {
  getEnvOrDefault,
  getEnv,
  getEnvOrThrowInProduction,
  getEnvOrDefaultKey,
  getEnvOrDefaultNum,
  getEnvOrDefaultBool,
  getEnvOrDefaultJson,
  getAllEnvsByPrefix,
} from './env.js';
import { parseRpcEndpointsConfigEnvs } from './rpcConfig.js';

export { parseRpcEndpointsConfigEnvs } from './rpcConfig.js';

export type BaseEnvConfig = {
  wsEndpoint?: string;
  rpcEndpointsConfig: RpcEndpointsConfig;
  kswapApiBaseUrl: string;
  kswapApiKey?: string;
  klendProgramId: Address;
  kvaultsProgramId: Address;
  connectionPoolConfig: ConnectionPoolConfig;
  rpcMulticastEndpoints: Array<MulticastTransportConfig>;
  rpcEndpoint?: string;
  investVaultKeyOverrides: Address[];
  investVaultOwners: Address[];
  investUIVaults: boolean;
  allocationConfigPath: string;
  loopIntervalMs: number;
  minInvestTokens: number;
  minSecondsSinceLastInvest: number;
  defaultSwapSlippageBps: number;
  defaultPriceSlippageBps: number;
  gridSearchResolution: number;
  verbose: boolean;
  allocationDryRun: boolean;
  blacklistPath: string;
  marketPriceMaxAgeSeconds: number;
};

export function fromBaseEnv(): BaseEnvConfig {
  // read vaults and owners from env
  const vaults = getEnvOrDefault('INVEST_VAULTS', '');
  const owners = getEnvOrDefault('INVEST_OWNERS', '');
  const investVaultKeyOverrides = parseEnvList(vaults);
  const investVaultOwners = parseEnvList(owners);

  const VERBOSE = getEnvOrDefaultBool('VERBOSE', false);

  // RPC
  const rpcEndpoint = getEnv('RPC_ENDPOINT');
  const wsEndpoint = getEnv('WS_ENDPOINT');
  const KLEND_PROGRAM_ID = getEnvOrDefaultKey('KLEND_PROGRAM_ID', KLendProgramId);
  const VAULTS_PROGRAM_ID = getEnvOrDefaultKey('KVAULTS_PROGRAM_ID', KVAULTS_PROGRAM_ID);
  const ALLOCATION_CONFIG_PATH = getEnvOrDefault('ALLOCATION_CONFIG_PATH', '');

  const LOOP_INTERVAL_MS = getEnvOrDefaultNum('LOOP_INTERVAL_MS', DEFAULT_LOOP_INTERVAL_MS);
  const MIN_INVEST_TOKENS = getEnvOrDefaultNum('MIN_INVEST_TOKENS', DEFAULT_MIN_INVEST_TOKENS);
  const INVEST_UI_VAULTS = getEnvOrDefaultBool('INVEST_UI_VAULTS', false);
  const MIN_SECONDS_SINCE_LAST_INVEST = getEnvOrDefaultNum(
    'MIN_SECONDS_SINCE_LAST_INVEST',
    DEFAULT_MIN_SECONDS_SINCE_LAST_INVEST
  );
  validatePositiveSafeInteger(LOOP_INTERVAL_MS, 'LOOP_INTERVAL_MS');
  validateNonNegativeFiniteNumber(MIN_INVEST_TOKENS, 'MIN_INVEST_TOKENS');
  validateNonNegativeSafeInteger(MIN_SECONDS_SINCE_LAST_INVEST, 'MIN_SECONDS_SINCE_LAST_INVEST');
  /**
   * Send the same tx multiple times
   */
  const SPAM = getEnvOrDefaultBool('SPAM', false);
  /**
   * Priority fee percentile parameter - either an exact percentile number (e.g. `25` for 25th percentile), or a boolean
   * flag (which enables it with a default value of `50`).
   *
   * Defaults to `true` (which means "enabled with 50th percentile").
   *
   * In order for this setting to be effective, at least of the RPCs specified by `RPC_ENDPOINT` / `RPC_ENDPOINTS` must
   * support percentile queries - see `parseRpcEndpointsConfig()` and `determineFeePercentileSupport()`.
   *
   * See examples in the "Percentile-based fee discovery" section of the top-level `README.md`.
   * See https://docs.triton.one/chains/solana/improved-priority-fees-api for details on a percentile API itself.
   */
  const PRIORITY_FEE_PERCENTILE = getOrDerivePriorityFeePercentile(getEnv('PRIORITY_FEE_PERCENTILE'));
  /**
   * Priority fee bounds
   */
  const PRIORITY_MICRO_LAMPORTS_PER_CU_DEFAULT = getEnvOrDefaultNum('PRIORITY_MICRO_LAMPORTS_PER_CU_DEFAULT', 5_000);
  const PRIORITY_MICRO_LAMPORTS_PER_CU_MIN = getEnvOrDefaultNum('PRIORITY_MICRO_LAMPORTS_PER_CU_MIN', 1);
  const PRIORITY_MICRO_LAMPORTS_PER_CU_MAX = getEnvOrDefaultNum('PRIORITY_MICRO_LAMPORTS_PER_CU_MAX', 4_000_000);
  validateNonNegativeSafeInteger(PRIORITY_MICRO_LAMPORTS_PER_CU_DEFAULT, 'PRIORITY_MICRO_LAMPORTS_PER_CU_DEFAULT');
  validateNonNegativeSafeInteger(PRIORITY_MICRO_LAMPORTS_PER_CU_MIN, 'PRIORITY_MICRO_LAMPORTS_PER_CU_MIN');
  validateNonNegativeSafeInteger(PRIORITY_MICRO_LAMPORTS_PER_CU_MAX, 'PRIORITY_MICRO_LAMPORTS_PER_CU_MAX');
  if (
    PRIORITY_MICRO_LAMPORTS_PER_CU_DEFAULT < PRIORITY_MICRO_LAMPORTS_PER_CU_MIN ||
    PRIORITY_MICRO_LAMPORTS_PER_CU_DEFAULT > PRIORITY_MICRO_LAMPORTS_PER_CU_MAX
  ) {
    throw new Error(
      `Inconsistent priority fee bounds: ${PRIORITY_MICRO_LAMPORTS_PER_CU_MIN} <= ${PRIORITY_MICRO_LAMPORTS_PER_CU_DEFAULT} <= ${PRIORITY_MICRO_LAMPORTS_PER_CU_MAX}`
    );
  }
  const PRIORITY_FEE_CONFIG: PriorityFeeConfig = {
    priorityFeePercentile: PRIORITY_FEE_PERCENTILE,
    microLamportsPerCuDefault: PRIORITY_MICRO_LAMPORTS_PER_CU_DEFAULT,
    microLamportsPerCuMin: PRIORITY_MICRO_LAMPORTS_PER_CU_MIN,
    microLamportsPerCuMax: PRIORITY_MICRO_LAMPORTS_PER_CU_MAX,
  };

  /**
   * Simulate transactions to find the approx CU consumed before sending
   */
  const SIMULATE = getEnvOrDefaultBool('SIMULATE', true);
  /**
   * Multicast transactions to Jito validators with a tip ix
   */
  const MULTICAST_JITO = getEnvOrDefaultBool('MULTICAST_JITO', false);
  const CONNECTION_POOL_CONFIG: ConnectionPoolConfig = {
    spam: SPAM,
    simulate: SIMULATE,
    multicastJito: MULTICAST_JITO,
    priorityFeeConfig: PRIORITY_FEE_CONFIG,
  };

  /**
   * Send the same tx to multiple endpoints
   * e.g. RPC_MULTICAST_ENDPOINTS='[{"name": "ironforge", "connection": "https://..."}]'
   * Alternatively,
   * RPC_MULTICAST_ENDPOINT_IRONFORGE='https://...'
   */
  const RPC_MULTICAST_ENDPOINTS: Array<MulticastTransportConfig> = getRpcMulticastEndpoints();

  // See the `parseRpcEndpointsConfigEnvs()`'s doc for the behavior of `RPC_ENDPOINT` (legacy) and `RPC_ENDPOINTS`:
  const rpcEndpointsConfig = parseRpcEndpointsConfigEnvs();

  const KSWAP_API_BASE_URL = getEnvOrDefault('KSWAP_API_BASE_URL', 'https://api.kamino.finance/kswap');
  validateHttpUrl(KSWAP_API_BASE_URL, 'KSWAP_API_BASE_URL');
  const KSWAP_API_KEY = getEnv('KSWAP_API_KEY');
  const DEFAULT_SWAP_SLIPPAGE_BPS = getEnvOrDefaultNum('DEFAULT_SWAP_SLIPPAGE_BPS', 100);
  const DEFAULT_PRICE_SLIPPAGE_BPS = getEnvOrDefaultNum('DEFAULT_PRICE_SLIPPAGE_BPS', 150);
  validateSlippageBps(DEFAULT_SWAP_SLIPPAGE_BPS, 'DEFAULT_SWAP_SLIPPAGE_BPS');
  validateSlippageBps(DEFAULT_PRICE_SLIPPAGE_BPS, 'DEFAULT_PRICE_SLIPPAGE_BPS');
  const MARKET_PRICE_MAX_AGE_SECONDS = getEnvOrDefaultNum(
    'MARKET_PRICE_MAX_AGE_SECONDS',
    DEFAULT_MARKET_PRICE_MAX_AGE_SECONDS
  );
  if (MARKET_PRICE_MAX_AGE_SECONDS <= 0) {
    throw new Error('MARKET_PRICE_MAX_AGE_SECONDS must be greater than 0');
  }
  const ALLOCATION_DRY_RUN = getEnvOrDefaultBool('ALLOCATION_DRY_RUN', false);
  const GRID_SEARCH_RESOLUTION = getEnvOrDefaultNum('GRID_SEARCH_RESOLUTION', DEFAULT_GRID_SEARCH_RESOLUTION);
  if (GRID_SEARCH_RESOLUTION <= 0 || GRID_SEARCH_RESOLUTION > 1) {
    throw new Error('GRID_SEARCH_RESOLUTION must be in (0, 1]');
  }
  // The danger-detection blacklist must survive restarts, so it has to live on a persistent volume.
  // In production we refuse to start with the ephemeral container-local default and require an explicit path.
  const DANGER_BLACKLIST_PATH = getEnvOrThrowInProduction('DANGER_BLACKLIST_PATH', DEFAULT_BLACKLIST_PATH);
  // `getEnvOrThrowInProduction` keys off presence (`in process.env`), so an explicitly empty value
  // slips past both the production guard and the default and would read as `''` → ENOENT → a silent
  // empty blacklist (danger enforcement disabled with no error). Reject it explicitly.
  if (DANGER_BLACKLIST_PATH.trim().length === 0) {
    throw new Error(
      'DANGER_BLACKLIST_PATH is set but empty — refusing to start with an unusable blacklist path (danger enforcement would silently read an empty blacklist)'
    );
  }
  return {
    rpcEndpointsConfig,
    rpcEndpoint,
    kswapApiBaseUrl: KSWAP_API_BASE_URL,
    kswapApiKey: KSWAP_API_KEY,
    wsEndpoint,
    klendProgramId: KLEND_PROGRAM_ID,
    kvaultsProgramId: VAULTS_PROGRAM_ID,
    connectionPoolConfig: CONNECTION_POOL_CONFIG,
    rpcMulticastEndpoints: RPC_MULTICAST_ENDPOINTS,
    investVaultKeyOverrides,
    investVaultOwners,
    investUIVaults: INVEST_UI_VAULTS,
    allocationConfigPath: ALLOCATION_CONFIG_PATH,
    loopIntervalMs: LOOP_INTERVAL_MS,
    minInvestTokens: MIN_INVEST_TOKENS,
    minSecondsSinceLastInvest: MIN_SECONDS_SINCE_LAST_INVEST,
    defaultSwapSlippageBps: DEFAULT_SWAP_SLIPPAGE_BPS,
    defaultPriceSlippageBps: DEFAULT_PRICE_SLIPPAGE_BPS,
    verbose: VERBOSE,
    allocationDryRun: ALLOCATION_DRY_RUN,
    gridSearchResolution: GRID_SEARCH_RESOLUTION,
    blacklistPath: DANGER_BLACKLIST_PATH,
    marketPriceMaxAgeSeconds: MARKET_PRICE_MAX_AGE_SECONDS,
  };
}

export function parseEnvList(vaults: string): Address[] {
  // Remove # comments from the end of the line
  return vaults
    .replace(/#.+$/, '')
    .split(/[\s,]+/)
    .filter((s) => s !== '')
    .map((m) => address(m.trim()));
}

const DEFAULT_FEE_PERCENTILE = 50;

function getOrDerivePriorityFeePercentile(percentileString: string | undefined): number | undefined {
  // See `PRIORITY_FEE_PERCENTILE` env's doc for contract - we want to allow either a number or a boolean here (to not
  // break any existing scripts etc.):
  switch (percentileString) {
    case undefined:
      return DEFAULT_FEE_PERCENTILE;
    case 'true':
      return DEFAULT_FEE_PERCENTILE;
    case 'false':
      return undefined;
    default:
      const percentile = Number(percentileString);
      if (!Number.isFinite(percentile) || percentile < 0 || percentile > 100) {
        throw new Error(`PRIORITY_FEE_PERCENTILE must be "true", "false", or a number in [0, 100]`);
      }
      return percentile;
  }
}

function validatePositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function validateNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

function validateNonNegativeFiniteNumber(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number`);
  }
}

function validateSlippageBps(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 10_000) {
    throw new Error(`${name} must be a safe integer in [0, 10000)`);
  }
}

function validateHttpUrl(value: string, name: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new Error(`${name} must be a valid HTTP(S) URL`, { cause: error });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${name} must be a valid HTTP(S) URL`);
  }
}

/**
 * Send the same tx to multiple endpoints
 * e.g. RPC_MULTICAST_ENDPOINTS='[{"name": "ironforge", "connection": "https://..."}]'
 * Alternatively,
 * RPC_MULTICAST_ENDPOINT_IRONFORGE='https://...'
 */
export function getRpcMulticastEndpoints(): Array<MulticastTransportConfig> {
  return [
    ...getEnvOrDefaultJson('RPC_MULTICAST_ENDPOINTS', []),
    ...[...getAllEnvsByPrefix('RPC_MULTICAST_ENDPOINT_').entries()].map(([keySuffix, value]) => {
      return {
        name: upperSnakeCaseToKebabCase(keySuffix),
        connection: value,
      };
    }),
  ];
}

function upperSnakeCaseToKebabCase(input: string): string {
  return input.toLowerCase().replace(/_/g, '-');
}
