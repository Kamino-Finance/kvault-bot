import { DEFAULT_BLACKLIST_PATH } from '../libs/utils/consts.js';
import {
  defineSettings,
  nonNegativeFiniteNumber,
  nonNegativeSafeInteger,
  positiveSafeInteger,
  SettingSpec,
} from './schema.js';

/** Basis points of a slippage: an integer below 100%. */
const slippageBps = (value: number) =>
  Number.isSafeInteger(value) && value >= 0 && value < 10_000 ? undefined : 'must be a safe integer in [0, 10000)';

/**
 * The bot's environment settings, in documentation order. The env loader reads them through the typed readers in
 * `schema.ts`; `yarn config:generate` renders `.env.example` and the README tables from them.
 */
export const SETTINGS = defineSettings({
  // RPC
  RPC_ENDPOINT: {
    name: 'RPC_ENDPOINT',
    group: 'RPC',
    kind: 'url',
    starter: '${RPC}',
    usedBy: ['invest', 'allocation', 'danger'],
    description:
      'Legacy mode: the primary RPC URL. Legacy mode needs at least one of RPC_ENDPOINT, RPC_ENDPOINTS or RPC_ENDPOINT_*.',
  },
  WS_ENDPOINT: {
    name: 'WS_ENDPOINT',
    group: 'RPC',
    kind: 'url',
    starter: '${RPC_WS}',
    usedBy: ['invest', 'allocation'],
    description: 'WebSocket RPC URL. When unset or blank, the bot derives it from the read RPC URL (https -> wss).',
  },
  RPC_ENDPOINTS: {
    name: 'RPC_ENDPOINTS',
    group: 'RPC',
    kind: 'json',
    default: '[]',
    usedBy: ['invest', 'allocation', 'danger'],
    description:
      'Legacy mode: fallback RPCs as a JSON array of { url, dedicatedWriteUrl?, name?, feePercentileSupportOverride? } objects.',
  },
  'RPC_ENDPOINT_*': {
    name: 'RPC_ENDPOINT_*',
    group: 'RPC',
    kind: 'custom',
    usedBy: ['invest', 'allocation', 'danger'],
    description:
      'Legacy mode: one fallback RPC URL per variable, ordered by suffix. A suffix that contains FEES_TRITON_STYLE, FEES_HELIUS_STYLE or FEES_NONE sets the fee API support.',
  },
  USE_RPC_CONFIG_FILE: {
    name: 'USE_RPC_CONFIG_FILE',
    group: 'RPC',
    kind: 'boolean',
    default: false,
    usedBy: ['invest', 'allocation', 'danger'],
    description:
      'Use indexed mode (RPC_READ_<n>, RPC_SEND_<n>, RPC_PRIORITY_FEE_<n>_TRITON/HELIUS) instead of the legacy RPC settings.',
  },
  'RPC_READ_*': {
    name: 'RPC_READ_*',
    group: 'RPC',
    kind: 'custom',
    usedBy: ['invest', 'allocation', 'danger'],
    description:
      'Indexed mode: read RPC URLs as RPC_READ_<n>, in numeric fallback order. At least one is required when USE_RPC_CONFIG_FILE=true.',
  },
  'RPC_SEND_*': {
    name: 'RPC_SEND_*',
    group: 'RPC',
    kind: 'custom',
    usedBy: ['invest', 'allocation', 'danger'],
    description: 'Indexed mode: optional write RPC URL as RPC_SEND_<n>, paired with RPC_READ_<n>.',
  },
  'RPC_PRIORITY_FEE_*': {
    name: 'RPC_PRIORITY_FEE_*',
    group: 'RPC',
    kind: 'custom',
    usedBy: ['invest', 'allocation', 'danger'],
    description:
      'Indexed mode: RPC URLs with a priority fee API, as RPC_PRIORITY_FEE_<n>_TRITON or RPC_PRIORITY_FEE_<n>_HELIUS.',
  },
  RPC_MULTICAST_ENDPOINTS: {
    name: 'RPC_MULTICAST_ENDPOINTS',
    group: 'RPC',
    kind: 'json',
    default: '[]',
    usedBy: ['tx'],
    description:
      'Extra endpoints that also receive every sent transaction, as a JSON array of { name, connection } objects.',
  },
  'RPC_MULTICAST_ENDPOINT_*': {
    name: 'RPC_MULTICAST_ENDPOINT_*',
    group: 'RPC',
    kind: 'custom',
    usedBy: ['tx'],
    description:
      'One multicast endpoint URL per variable, named after the suffix in kebab case (RPC_MULTICAST_ENDPOINT_IRONFORGE -> ironforge).',
  },
  RPC_REQUEST_TIMEOUT_MS: {
    name: 'RPC_REQUEST_TIMEOUT_MS',
    starter: 120_000,
    group: 'RPC',
    kind: 'number',
    default: 2 * 60_000,
    usedBy: ['process', 'invest', 'allocation', 'danger', 'tx'],
    description: 'Timeout in milliseconds for one RPC request. Must be a positive safe integer.',
    validate: positiveSafeInteger,
  },
  EXTERNAL_REQUEST_TIMEOUT_MS: {
    name: 'EXTERNAL_REQUEST_TIMEOUT_MS',
    starter: 30_000,
    group: 'RPC',
    kind: 'number',
    default: 30_000,
    usedBy: ['invest', 'allocation', 'danger', 'tx'],
    description:
      'Timeout in milliseconds for one HTTP request to an external API, such as KSwap or the token flags feed. Must be a positive safe integer.',
    validate: positiveSafeInteger,
  },

  // Transactions
  SIMULATE: {
    name: 'SIMULATE',
    starter: true,
    group: 'Transactions',
    kind: 'boolean',
    default: true,
    usedBy: ['tx'],
    description: 'Simulate transactions to find the approximate CU consumed before sending.',
  },
  SPAM: {
    name: 'SPAM',
    starter: false,
    group: 'Transactions',
    kind: 'boolean',
    default: false,
    usedBy: ['tx'],
    description: 'Send the same transaction multiple times.',
  },
  MULTICAST_JITO: {
    name: 'MULTICAST_JITO',
    starter: false,
    group: 'Transactions',
    kind: 'boolean',
    default: false,
    usedBy: ['tx'],
    description: 'Multicast transactions to Jito validators with a tip instruction.',
  },
  PRIORITY_FEE_PERCENTILE: {
    name: 'PRIORITY_FEE_PERCENTILE',
    starter: 50,
    group: 'Transactions',
    kind: 'custom',
    default: 50,
    usedBy: ['tx'],
    description:
      'Priority fee percentile: a number in [0, 100], true (the 50th percentile) or false (disabled). Needs an RPC with a percentile fee API.',
  },
  PRIORITY_MICRO_LAMPORTS_PER_CU_DEFAULT: {
    name: 'PRIORITY_MICRO_LAMPORTS_PER_CU_DEFAULT',
    starter: 5_000,
    group: 'Transactions',
    kind: 'number',
    default: 5_000,
    usedBy: ['tx'],
    description: 'Fallback priority fee in micro-lamports per CU. Must be between the MIN and MAX bounds.',
    validate: nonNegativeSafeInteger,
  },
  PRIORITY_MICRO_LAMPORTS_PER_CU_MIN: {
    name: 'PRIORITY_MICRO_LAMPORTS_PER_CU_MIN',
    starter: 1,
    group: 'Transactions',
    kind: 'number',
    default: 1,
    usedBy: ['tx'],
    description: 'Lower bound of the priority fee in micro-lamports per CU.',
    validate: nonNegativeSafeInteger,
  },
  PRIORITY_MICRO_LAMPORTS_PER_CU_MAX: {
    name: 'PRIORITY_MICRO_LAMPORTS_PER_CU_MAX',
    starter: 4_000_000,
    group: 'Transactions',
    kind: 'number',
    default: 4_000_000,
    usedBy: ['tx'],
    description: 'Upper bound of the priority fee in micro-lamports per CU.',
    validate: nonNegativeSafeInteger,
  },

  // Modes
  INVEST_LOOP: {
    name: 'INVEST_LOOP',
    starter: true,
    group: 'Modes',
    kind: 'boolean',
    default: false,
    usedBy: ['process'],
    description: 'Run the invest loop.',
  },
  ALLOCATION_REBALANCE_LOOP: {
    name: 'ALLOCATION_REBALANCE_LOOP',
    starter: false,
    group: 'Modes',
    kind: 'boolean',
    default: false,
    usedBy: ['process'],
    description: 'Run the allocation-rebalance loop, which includes danger detection, in a worker thread.',
  },

  // Wallet
  INVESTOR_SECRET_PATH: {
    name: 'INVESTOR_SECRET_PATH',
    starter: '../investor.json',
    group: 'Wallet',
    kind: 'path',
    default: '/run/secrets/investor_keypair',
    usedBy: ['invest'],
    description:
      'Keypair file that signs the permissionless invest transactions. Any keypair with some SOL can do this.',
  },
  ALLOCATION_ADMIN_SECRET_PATH: {
    name: 'ALLOCATION_ADMIN_SECRET_PATH',
    starter: '../allocation_admin.json',
    group: 'Wallet',
    kind: 'path',
    default: '/run/secrets/allocation_admin',
    usedBy: ['allocation'],
    description: 'Keypair file of the vaults allocation admin, which signs allocation updates.',
  },

  // Invest
  INVEST_VAULTS: {
    name: 'INVEST_VAULTS',
    group: 'Invest',
    kind: 'addressList',
    default: '',
    usedBy: ['invest'],
    description:
      'Vault addresses to invest, separated by commas or whitespace. An address that holds no vault is skipped and logged. With INVEST_VAULTS, INVEST_OWNERS and the UI list all empty, every vault on chain is invested.',
  },
  INVEST_OWNERS: {
    name: 'INVEST_OWNERS',
    group: 'Invest',
    kind: 'addressList',
    default: '',
    usedBy: ['invest'],
    description:
      'Vault owner addresses, separated by commas or whitespace. The vaults of these owners are invested too.',
  },
  INVEST_UI_VAULTS: {
    name: 'INVEST_UI_VAULTS',
    starter: true,
    group: 'Invest',
    kind: 'boolean',
    default: false,
    usedBy: ['invest'],
    description: 'Also invest the vaults that the Kamino UI lists.',
  },
  INVEST_MIN_SLOT_BYPASS_VAULTS: {
    name: 'INVEST_MIN_SLOT_BYPASS_VAULTS',
    group: 'Invest',
    kind: 'addressList',
    default: '',
    usedBy: ['invest'],
    description: 'Vaults exempt from the MIN_SECONDS_SINCE_LAST_INVEST gate, separated by commas or whitespace.',
  },

  // Allocation rebalance
  ALLOCATION_CONFIG_PATH: {
    name: 'ALLOCATION_CONFIG_PATH',
    starter: '../allocation_config.json',
    group: 'Allocation rebalance',
    kind: 'path',
    default: '',
    usedBy: ['allocation', 'invest'],
    description:
      'Path to the allocation config JSON file. Set it when the allocation-rebalance loop runs. Separate investing processes must use the same file to enforce enabled utilization caps. The invest loop rereads it before normal invests.',
  },
  GRID_SEARCH_RESOLUTION: {
    name: 'GRID_SEARCH_RESOLUTION',
    starter: 0.01,
    group: 'Allocation rebalance',
    kind: 'number',
    default: 0.01,
    usedBy: ['allocation'],
    description:
      'Allocation granularity of the MAX_YIELD strategy family as a fraction of AUM, in (0, 1]. A lower value finds better yield but uses exponentially more resources.',
    validate: (value) => (value > 0 && value <= 1 ? undefined : 'must be in (0, 1]'),
  },
  GRID_SEARCH_MAX_CANDIDATES: {
    name: 'GRID_SEARCH_MAX_CANDIDATES',
    group: 'Allocation rebalance',
    kind: 'number',
    default: 5000000,
    usedBy: ['allocation'],
    description:
      'Maximum candidates one MAX_YIELD-family grid search counts for one vault, across all phases. Each generated point and each evaluation counts once, and a point generated in two refinement regions counts twice. When the search reaches it, the vault keeps its current allocation for that pass. A positive integer.',
    validate: positiveSafeInteger,
  },
  GRID_SEARCH_MAX_MS: {
    name: 'GRID_SEARCH_MAX_MS',
    group: 'Allocation rebalance',
    kind: 'number',
    default: 300000,
    usedBy: ['allocation'],
    description:
      'Maximum wall-clock time in milliseconds of one MAX_YIELD-family grid search for one vault. When the search reaches it, the vault keeps its current allocation for that pass. A positive integer.',
    validate: positiveSafeInteger,
  },
  ALLOCATION_DRY_RUN: {
    name: 'ALLOCATION_DRY_RUN',
    starter: true,
    group: 'Allocation rebalance',
    kind: 'boolean',
    default: false,
    usedBy: ['allocation'],
    description:
      'The allocation loop computes and logs allocations but sends no transactions; the invest loop still sends. When false, the allocation config sets dry run per entry or vault.',
  },

  // Danger detection
  DANGER_BLACKLIST_PATH: {
    name: 'DANGER_BLACKLIST_PATH',
    group: 'Danger detection',
    kind: 'path',
    default: DEFAULT_BLACKLIST_PATH,
    starter: '../danger_blacklist.json',
    required: 'production',
    usedBy: ['invest', 'danger', 'cli'],
    description:
      'Path to the danger-detection blacklist file, on a persistent volume; its directory must exist. The invest loop reads it to skip vaults with a pending evacuation or blacklisted exposure. Outside production an unset value falls back to an ephemeral dev-only file.',
  },
  MARKET_PRICE_MAX_AGE_SECONDS: {
    name: 'MARKET_PRICE_MAX_AGE_SECONDS',
    starter: 300,
    group: 'Danger detection',
    kind: 'number',
    default: 300,
    usedBy: ['invest', 'danger'],
    description:
      'Age limit in seconds of a KSwap market price. Danger checks freeze the current allocation pass, and the invest loop skips its crank-funding swaps, when a price is older.',
    validate: (value) => (value > 0 ? undefined : 'must be greater than 0'),
  },
  MAX_STALE_PRICE_DURATION_SECONDS: {
    name: 'MAX_STALE_PRICE_DURATION_SECONDS',
    group: 'Danger detection',
    kind: 'number',
    default: 3600,
    usedBy: ['danger'],
    description:
      'Scope price age limit L, in seconds. A zero or near-zero price is as old as the longer of its publish age and the time it has read zero. Safety score: 0.4 past L, 0.2 past 2L and 0 past 4L. A positive integer.',
    validate: positiveSafeInteger,
  },
  REINVEST_COOLDOWN_SECONDS: {
    name: 'REINVEST_COOLDOWN_SECONDS',
    group: 'Danger detection',
    kind: 'number',
    default: 2700,
    usedBy: ['allocation', 'danger'],
    description:
      'Seconds after a transient danger pull-out during which the reserve gets no new funds in any vault: no new weight and no deposit. In memory: a restart clears it. A positive integer.',
    validate: positiveSafeInteger,
  },
  DANGER_PASS_INTERVAL_SECONDS: {
    name: 'DANGER_PASS_INTERVAL_SECONDS',
    group: 'Danger detection',
    kind: 'number',
    default: 300,
    usedBy: ['allocation', 'danger'],
    description:
      'Maximum seconds the allocation loop sleeps between two passes, each of which starts with a danger pass. The loop sleeps for the smallest of this and every rebalanceFrequencySeconds; each vault still rebalances at its own frequency. The time a pass takes adds to the gap. A positive integer.',
    validate: positiveSafeInteger,
  },
  KAMINO_TOKEN_FLAGS_URL: {
    name: 'KAMINO_TOKEN_FLAGS_URL',
    group: 'Danger detection',
    kind: 'url',
    default: 'https://tokens.kamino.finance/tokens-flags.json',
    usedBy: ['danger'],
    description: 'Kamino token flags feed that tells which tokens are stablecoins or LSTs.',
  },

  // KSwap
  KSWAP_API_BASE_URL: {
    name: 'KSWAP_API_BASE_URL',
    group: 'KSwap',
    kind: 'url',
    default: 'https://api.kamino.finance/kswap',
    usedBy: ['invest', 'allocation', 'danger'],
    description: 'Base URL of the KSwap API, for swap routes and market prices.',
  },
  KSWAP_API_KEY: {
    name: 'KSWAP_API_KEY',
    group: 'KSwap',
    kind: 'string',
    usedBy: ['invest', 'allocation', 'danger'],
    description: 'Optional KSwap API key, sent as the x-api-key header.',
  },
  DEFAULT_SWAP_SLIPPAGE_BPS: {
    name: 'DEFAULT_SWAP_SLIPPAGE_BPS',
    group: 'KSwap',
    kind: 'number',
    default: 100,
    usedBy: ['invest'],
    description: 'Swap slippage tolerance in basis points, a safe integer in [0, 10000).',
    validate: slippageBps,
  },
  DEFAULT_PRICE_SLIPPAGE_BPS: {
    name: 'DEFAULT_PRICE_SLIPPAGE_BPS',
    group: 'KSwap',
    kind: 'number',
    default: 150,
    usedBy: ['invest'],
    description: 'Independent reference-price tolerance in basis points, checked before signing a swap.',
    validate: slippageBps,
  },

  // Looping
  LOOP_INTERVAL_MS: {
    name: 'LOOP_INTERVAL_MS',
    starter: 10000,
    group: 'Looping',
    kind: 'number',
    default: 10 * 60_000,
    usedBy: ['invest'],
    description:
      'Sleep in milliseconds between two invest passes. When a vault is invested is set by MIN_SECONDS_SINCE_LAST_INVEST. Must be a positive safe integer.',
    validate: positiveSafeInteger,
  },
  LOOP_HEARTBEAT_TIMEOUT_MS: {
    name: 'LOOP_HEARTBEAT_TIMEOUT_MS',
    group: 'Looping',
    kind: 'number',
    starter: 360000,
    usedBy: ['process'],
    description:
      'The health server reports not ready when a loop sends no heartbeat for this many milliseconds. Defaults to 3 x RPC_REQUEST_TIMEOUT_MS.',
    validate: positiveSafeInteger,
  },
  MIN_INVEST_TOKENS: {
    name: 'MIN_INVEST_TOKENS',
    starter: 100,
    group: 'Looping',
    kind: 'number',
    default: 10,
    usedBy: ['invest'],
    description:
      'A vault is invested only when its move, the larger of its deposits and its withdrawals, exceeds this many tokens. One count for every mint.',
    validate: nonNegativeFiniteNumber,
  },
  MIN_SECONDS_SINCE_LAST_INVEST: {
    name: 'MIN_SECONDS_SINCE_LAST_INVEST',
    group: 'Looping',
    kind: 'number',
    default: 1200,
    usedBy: ['invest'],
    description:
      "Minimum seconds since a vault's last invest before it is invested again; converted to slots at run time.",
    validate: nonNegativeSafeInteger,
  },
  RESERVE_INVEST_COOLDOWN_MS: {
    name: 'RESERVE_INVEST_COOLDOWN_MS',
    group: 'Looping',
    kind: 'number',
    default: 10 * 60_000,
    usedBy: ['invest', 'allocation'],
    description:
      "A reserve whose invest or disinvest instruction the programs reject for a vault is dropped from that vault's invests for this many milliseconds. 0 disables the cooldown.",
    validate: nonNegativeSafeInteger,
  },
  VAULT_RESERVES_MAX_UNIQUE_RESERVES_PER_BATCH: {
    name: 'VAULT_RESERVES_MAX_UNIQUE_RESERVES_PER_BATCH',
    group: 'Looping',
    kind: 'number',
    default: 50,
    usedBy: ['invest', 'allocation'],
    description: 'Maximum number of unique reserves loaded in one batch of vault reserves. Must be greater than 0.',
    validate: positiveSafeInteger,
  },

  // Programs
  KLEND_PROGRAM_ID: {
    name: 'KLEND_PROGRAM_ID',
    group: 'Programs',
    kind: 'address',
    // Literal so the registry does not load the SDK; testConfigSchema.test.ts pins it to the SDK's PROGRAM_ID.
    default: 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD',
    starter: 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD',
    usedBy: ['invest', 'allocation', 'danger'],
    description: 'Kamino Lend program address.',
  },
  KVAULTS_PROGRAM_ID: {
    name: 'KVAULTS_PROGRAM_ID',
    group: 'Programs',
    kind: 'address',
    // Literal so the registry does not load the SDK; testConfigSchema.test.ts pins it to the SDK's KVAULTS_PROGRAM_ID.
    default: 'KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd',
    starter: 'KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd',
    usedBy: ['invest', 'allocation', 'danger'],
    description: 'Kamino Vaults program address.',
  },

  // General
  CLUSTER: {
    name: 'CLUSTER',
    starter: 'mainnet-beta',
    group: 'General',
    kind: 'string',
    default: 'mainnet-beta',
    usedBy: ['process'],
    description: 'Solana cluster. The process environment value also selects the default PROFILE.',
  },
  PROFILE: {
    name: 'PROFILE',
    group: 'General',
    kind: 'string',
    usedBy: ['process'],
    description: 'Selects the .env.<PROFILE> file to load, so set it in the shell. Defaults to CLUSTER.',
  },
  SERVER: {
    name: 'SERVER',
    group: 'General',
    kind: 'boolean',
    default: true,
    usedBy: ['process'],
    description:
      "Run the health server, which reports ready while every enabled loop sends heartbeats and the allocation loop's danger passes are not failing.",
  },
  SERVER_PORT: {
    name: 'SERVER_PORT',
    group: 'General',
    kind: 'number',
    default: 8080,
    usedBy: ['process'],
    description: 'Health server port, an integer in [1, 65535]. An empty value uses the default.',
  },
  VERBOSE: {
    name: 'VERBOSE',
    group: 'General',
    kind: 'boolean',
    default: false,
    usedBy: ['allocation'],
    description: 'Log the details of each allocation computation.',
  },

  // Logging
  LOG_LEVEL: {
    name: 'LOG_LEVEL',
    group: 'Logging',
    kind: 'string',
    default: 'info',
    usedBy: ['logger'],
    description: 'Winston log level. The logger package reads it directly.',
  },
});

/** All settings in declaration order. */
export function settingsList(): SettingSpec[] {
  return Object.values(SETTINGS);
}
