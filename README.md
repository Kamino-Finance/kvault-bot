# kvault-bot

This bot invests Kamino Earn lending vaults and changes their reserve allocation weights.
Its allocation loop checks reserve and market collateral danger before each pass.

| Loop       | Flag                        | Signer                         | Action                                                                                  |
| ---------- | --------------------------- | ------------------------------ | --------------------------------------------------------------------------------------- |
| Invest     | `INVEST_LOOP`               | `INVESTOR_SECRET_PATH`         | Runs permissionless invest instructions using the vault's on-chain weights.             |
| Allocation | `ALLOCATION_REBALANCE_LOOP` | `ALLOCATION_ADMIN_SECRET_PATH` | Checks danger, updates weights, applies deposit freezes, and invests configured vaults. |

The loops have separate switches. Danger detection runs only with the allocation loop.
The invest loop alone does not detect new danger.

## Prerequisites

Use Node.js with Yarn Classic `1.22.22`, as specified by `packageManager`.
The source deployment uses Node.js `26.12.1`.
Install development dependencies for the TypeScript build and the source-based start command.

Supply a Solana RPC endpoint for the selected cluster.
The allocation loop also needs access to KSwap market prices and the Kamino token-flags feed.
Managed lookup tables use `https://api.kamino.finance/luts/managed`.
Use the program addresses for your deployment. Changing `CLUSTER` does not change these addresses.

Both signers need SOL for transaction fees and account creation.
The invest signer also needs SOL for token buffers that the bot funds through KSwap or SOL wrapping.
Keypair files must contain a JSON array of 64 secret-key bytes.

## Authority

Use each configured vault's `allocation_admin` for the allocation loop.
The vault admin can also sign, but grants broader authority than the bot needs.
Keep the vault admin key separate from the bot's runtime key.

Before operation, use the vault admin to add every reserve that the strategy can use.
The bot updates existing allocation entries. It does not add new reserves.
Check the vault's reserve whitelists, caps, minimum amounts, and invest delays before operation.
The program can reject a transaction even when the bot's off-chain checks pass.

## Quick start

Run these commands from this repository's root directory.
Use the repository URL that contains this checkout.

1. Install dependencies and compile the three workspaces.

   ```bash
   yarn install --frozen-lockfile --production=false
   yarn build
   ```

2. Create a profile and allocation file.

   ```bash
   cp .env.example .env.mainnet-beta
   cp allocation_config_example.json allocation_config.json
   ```

   Edit both files before operation. Replace the allocation example's vault and reserve addresses.
   Remove example entries that you do not use. Address validation does not confirm that a vault exists or belongs to your deployment.
   Set `RPC_ENDPOINT` to your HTTP(S) RPC URL.
   Set absolute paths for `ALLOCATION_CONFIG_PATH`, `DANGER_BLACKLIST_PATH`, and the keypair files.
   Check the loop flags. The example enables the invest loop and the public UI vault list.

3. Create the safety file in its persistent directory.

   ```bash
   yarn cli danger init --path "$PWD/danger_blacklist.json"
   ```

   Use this absolute path as `DANGER_BLACKLIST_PATH` for both loops.
   For production, place the file on persistent storage and set `NODE_ENV=production`.
   Create its parent directory before startup.

4. Start allocation observation with the invest loop disabled.

   ```bash
   PROFILE=mainnet-beta INVEST_LOOP=false ALLOCATION_REBALANCE_LOOP=true ALLOCATION_DRY_RUN=true yarn start
   ```

   This command needs the allocation admin keypair, a valid allocation config, and network access.
   Check the logs for the intended vault set, strategy, exclusions, and target weights.
   `ALLOCATION_DRY_RUN` affects only the allocation loop. The invest loop can still send transactions when enabled.

5. After the checks, set the intended loop flags and dry-run values in the profile.

   ```bash
   PROFILE=mainnet-beta yarn start
   ```

   The allocation loop invests after each successful due rebalance, including when weights do not change.
   An allocation-only deployment does not require the independent invest loop.

No option provides a dry-run for the independent invest loop.
`yarn dry-run` selects `.env.local` and sets allocation dry-run only.
It can send invest transactions if that profile enables `INVEST_LOOP`.

## Profiles and paths

`yarn start` and `yarn cli` run from `investing-bot/`.
Relative config paths and CLI `--path` values resolve from that directory.
Use absolute paths in deployments.
Keypair loading also checks the parent directory as a fallback.

For `yarn start`, shell-level `PROFILE` selects `../.env.<PROFILE>`.
When `PROFILE` is absent, shell-level `CLUSTER` selects the profile. The default is `mainnet-beta`.
Existing process environment values take precedence over profile values.
The loader expands `${VAR}` references. A missing profile uses the process environment.

The CLI does not load profile files.
Pass `--path` explicitly, or export `DANGER_BLACKLIST_PATH` in the shell before each danger command.
Set `NODE_OPTIONS` in the shell. Node reads it before the profile loads.

## Commands

| Command                                                            | Purpose                                                             |
| ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `yarn build`                                                       | Compiles `investing-bot`, `tx`, and `logger`.                       |
| `yarn start`                                                       | Runs bot sources through ts-node. Build `tx` and `logger` first.    |
| `yarn cli print-rebalance-strategies`                              | Lists the registered strategies without starting the bot.           |
| `yarn cli danger list --path /absolute/path/danger_blacklist.json` | Prints blacklists, pending evacuations, and deposit freeze records. |
| `yarn config:generate` / `yarn config:check`                       | Generates or checks `.env.example` and the marked README tables.    |

This repository contains source, package manifests, the lockfile, example files, and lint configuration.
Tests, CI configuration, validator fixtures, and deployment files are not included.
The test, localnet, and validator scripts require these additional files.
Use `yarn lint`, `yarn build`, and `yarn config:check` for local checks.

## Invest behavior

The vault set combines explicit `INVEST_VAULTS`, vaults from `INVEST_OWNERS`, and the optional public UI list.
With all three selectors empty, the bot selects every on-chain vault.
Set explicit selectors before a live run.

Each pass creates missing token accounts and funds small token buffers for rounding costs.
Funding swaps require fresh reference prices and satisfy both route and reference-price slippage limits.
A vault must pass the configured token movement threshold and the off-chain and on-chain invest delays.
`MIN_INVEST_TOKENS` uses whole tokens and compares the larger of projected deposits and withdrawals.
`INVEST_MIN_SLOT_BYPASS_VAULTS` bypasses only the configured off-chain delay.

The invest loop skips vaults with pending evacuations or blacklisted exposure.
In the same process, it also blocks deposits into the allocation loop's excluded reserves.
Reserve instructions that fail with an attributable program error enter an in-memory cooldown.
Other reserves can continue when the failed instruction can be isolated safely.

Separate investing processes must read the same safety file.
They must also use the same `ALLOCATION_CONFIG_PATH` to enforce enabled utilization limits before normal invests.
Restart the allocation loop after allocation config changes. The independent invest loop rereads that file before normal invests.

## Rebalance behavior

Each allocation pass checks danger for all configured vaults before normal rebalances.
It waits no longer than `DANGER_PASS_INTERVAL_SECONDS` between passes, subject to shorter configured frequencies and manager refreshes.
The pass duration adds to this gap. Each vault retains its own rebalance frequency, including in dry-run.
A restart resets the rebalance schedule and in-memory observations.

All normal weight updates for one vault use one atomic transaction.
If they exceed the Solana transaction size limit, the bot sends none and skips that vault's invest.
After confirmed updates, the bot waits five seconds, reloads state, and invests.
A failed allocation send does not authorize a normal invest.

Strategies use healthy reserves. Blacklisted reserves receive zero weight.
Reserves excluded from new funds retain their weights and receive no deposits.
The bot can temporarily lower token caps to enforce these deposit freezes, then restore the recorded caps after recovery.
It preserves cToken caps. See [configuration details](docs/configuration.md) for weight, capacity, and drift behavior.

## Danger detection

Each trigger returns a safety score between zero and one. Scores multiply.
A reserve triggers evacuation when its combined score is strictly below the vault entry's risk threshold.
Thresholds are `0.5` for `PARANOID`, `0.3` for `SENSIBLE`, and `0.1` for `YOLO`.

The checks include mint supply, exchange rate, yield, liquidity, oracle divergence, Scope freshness, depeg, utilization, and depositor dominance.
Market collateral also contributes infinite-mint and stale or zero Scope price checks.
The [danger catalog](investing-bot/src/danger/danger_triggers_catalog.md) defines the scoring curves, exclusions, responses, and limits.

Emergency responses zero the dangerous weights and attempt withdrawals.
They can broadcast despite failed simulation. After three consecutive attributable failed broadcasts for a vault and reserve,
that reserve must pass simulation before another forced broadcast. Restarting clears this fee limit.
A failed or timed-out danger pass skips normal allocation work. Repeated danger failures also make readiness fail.

## Safety state and recovery

`DANGER_BLACKLIST_PATH` stores permanent blacklists, pending evacuations, and original caps for deposit freezes.
Use the same persistent file for both loops and operator commands.
The store uses locked updates and atomic file replacement.
A missing or whitespace-only file means empty safety state. Corrupt state or a missing parent directory causes an error.
Do not replace a live safety file with an empty template.

Catastrophic events create permanent reserve blacklists.
Transient danger starts a reinvest cooldown, which defaults to 2,700 seconds.
Cooldowns, trigger baselines, zero-price clocks, and failure counters reside in memory and reset on process restart.
Pending evacuations persist until the vault holds no weight and no tokens in the affected reserve.
Deposit freeze records persist until recovery restores the cap, unless an operator changed the cap.

1. Inspect the file with `yarn cli danger list --path /absolute/path/danger_blacklist.json`.
2. Check the cause, current exposure, on-chain weights, caps, and failed transaction logs.
3. Correct the underlying problem before removing a permanent blacklist entry.

   ```bash
   yarn cli danger clear-reserve <reserveAddress> --path /absolute/path/danger_blacklist.json
   ```

The clear command sends no transaction. It removes only the permanent blacklist entry.
It preserves pending evacuations and deposit freeze records.
`clear-all` removes every permanent blacklist entry and has the same limits.
Do not delete freeze records as a recovery method. They hold the cap values needed for restoration.

## Process health

With `SERVER=true`, the default health server uses port `8080` and exposes `/health`, `/live`, and `/ready`.
Readiness requires enabled-loop heartbeats and successful danger monitoring.
Use `/ready` for the deployment readiness probe.

The allocation loop runs in a supervised worker with a 4 GB old-generation heap limit.
Worker restart attempts are limited. A permanently unhealthy worker needs a process restart.
`SIGINT` and `SIGTERM` request shutdown, stop the worker, and then stop the health server.
A hard exit follows after 20 seconds if shutdown does not finish.
Production logs use JSON. `LOG_LEVEL` controls their level, and `VERBOSE=true` adds allocation detail.

## Lookup tables

The bot combines the vault's on-chain lookup table with managed tables from the Kamino API.
Managed API or managed-account read failures retain the available on-chain table.
An on-chain table read failure fails the vault operation.

After a send fails, the bot checks table metadata for deactivation.
Verified deactivating tables are excluded for later attempts, and managed addresses are refreshed.
This recovery does not resend the failed transaction. An unknown transaction outcome can still need operator investigation.

## Strategies

The strategy registry generates this table.
Detailed constraints and drift behavior are in [configuration details](docs/configuration.md#strategies).

<!-- prettier-ignore-start -->

<!-- strategies:start -->
| Strategy | What it does |
| --- | --- |
| `EQUAL` | Equal weight to every reserve. |
| `MAX_YIELD` | Coarse-to-fine grid search over the full allocation space to maximize vault APY; applies the optimum immediately. |
| `MAX_YIELD_STABLE` | Minimizes the spread between simulated reserve yields. APY is reported, but is not currently a tie-breaker in the optimizer. |
| `MAX_YIELD_WITH_FIXED_RESERVES` | `MAX_YIELD` with a minimum combined search allocation (`reservesAllocationPercentageBPS`) across a named set of reserves (`fixedReserves`); emitted weights remain subject to runtime deposit and withdrawal constraints. |
| `MAX_YIELD_DRIPPING` | Computes the `MAX_YIELD` target — optionally utilization-bounded (opt-in, see `enforceUtilizationCap`) — and moves a configurable fraction of the current-to-target gap per iteration (`drippingRatePercent`, default 20%) before applying runtime constraints. See the exact behavior below. |
| `FIXED_WEIGHTS` | Explicit per-reserve weights from config (`fixedReserves` given as `{ reserve, weight }` objects), read as shares: the bot writes them on the vault's current weight total, so the share the vault leaves unallocated stays. `fixedReserves` must list every healthy reserve of the vault. When one is missing, the bot logs an error and keeps the vault's current weights; it still zeroes blacklisted reserves. |
| `RANDOM` | Random weights — testing/experimentation only. |
| `UNCHANGED` | No-op; recomputes the current APY without changing the allocation. |
<!-- strategies:end -->

<!-- prettier-ignore-end -->

## Allocation fields

The file at `ALLOCATION_CONFIG_PATH` contains `{ "allocationsConfig": [ ... ] }`.
Each entry assigns a strategy to vault strings or vault objects.
The registry generates these field tables. Defaults apply when a field is absent.

<!-- prettier-ignore-start -->

<!-- allocation-fields:start -->
**Entry fields**

| Field | Required | Default | Applies to | Meaning |
| --- | --- | --- | --- | --- |
| `strategy` | yes | — | all | One of the strategies above; applied to every vault in the entry. |
| `vaults` | yes | — | all | Array of vault address strings, and/or objects for per-vault settings (see below). An entry with an empty array is ignored, with a warning. |
| `rebalanceFrequencySeconds` | no | `3600` | all | Minimum seconds between rebalances. Set at the entry level, it applies to all vaults in the entry (overriding per-vault values). |
| `includeReservesSupplyFarmRewardsApy` | no | `true` | all | Include farm-reward APY in the yield computation. |
| `allocationDryRun` | no | `false` | all | Compute and log without sending transactions. This value applies to string vault entries. Object vault entries use their own `allocationDryRun` value. The global `ALLOCATION_DRY_RUN=true` forces dry-run for every vault. |
| `riskAppetiteMode` | no | `SENSIBLE` | all | Danger-detection sensitivity for all vaults in the entry: `PARANOID`, `SENSIBLE`, or `YOLO` — see [Danger detection](#danger-detection). An invalid value fails config loading. |

**Entry or vault-object fields** (set on the entry or on a vault object; the vault value wins)

| Field | Required | Default | Applies to | Meaning |
| --- | --- | --- | --- | --- |
| `driftRatePercent` | no | — | `EQUAL`, `MAX_YIELD`, `MAX_YIELD_STABLE`, `MAX_YIELD_WITH_FIXED_RESERVES`, `FIXED_WEIGHTS`, `RANDOM` | Percent of the current→target gap closed per iteration; unset applies the target at once. Must be in `(0, 100]`. `MAX_YIELD_DRIPPING` rejects it and uses `drippingRatePercent`. That rejection also fails loading when an entry sets the rate and one of its vault objects overrides the strategy to `MAX_YIELD_DRIPPING`. Set the rate on the other vault objects instead. |
| `drippingRatePercent` | no | `20` | `MAX_YIELD_DRIPPING` | Percent of the current→target gap closed per iteration. With the utilization cap enabled, movement starts from actual token holdings. Otherwise it starts from configured weights. Must be in `(0, 100]`. |
| `enforceUtilizationCap` | no | `false` | `MAX_YIELD_DRIPPING` | Whether to bound the target by the per-reserve utilization cap. Set `true` to opt into utilization-bounded targets. |
| `maxUtilizationChangeBps` | no | `100` (1%) | `MAX_YIELD_DRIPPING` | The per-iteration utilization-change cap in basis points when enforced. Must be in `(0, 10000]`; to disable the cap use `enforceUtilizationCap: false`, not `0`. |
| `maxVaultDominanceBps` | no | — | all | Danger detection: the vault's share of a reserve's total supply, in basis points, at or above which the dominant-depositor trigger forces a pull-out at any risk appetite. Unset keeps the graduated score only. Must be in `(0, 10000]`. |

**Vault-object fields** (use an object instead of a plain address string when a vault needs fixed reserves or its own overrides)

| Field | Default | Applies to | Meaning |
| --- | --- | --- | --- |
| `vault` | — | all | The vault address. |
| `strategy` | entry value | all | Optional strategy override for this vault; otherwise the entry-level strategy applies. |
| `fixedReserves` | — | `MAX_YIELD_STABLE`, `MAX_YIELD_WITH_FIXED_RESERVES`, `FIXED_WEIGHTS` | Reserve address strings — the reserves the search-allocation floor applies to (`MAX_YIELD_WITH_FIXED_RESERVES`, `MAX_YIELD_STABLE`); or `{ reserve, weight }` objects for `FIXED_WEIGHTS`. |
| `reservesAllocationPercentageBPS` | — | `MAX_YIELD_STABLE`, `MAX_YIELD_WITH_FIXED_RESERVES` | Minimum combined allocation, in basis points, for `fixedReserves`; must be in `[0, 10000]`. |
| `fixedReservesStrategy` | `EQUAL` | all | Metadata only; the fixed-reserve strategies use the explicit floor/weights described above. Must be a known strategy. |
| `includeReservesSupplyFarmRewardsApy` | entry value | all | Optional farm-reward APY override for this vault. |
| `allocationDryRun` | `false` | all | Dry-run setting for this object vault, overriding the entry-level value. `ALLOCATION_DRY_RUN=true` still forces dry-run globally. |
| `rebalanceFrequencySeconds` | `3600` | all | Per-vault frequency used only when the entry-level field is omitted; the entry-level value wins. |
<!-- allocation-fields:end -->

<!-- prettier-ignore-end -->

## Environment settings

The registry generates these tables and `.env.example`.
The tables show code defaults. The example profile overrides some defaults and enables live investing.

<!-- prettier-ignore-start -->

<!-- settings:start -->
**RPC**

| Setting | Default | Used by | Description |
| --- | --- | --- | --- |
| `RPC_ENDPOINT` | — | invest, allocation, danger | Legacy mode: the primary RPC URL. Legacy mode needs at least one of RPC_ENDPOINT, RPC_ENDPOINTS or RPC_ENDPOINT_\*. |
| `WS_ENDPOINT` | — | invest, allocation | WebSocket RPC URL. When unset or blank, the bot derives it from the read RPC URL (https -&gt; wss). |
| `RPC_ENDPOINTS` | `[]` | invest, allocation, danger | Legacy mode: fallback RPCs as a JSON array of { url, dedicatedWriteUrl?, name?, feePercentileSupportOverride? } objects. |
| `RPC_ENDPOINT_*` | — | invest, allocation, danger | Legacy mode: one fallback RPC URL per variable, ordered by suffix. A suffix that contains FEES_TRITON_STYLE, FEES_HELIUS_STYLE or FEES_NONE sets the fee API support. |
| `USE_RPC_CONFIG_FILE` | `false` | invest, allocation, danger | Use indexed mode (RPC_READ_&lt;n&gt;, RPC_SEND_&lt;n&gt;, RPC_PRIORITY_FEE_&lt;n&gt;_TRITON/HELIUS) instead of the legacy RPC settings. |
| `RPC_READ_*` | — | invest, allocation, danger | Indexed mode: read RPC URLs as RPC_READ_&lt;n&gt;, in numeric fallback order. At least one is required when USE_RPC_CONFIG_FILE=true. |
| `RPC_SEND_*` | — | invest, allocation, danger | Indexed mode: optional write RPC URL as RPC_SEND_&lt;n&gt;, paired with RPC_READ_&lt;n&gt;. |
| `RPC_PRIORITY_FEE_*` | — | invest, allocation, danger | Indexed mode: RPC URLs with a priority fee API, as RPC_PRIORITY_FEE_&lt;n&gt;_TRITON or RPC_PRIORITY_FEE_&lt;n&gt;_HELIUS. |
| `RPC_MULTICAST_ENDPOINTS` | `[]` | tx | Extra endpoints that also receive every sent transaction, as a JSON array of { name, connection } objects. |
| `RPC_MULTICAST_ENDPOINT_*` | — | tx | One multicast endpoint URL per variable, named after the suffix in kebab case (RPC_MULTICAST_ENDPOINT_IRONFORGE -&gt; ironforge). |
| `RPC_REQUEST_TIMEOUT_MS` | `120000` | process, invest, allocation, danger, tx | Timeout in milliseconds for one RPC request. Must be a positive safe integer. |
| `EXTERNAL_REQUEST_TIMEOUT_MS` | `30000` | invest, allocation, danger, tx | Timeout in milliseconds for one HTTP request to an external API, such as KSwap or the token flags feed. Must be a positive safe integer. |

**Transactions**

| Setting | Default | Used by | Description |
| --- | --- | --- | --- |
| `SIMULATE` | `true` | tx | Simulate transactions to find the approximate CU consumed before sending. |
| `SPAM` | `false` | tx | Send the same transaction multiple times. |
| `MULTICAST_JITO` | `false` | tx | Multicast transactions to Jito validators with a tip instruction. |
| `PRIORITY_FEE_PERCENTILE` | `50` | tx | Priority fee percentile: a number in [0, 100], true (the 50th percentile) or false (disabled). Needs an RPC with a percentile fee API. |
| `PRIORITY_MICRO_LAMPORTS_PER_CU_DEFAULT` | `5000` | tx | Fallback priority fee in micro-lamports per CU. Must be between the MIN and MAX bounds. |
| `PRIORITY_MICRO_LAMPORTS_PER_CU_MIN` | `1` | tx | Lower bound of the priority fee in micro-lamports per CU. |
| `PRIORITY_MICRO_LAMPORTS_PER_CU_MAX` | `4000000` | tx | Upper bound of the priority fee in micro-lamports per CU. |

**Modes**

| Setting | Default | Used by | Description |
| --- | --- | --- | --- |
| `INVEST_LOOP` | `false` | process | Run the invest loop. |
| `ALLOCATION_REBALANCE_LOOP` | `false` | process | Run the allocation-rebalance loop, which includes danger detection, in a worker thread. |

**Wallet**

| Setting | Default | Used by | Description |
| --- | --- | --- | --- |
| `INVESTOR_SECRET_PATH` | `/run/secrets/investor_keypair` | invest | Keypair file that signs the permissionless invest transactions. Any keypair with some SOL can do this. |
| `ALLOCATION_ADMIN_SECRET_PATH` | `/run/secrets/allocation_admin` | allocation | Keypair file of the vaults allocation admin, which signs allocation updates. |

**Invest**

| Setting | Default | Used by | Description |
| --- | --- | --- | --- |
| `INVEST_VAULTS` | (empty) | invest | Vault addresses to invest, separated by commas or whitespace. An address that holds no vault is skipped and logged. With INVEST_VAULTS, INVEST_OWNERS and the UI list all empty, every vault on chain is invested. |
| `INVEST_OWNERS` | (empty) | invest | Vault owner addresses, separated by commas or whitespace. The vaults of these owners are invested too. |
| `INVEST_UI_VAULTS` | `false` | invest | Also invest the vaults that the Kamino UI lists. |
| `INVEST_MIN_SLOT_BYPASS_VAULTS` | (empty) | invest | Vaults exempt from the MIN_SECONDS_SINCE_LAST_INVEST gate, separated by commas or whitespace. |

**Allocation rebalance**

| Setting | Default | Used by | Description |
| --- | --- | --- | --- |
| `ALLOCATION_CONFIG_PATH` | (empty) | allocation, invest | Path to the allocation config JSON file. Set it when the allocation-rebalance loop runs. Separate investing processes must use the same file to enforce enabled utilization caps. The invest loop rereads it before normal invests. |
| `GRID_SEARCH_RESOLUTION` | `0.01` | allocation | Allocation granularity of the MAX_YIELD strategy family as a fraction of AUM, in (0, 1]. A lower value finds better yield but uses exponentially more resources. |
| `GRID_SEARCH_MAX_CANDIDATES` | `5000000` | allocation | Maximum candidates one MAX_YIELD-family grid search counts for one vault, across all phases. Each generated point and each evaluation counts once, and a point generated in two refinement regions counts twice. When the search reaches it, the vault keeps its current allocation for that pass. A positive integer. |
| `GRID_SEARCH_MAX_MS` | `300000` | allocation | Maximum wall-clock time in milliseconds of one MAX_YIELD-family grid search for one vault. When the search reaches it, the vault keeps its current allocation for that pass. A positive integer. |
| `ALLOCATION_DRY_RUN` | `false` | allocation | The allocation loop computes and logs allocations but sends no transactions; the invest loop still sends. When false, the allocation config sets dry run per entry or vault. |

**Danger detection**

| Setting | Default | Used by | Description |
| --- | --- | --- | --- |
| `DANGER_BLACKLIST_PATH` | `./danger_blacklist.json` (required in production) | invest, danger, cli | Path to the danger-detection blacklist file, on a persistent volume; its directory must exist. The invest loop reads it to skip vaults with a pending evacuation or blacklisted exposure. Outside production an unset value falls back to an ephemeral dev-only file. |
| `MARKET_PRICE_MAX_AGE_SECONDS` | `300` | invest, danger | Age limit in seconds of a KSwap market price. Danger checks freeze the current allocation pass, and the invest loop skips its crank-funding swaps, when a price is older. |
| `MAX_STALE_PRICE_DURATION_SECONDS` | `3600` | danger | Scope price age limit L, in seconds. A zero or near-zero price is as old as the longer of its publish age and the time it has read zero. Safety score: 0.4 past L, 0.2 past 2L and 0 past 4L. A positive integer. |
| `REINVEST_COOLDOWN_SECONDS` | `2700` | allocation, danger | Seconds after a transient danger pull-out during which the reserve gets no new funds in any vault: no new weight and no deposit. In memory: a restart clears it. A positive integer. |
| `DANGER_PASS_INTERVAL_SECONDS` | `300` | allocation, danger | Maximum seconds the allocation loop sleeps between two passes, each of which starts with a danger pass. The loop sleeps for the smallest of this and every rebalanceFrequencySeconds; each vault still rebalances at its own frequency. The time a pass takes adds to the gap. A positive integer. |
| `KAMINO_TOKEN_FLAGS_URL` | `https://tokens.kamino.finance/tokens-flags.json` | danger | Kamino token flags feed that tells which tokens are stablecoins or LSTs. |

**KSwap**

| Setting | Default | Used by | Description |
| --- | --- | --- | --- |
| `KSWAP_API_BASE_URL` | `https://api.kamino.finance/kswap` | invest, allocation, danger | Base URL of the KSwap API, for swap routes and market prices. |
| `KSWAP_API_KEY` | — | invest, allocation, danger | Optional KSwap API key, sent as the x-api-key header. |
| `DEFAULT_SWAP_SLIPPAGE_BPS` | `100` | invest | Swap slippage tolerance in basis points, a safe integer in [0, 10000). |
| `DEFAULT_PRICE_SLIPPAGE_BPS` | `150` | invest | Independent reference-price tolerance in basis points, checked before signing a swap. |

**Looping**

| Setting | Default | Used by | Description |
| --- | --- | --- | --- |
| `LOOP_INTERVAL_MS` | `600000` | invest | Sleep in milliseconds between two invest passes. When a vault is invested is set by MIN_SECONDS_SINCE_LAST_INVEST. Must be a positive safe integer. |
| `LOOP_HEARTBEAT_TIMEOUT_MS` | — | process | The health server reports not ready when a loop sends no heartbeat for this many milliseconds. Defaults to 3 x RPC_REQUEST_TIMEOUT_MS. |
| `MIN_INVEST_TOKENS` | `10` | invest | A vault is invested only when its move, the larger of its deposits and its withdrawals, exceeds this many tokens. One count for every mint. |
| `MIN_SECONDS_SINCE_LAST_INVEST` | `1200` | invest | Minimum seconds since a vault's last invest before it is invested again; converted to slots at run time. |
| `RESERVE_INVEST_COOLDOWN_MS` | `600000` | invest, allocation | A reserve whose invest or disinvest instruction the programs reject for a vault is dropped from that vault's invests for this many milliseconds. 0 disables the cooldown. |
| `VAULT_RESERVES_MAX_UNIQUE_RESERVES_PER_BATCH` | `50` | invest, allocation | Maximum number of unique reserves loaded in one batch of vault reserves. Must be greater than 0. |

**Programs**

| Setting | Default | Used by | Description |
| --- | --- | --- | --- |
| `KLEND_PROGRAM_ID` | `KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD` | invest, allocation, danger | Kamino Lend program address. |
| `KVAULTS_PROGRAM_ID` | `KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd` | invest, allocation, danger | Kamino Vaults program address. |

**General**

| Setting | Default | Used by | Description |
| --- | --- | --- | --- |
| `CLUSTER` | `mainnet-beta` | process | Solana cluster. The process environment value also selects the default PROFILE. |
| `PROFILE` | — | process | Selects the .env.&lt;PROFILE&gt; file to load, so set it in the shell. Defaults to CLUSTER. |
| `SERVER` | `true` | process | Run the health server, which reports ready while every enabled loop sends heartbeats and the allocation loop's danger passes are not failing. |
| `SERVER_PORT` | `8080` | process | Health server port, an integer in [1, 65535]. An empty value uses the default. |
| `VERBOSE` | `false` | allocation | Log the details of each allocation computation. |

**Logging**

| Setting | Default | Used by | Description |
| --- | --- | --- | --- |
| `LOG_LEVEL` | `info` | logger | Winston log level. The logger package reads it directly. |
<!-- settings:end -->

<!-- prettier-ignore-end -->
