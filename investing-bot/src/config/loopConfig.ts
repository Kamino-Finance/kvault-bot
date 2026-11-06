import {
  ConnectionPoolConfig,
  MulticastTransportConfig,
  PriorityFeeConfig,
} from 'kvaults-investing-bot-tx/ConnectionPool';
import { Address } from '@solana/kit';
import { RpcEndpointsConfig } from 'kvaults-investing-bot-tx/model';

import { EXTERNAL_REQUEST_TIMEOUT_MS, RPC_REQUEST_TIMEOUT_MS } from '../utils/timeout.js';
import { getEnv } from '../libs/utils/env.js';
import { parseRpcEndpointsConfigEnvs } from '../libs/utils/rpcConfig.js';
import {
  readAddress,
  readAddressList,
  readBoolean,
  readJson,
  readNumber,
  readPath,
  readPrefix,
  readString,
  readUrl,
} from './schema.js';
import { SETTINGS } from './settings.js';

/** The settings both loops read: RPC, programs, transactions, KSwap and the danger blacklist. */
export type SharedConfig = {
  wsEndpoint?: string;
  rpcEndpointsConfig: RpcEndpointsConfig;
  kswapApiBaseUrl: string;
  kswapApiKey?: string;
  klendProgramId: Address;
  kvaultsProgramId: Address;
  connectionPoolConfig: ConnectionPoolConfig;
  rpcMulticastEndpoints: Array<MulticastTransportConfig>;
  reserveInvestCooldownMs: number;
  blacklistPath: string;
  marketPriceMaxAgeSeconds: number;
};

/** Each loop reads and validates only its own settings. */
export type InvestConfig = SharedConfig & {
  /** The shared allocation file supplies utilization limits for normal invests; empty means no configured limits. */
  allocationConfigPath: string;
  investVaultKeyOverrides: Address[];
  /** Vaults exempt from the MIN_SECONDS_SINCE_LAST_INVEST gate. */
  investMinSlotBypassVaults: Address[];
  investVaultOwners: Address[];
  investUIVaults: boolean;
  loopIntervalMs: number;
  minInvestTokens: number;
  minSecondsSinceLastInvest: number;
  defaultSwapSlippageBps: number;
  defaultPriceSlippageBps: number;
};

/** The settings of the allocation loop and its danger detection. */
export type AllocationLoopConfig = SharedConfig & {
  allocationConfigPath: string;
  gridSearchResolution: number;
  gridSearchMaxCandidates: number;
  gridSearchMaxMs: number;
  verbose: boolean;
  allocationDryRun: boolean;
  maxStalePriceDurationSeconds: number;
  dangerPassIntervalSeconds: number;
  reinvestCooldownSeconds: number;
};

export function readSharedConfig(): SharedConfig {
  // RPC
  // Optional: ConnectionPool derives wss:// from the read RPC URL when unset or blank.
  const wsEndpoint = readUrl(SETTINGS.WS_ENDPOINT);
  const KLEND_PROGRAM_ID = readAddress(SETTINGS.KLEND_PROGRAM_ID);
  const VAULTS_PROGRAM_ID = readAddress(SETTINGS.KVAULTS_PROGRAM_ID);

  const RESERVE_INVEST_COOLDOWN_MS = readNumber(SETTINGS.RESERVE_INVEST_COOLDOWN_MS);
  // utils/vaultReserves.ts reads it when it loads; read here too so a bad value stops the bot at start.
  readNumber(SETTINGS.VAULT_RESERVES_MAX_UNIQUE_RESERVES_PER_BATCH);
  /**
   * Send the same tx multiple times
   */
  const SPAM = readBoolean(SETTINGS.SPAM);
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
  const PRIORITY_FEE_PERCENTILE = getOrDerivePriorityFeePercentile(getEnv(SETTINGS.PRIORITY_FEE_PERCENTILE.name));
  /**
   * Priority fee bounds
   */
  const PRIORITY_MICRO_LAMPORTS_PER_CU_DEFAULT = readNumber(SETTINGS.PRIORITY_MICRO_LAMPORTS_PER_CU_DEFAULT);
  const PRIORITY_MICRO_LAMPORTS_PER_CU_MIN = readNumber(SETTINGS.PRIORITY_MICRO_LAMPORTS_PER_CU_MIN);
  const PRIORITY_MICRO_LAMPORTS_PER_CU_MAX = readNumber(SETTINGS.PRIORITY_MICRO_LAMPORTS_PER_CU_MAX);
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
  const SIMULATE = readBoolean(SETTINGS.SIMULATE);
  /**
   * Multicast transactions to Jito validators with a tip ix
   */
  const MULTICAST_JITO = readBoolean(SETTINGS.MULTICAST_JITO);
  const CONNECTION_POOL_CONFIG: ConnectionPoolConfig = {
    spam: SPAM,
    simulate: SIMULATE,
    multicastJito: MULTICAST_JITO,
    priorityFeeConfig: PRIORITY_FEE_CONFIG,
    rpcRequestTimeoutMs: RPC_REQUEST_TIMEOUT_MS,
    externalRequestTimeoutMs: EXTERNAL_REQUEST_TIMEOUT_MS,
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

  const KSWAP_API_BASE_URL = readUrl(SETTINGS.KSWAP_API_BASE_URL);
  validateHttpUrl(KSWAP_API_BASE_URL, 'KSWAP_API_BASE_URL');
  const KSWAP_API_KEY = readString(SETTINGS.KSWAP_API_KEY);
  const MARKET_PRICE_MAX_AGE_SECONDS = readNumber(SETTINGS.MARKET_PRICE_MAX_AGE_SECONDS);
  // The danger-detection blacklist must survive restarts, so it has to live on a persistent volume.
  // In production we refuse to start with the ephemeral container-local default and require an explicit path.
  const DANGER_BLACKLIST_PATH = readPath(SETTINGS.DANGER_BLACKLIST_PATH);
  // `readPath` keys off presence (`in process.env`), so an explicitly empty value
  // slips past both the production guard and the default and would read as `''` → ENOENT → a silent
  // empty blacklist (danger enforcement disabled with no error). Reject it explicitly.
  if (DANGER_BLACKLIST_PATH.trim().length === 0) {
    throw new Error(
      'DANGER_BLACKLIST_PATH is set but empty — refusing to start with an unusable blacklist path (danger enforcement would silently read an empty blacklist)'
    );
  }
  return {
    rpcEndpointsConfig,
    kswapApiBaseUrl: KSWAP_API_BASE_URL,
    kswapApiKey: KSWAP_API_KEY,
    wsEndpoint,
    klendProgramId: KLEND_PROGRAM_ID,
    kvaultsProgramId: VAULTS_PROGRAM_ID,
    connectionPoolConfig: CONNECTION_POOL_CONFIG,
    rpcMulticastEndpoints: RPC_MULTICAST_ENDPOINTS,
    reserveInvestCooldownMs: RESERVE_INVEST_COOLDOWN_MS,
    blacklistPath: DANGER_BLACKLIST_PATH,
    marketPriceMaxAgeSeconds: MARKET_PRICE_MAX_AGE_SECONDS,
  };
}

export function readInvestConfig(): InvestConfig {
  const shared = readSharedConfig();
  // read vaults and owners from env
  const investVaultKeyOverrides = readAddressList(SETTINGS.INVEST_VAULTS);
  const investVaultOwners = readAddressList(SETTINGS.INVEST_OWNERS);
  // Operator policy, so it lives in the environment rather than in source.
  const investMinSlotBypassVaults = readAddressList(SETTINGS.INVEST_MIN_SLOT_BYPASS_VAULTS);

  const LOOP_INTERVAL_MS = readNumber(SETTINGS.LOOP_INTERVAL_MS);
  const MIN_INVEST_TOKENS = readNumber(SETTINGS.MIN_INVEST_TOKENS);
  const INVEST_UI_VAULTS = readBoolean(SETTINGS.INVEST_UI_VAULTS);
  const MIN_SECONDS_SINCE_LAST_INVEST = readNumber(SETTINGS.MIN_SECONDS_SINCE_LAST_INVEST);

  const DEFAULT_SWAP_SLIPPAGE_BPS = readNumber(SETTINGS.DEFAULT_SWAP_SLIPPAGE_BPS);
  const DEFAULT_PRICE_SLIPPAGE_BPS = readNumber(SETTINGS.DEFAULT_PRICE_SLIPPAGE_BPS);
  return {
    ...shared,
    allocationConfigPath: readPath(SETTINGS.ALLOCATION_CONFIG_PATH),
    investVaultKeyOverrides,
    investVaultOwners,
    investMinSlotBypassVaults,
    investUIVaults: INVEST_UI_VAULTS,
    loopIntervalMs: LOOP_INTERVAL_MS,
    minInvestTokens: MIN_INVEST_TOKENS,
    minSecondsSinceLastInvest: MIN_SECONDS_SINCE_LAST_INVEST,
    defaultSwapSlippageBps: DEFAULT_SWAP_SLIPPAGE_BPS,
    defaultPriceSlippageBps: DEFAULT_PRICE_SLIPPAGE_BPS,
  };
}

export function readAllocationLoopConfig(): AllocationLoopConfig {
  const shared = readSharedConfig();
  const VERBOSE = readBoolean(SETTINGS.VERBOSE);
  const ALLOCATION_CONFIG_PATH = readPath(SETTINGS.ALLOCATION_CONFIG_PATH);
  const DANGER_PASS_INTERVAL_SECONDS = readNumber(SETTINGS.DANGER_PASS_INTERVAL_SECONDS);
  const REINVEST_COOLDOWN_SECONDS = readNumber(SETTINGS.REINVEST_COOLDOWN_SECONDS);
  const MAX_STALE_PRICE_DURATION_SECONDS = readNumber(SETTINGS.MAX_STALE_PRICE_DURATION_SECONDS);
  const ALLOCATION_DRY_RUN = readBoolean(SETTINGS.ALLOCATION_DRY_RUN);
  const GRID_SEARCH_RESOLUTION = readNumber(SETTINGS.GRID_SEARCH_RESOLUTION);
  const GRID_SEARCH_MAX_CANDIDATES = readNumber(SETTINGS.GRID_SEARCH_MAX_CANDIDATES);
  const GRID_SEARCH_MAX_MS = readNumber(SETTINGS.GRID_SEARCH_MAX_MS);
  return {
    ...shared,
    allocationConfigPath: ALLOCATION_CONFIG_PATH,
    verbose: VERBOSE,
    allocationDryRun: ALLOCATION_DRY_RUN,
    gridSearchResolution: GRID_SEARCH_RESOLUTION,
    gridSearchMaxCandidates: GRID_SEARCH_MAX_CANDIDATES,
    gridSearchMaxMs: GRID_SEARCH_MAX_MS,
    maxStalePriceDurationSeconds: MAX_STALE_PRICE_DURATION_SECONDS,
    dangerPassIntervalSeconds: DANGER_PASS_INTERVAL_SECONDS,
    reinvestCooldownSeconds: REINVEST_COOLDOWN_SECONDS,
  };
}

function getOrDerivePriorityFeePercentile(percentileString: string | undefined): number | undefined {
  // See `PRIORITY_FEE_PERCENTILE` env's doc for contract - we want to allow either a number or a boolean here (to not
  // break any existing scripts etc.):
  switch (percentileString) {
    case undefined:
      return SETTINGS.PRIORITY_FEE_PERCENTILE.default;
    case 'true':
      return SETTINGS.PRIORITY_FEE_PERCENTILE.default;
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
function getRpcMulticastEndpoints(): Array<MulticastTransportConfig> {
  return [
    ...readJson<Array<MulticastTransportConfig>>(SETTINGS.RPC_MULTICAST_ENDPOINTS),
    ...[...readPrefix(SETTINGS['RPC_MULTICAST_ENDPOINT_*']).entries()].map(([keySuffix, value]) => {
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
