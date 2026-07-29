# Configuration reference

Field-by-field reference for the allocation config and the environment. For what the bot does with
these values, see the [README](../README.md).

Every address, threshold and tuning value shown here is an illustrative placeholder. Nothing in this
repository is the configuration anyone runs.

## Allocation config

JSON at `ALLOCATION_CONFIG_PATH`, shaped `{ "allocationsConfig": [ … ] }`: an array of entries, each
applying one strategy to a list of vaults. See
[`allocation_config_example.json`](../allocation_config_example.json) for a full example.

```json
{
  "allocationsConfig": [
    {
      "strategy": "MAX_YIELD_DRIPPING",
      "vaults": [
        "<vaultAddress>",
        {
          "vault": "<vaultAddress>",
          "drippingRatePercent": 10,
          "fixedReserves": ["<reserveAddress>"],
          "reservesAllocationPercentageBPS": 3000
        }
      ],
      "rebalanceFrequencySeconds": 900,
      "includeReservesSupplyFarmRewardsApy": true,
      "riskAppetiteMode": "PARANOID",
      "enforceUtilizationCap": true,
      "maxUtilizationChangeBps": 100,
      "maxVaultDominanceBps": 6000
    }
  ]
}
```

A vault entry is either a plain address string or an object. Use the object form when the vault needs
fixed reserves or its own overrides.

### Entry fields

| Field | Required | Meaning |
| --- | --- | --- |
| `strategy` | yes | One of the strategies above; applies to every vault in the entry. |
| `vaults` | yes | Array of address strings and/or vault objects. |
| `rebalanceFrequencySeconds` | no | Minimum seconds between rebalances (default `3600`). Set at entry level it applies to all vaults in the entry, **overriding** per-vault values. Must be > 0. |
| `includeReservesSupplyFarmRewardsApy` | no | Include farm-reward APY in the yield computation (default `true`). |
| `allocationDryRun` | no | Compute and log without sending transactions (default `false`). Applies to string vault entries; object entries use their own value. `ALLOCATION_DRY_RUN=true` forces dry-run everywhere. |
| `riskAppetiteMode` | no | Danger sensitivity for all vaults in the entry: `PARANOID`, `SENSIBLE` (default) or `YOLO`. An invalid value fails config loading. |
| `maxVaultDominanceBps` | no | Hard dominant-depositor pull-out threshold, in bps of a reserve's total supply. Unset by default. Must be in `(0, 10000]`. |
| `drippingRatePercent` | no | `MAX_YIELD_DRIPPING` only: percent of the current→target gap closed per iteration (default `20`). Must be in `(0, 100]`. |
| `enforceUtilizationCap` | no | `MAX_YIELD_DRIPPING` only: bound the target by the per-reserve utilization cap (default `false`). |
| `maxUtilizationChangeBps` | no | `MAX_YIELD_DRIPPING` only: per-iteration utilization-change cap in bps when enforced (default `100`). Must be in `(0, 10000]`. To disable the cap use `enforceUtilizationCap: false`, not `0`. |

### Vault-object fields

| Field | Meaning |
| --- | --- |
| `vault` | The vault address (required). |
| `strategy` | Strategy override for this vault; otherwise the entry-level strategy applies. |
| `fixedReserves` | Reserve address strings, the set the allocation floor applies to (`MAX_YIELD_WITH_FIXED_RESERVES`, `MAX_YIELD_STABLE`); or `{ reserve, weight }` objects for `FIXED_WEIGHTS`. Duplicates and mixed forms are rejected. |
| `reservesAllocationPercentageBPS` | Minimum combined allocation for `fixedReserves`, in bps; must be in `[0, 10000]`. |
| `includeReservesSupplyFarmRewardsApy` | Farm-reward APY override for this vault. |
| `allocationDryRun` | Dry-run for this vault (default `false`), overriding the entry-level value. `ALLOCATION_DRY_RUN=true` still wins globally. |
| `rebalanceFrequencySeconds` | Used only when the entry-level field is omitted; entry level wins. |
| `drippingRatePercent`, `enforceUtilizationCap`, `maxUtilizationChangeBps`, `maxVaultDominanceBps` | Per-vault overrides; the per-vault value wins over the entry-level one. |
| `fixedReservesStrategy` | Metadata only; the fixed-reserve strategies use the floor/weights above. |

### Validation

The config is fully validated at startup, so a mistake fails loading instead of surfacing mid-pass:
unknown strategies, invalid addresses, duplicate vaults, duplicate reserves, non-positive frequencies,
out-of-range bps and drip rates, non-boolean flags, `FIXED_WEIGHTS` entries without `{ reserve, weight }`
weights, and an invalid `riskAppetiteMode` all throw. Reserves named in a vault's `fixedReserves` are
also checked for membership in that vault's on-chain reserve list before each rebalance.

---

## Environment

Copy [`.env.example`](../.env.example) and edit. Defaults below are the *code* defaults, which the
example file sometimes overrides.

Invalid values fail fast at startup rather than being silently coerced: non-integer or non-positive
timeouts, out-of-range slippage or percentiles, inconsistent priority-fee bounds, a non-HTTP KSwap URL,
a bad `SERVER_PORT`, and a blank `DANGER_BLACKLIST_PATH` all throw.

### Loops and identity

| Variable | Default | Meaning |
| --- | --- | --- |
| `CLUSTER` | `mainnet-beta` | Solana cluster. |
| `PROFILE` | value of `CLUSTER` | Selects the `.env.<PROFILE>` file at the repo root. |
| `NODE_ENV` | — | `production` switches logs to JSON and makes `DANGER_BLACKLIST_PATH` mandatory. |
| `INVEST_LOOP` | `false` | Enable the invest loop. |
| `ALLOCATION_REBALANCE_LOOP` | `false` | Enable the allocation-rebalance loop. |
| `INVESTOR_SECRET_PATH` | `/run/secrets/investor_keypair` | JSON keypair array signing invest cranks. |
| `ALLOCATION_ADMIN_SECRET_PATH` | `/run/secrets/allocation_admin` | JSON keypair array signing allocation updates and pull-outs. Should be each configured vault's on-chain `allocation_admin`; `vault_admin_authority` also works but is not recommended. |

Secret paths are the one forgiving case: tried as given, then relative to the working directory, then
the workspace root, so `../allocation_admin.json` resolves from either the repo root or
`investing-bot/`. Config and blacklist paths have no such fallback.

### RPC and transactions

| Variable | Default | Meaning |
| --- | --- | --- |
| `RPC_ENDPOINT` | — | Primary RPC URL. |
| `WS_ENDPOINT` | — | Websocket URL. |
| `RPC_ENDPOINTS` | — | JSON array of fallback endpoints: `[{"name","url","dedicatedWriteUrl"}]`. |
| `RPC_ENDPOINT_<NAME>` | — | Flat per-endpoint variant of the above: one variable per endpoint instead of a JSON array. |
| `USE_RPC_CONFIG_FILE` | `false` | Switches to indexed mode: `RPC_READ_<n>`, optional paired `RPC_SEND_<n>`, and `RPC_PRIORITY_FEE_<n>_TRITON` / `_HELIUS`. Requires at least one `RPC_READ_<n>`. |
| `RPC_MULTICAST_ENDPOINTS` | `[]` | JSON array `[{"name","connection"}]` — send the same tx to several endpoints. `RPC_MULTICAST_ENDPOINT_<NAME>` also works. |
| `SIMULATE` | `true` | Simulate before sending to size compute units. |
| `SPAM` | `false` | Send the same transaction repeatedly. |
| `MULTICAST_JITO` | `false` | Also send to Jito with a tip instruction. |
| `PRIORITY_FEE_PERCENTILE` | `50` | Percentile for fee discovery; also accepts `true` (=50) or `false` (disabled). Requires a percentile-capable RPC. |
| `PRIORITY_MICRO_LAMPORTS_PER_CU_MIN` / `_DEFAULT` / `_MAX` | `1` / `5000` / `4000000` | Priority-fee bounds. Must satisfy min ≤ default ≤ max. |
| `RPC_REQUEST_TIMEOUT_MS` | `120000` | Per-RPC-operation watchdog. |
| `EXTERNAL_REQUEST_TIMEOUT_MS` | `30000` | Timeout for HTTP calls to the price, token-flags and KSwap APIs. |

### Invest loop

| Variable | Default | Meaning |
| --- | --- | --- |
| `INVEST_VAULTS` | — | Comma/whitespace-separated vault pubkeys. `#` comments allowed. |
| `INVEST_OWNERS` | — | Comma-separated owner pubkeys; all their vaults are invested. |
| `INVEST_UI_VAULTS` | `false` | Also invest every vault in Kamino's public resources feed. |
| `LOOP_INTERVAL_MS` | `600000` | Sleep between invest passes. Must be a positive integer. |
| `MIN_INVEST_TOKENS` | `10` | Minimum token gap (tokens, not lamports) before cranking a vault. |
| `MIN_SECONDS_SINCE_LAST_INVEST` | `1200` | Minimum seconds since the vault's last invest, on top of the vault's own on-chain delay. |

With none of `INVEST_VAULTS`, `INVEST_OWNERS`, `INVEST_UI_VAULTS` set, **all** on-chain vaults are invested.

### Allocation rebalance and danger

| Variable | Default | Meaning |
| --- | --- | --- |
| `ALLOCATION_CONFIG_PATH` | — | Path to the allocation JSON. Required for the rebalance loop. |
| `ALLOCATION_DRY_RUN` | `false` | Global dry-run: compute and log, send nothing, for every vault. |
| `GRID_SEARCH_RESOLUTION` | `0.01` | Requested coarse grid step for the max-yield family, as a fraction of AUM. Must be in `(0, 1]`. Lower = better allocation, exponentially more CPU/RAM. |
| `DANGER_BLACKLIST_PATH` | `./danger_blacklist.json` | Persisted blacklist file. **Mandatory when `NODE_ENV=production`** (the default is container-ephemeral); a present-but-empty value is rejected. |
| `MARKET_PRICE_MAX_AGE_SECONDS` | `300` | Danger checks freeze the pass when an off-chain price is older than this. Must be > 0. |
| `KAMINO_TOKEN_FLAGS_URL` | `https://tokens.kamino.finance/tokens-flags.json` | Peg-classification feed for the depeg trigger. |

### Swaps (invest-loop crank funding)

| Variable | Default | Meaning |
| --- | --- | --- |
| `KSWAP_API_BASE_URL` | `https://api.kamino.finance/kswap` | KSwap route and price API. Must be a valid HTTP(S) URL. |
| `KSWAP_API_KEY` | — | Sent as `x-api-key` when set. |
| `DEFAULT_SWAP_SLIPPAGE_BPS` | `100` | Route slippage tolerance. Must be in `[0, 10000)`. |
| `DEFAULT_PRICE_SLIPPAGE_BPS` | `150` | Independent reference-price bound checked before signing. Must be in `[0, 10000)`. |

### Programs, server, logging

| Variable | Default | Meaning |
| --- | --- | --- |
| `KLEND_PROGRAM_ID` | `KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD` | Kamino Lend program. |
| `KVAULTS_PROGRAM_ID` | `KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd` | Kamino Vaults program. |
| `SERVER` | `true` | Run the health/readiness server. |
| `SERVER_PORT` | `8080` | Health server port; must be in `[1, 65535]`. |
| `LOOP_HEARTBEAT_TIMEOUT_MS` | `3 × RPC_REQUEST_TIMEOUT_MS` | A loop silent for longer than this marks the process not ready. |
| `LOG_LEVEL` | `info` | Winston log level. |
| `VERBOSE` | `false` | Extra per-allocation logging. |
| `NODE_OPTIONS` | — | The example sets `--max-old-space-size=10000`; the grid search is memory-hungry on wide vaults. |

---

## Strategies

| Strategy | What it does |
| --- | --- |
| `EQUAL` | Equal weight to every healthy reserve: a flat 100,000 each, not a normalized split. |
| `MAX_YIELD` | Coarse-to-fine grid search over the allocation simplex, maximizing projected vault APY; applies the optimum immediately. |
| `MAX_YIELD_STABLE` | Same search machinery, minimizing the spread between simulated per-reserve yields. APY is reported but is not currently a tie-breaker. |
| `MAX_YIELD_WITH_FIXED_RESERVES` | `MAX_YIELD` with a minimum combined allocation (`reservesAllocationPercentageBPS`) across a named `fixedReserves` set. Needs the object vault form; on a plain address string the floor set is empty and the entry silently behaves as `MAX_YIELD`. |
| `MAX_YIELD_DRIPPING` | Computes the `MAX_YIELD` target (optionally utilization-bounded) and moves only a fraction of the current→target gap per iteration. |
| `FIXED_WEIGHTS` | Explicit per-reserve weights from config (`fixedReserves` as `{ reserve, weight }` objects). |
| `RANDOM` | Random weights. Testing and experimentation only. |
| `UNCHANGED` | No-op; recomputes and reports current APY without changing the allocation. |

### How the max-yield search works

Exhaustively enumerating allocations is exponential in reserve count, so the search runs coarse to fine:
a grid over the whole simplex, a medium refinement around the best few coarse candidates, then a fine
refinement around the winner. Every candidate is scored by simulating each reserve's supply APY at that
allocation, including farm-reward APY when `includeReservesSupplyFarmRewardsApy` is on, priced from the
token price feed.

`GRID_SEARCH_RESOLUTION` sets the requested coarse granularity (default `0.01` = 1% of AUM per step;
`0.1` = 10%). It is a *floor request*: the optimizer raises the coarse resolution automatically as
reserve count grows (up to 20% steps for wide vaults) to keep the candidate count tractable, then
recovers precision in the refinement phases. Lower values give better allocations and cost
exponentially more CPU and memory.

### Deposit and withdrawal constraints

The max-yield family (`MAX_YIELD`, `MAX_YIELD_WITH_FIXED_RESERVES`, `MAX_YIELD_STABLE`,
`MAX_YIELD_DRIPPING`) projects its allocation into per-reserve integer-weight bounds derived from live
reserve state. Deposit ceilings (reserve deposit caps, cap saturation) round down; withdrawal floors
(what can actually be pulled out given available liquidity) round up. The projection preserves the exact
integer weight total, so weights never silently inflate or deflate. If no allocation inside the bounds
exists, the strategy emits no instructions rather than an unsatisfiable one.

`EQUAL`, `RANDOM` and `FIXED_WEIGHTS` are cap-unaware: they emit weights verbatim (re-sending each
reserve's existing cap) with no bound projection. Nothing stops them asking for more than a reserve can
absorb or less than it can release. The weights are written successfully and the mismatch surfaces later
at the invest crank, which under-fills or fails for that reserve. Worth knowing before pointing
`FIXED_WEIGHTS` at a thin reserve.

### `MAX_YIELD_DRIPPING`

Built for vaults where a single large reallocation would move the market or shock depositor APY.

Each iteration moves weights a fraction of the way toward the `MAX_YIELD` target:
`current + drippingRate × (target − current)` per reserve, where
`drippingRate = drippingRatePercent / 100` (default 20%). The vector is rounded as a whole so the
integer total exactly matches the current total, then clamped into the deposit/withdrawal bounds above.
If no exact bounded allocation exists, nothing is emitted.

Setting `enforceUtilizationCap: true` (off by default) bounds the *target itself* rather than the step.
While searching, any candidate that would move a reserve's utilization by more than
`maxUtilizationChangeBps` (default `100` = 1%), or hit a chain-side deposit or withdrawal cap, is
rejected. That makes the same nominal move fine in a deep reserve and rejected in a thin one, and it
stacks with the drip rate. If every candidate is rejected the vault stays put. With the cap disabled the
search runs straight at the raw `MAX_YIELD` optimum.

Below a dead-band of `max(healthy weight total × fine-grid resolution, 0.5 / drippingRate)` no
instructions are emitted at all. The first term is the optimizer's own resolution floor, where the fine
resolution derives from the vault's invested-reserve count; the second is the smallest gap a drip can
move by at least one integer weight unit (2.5 units at the default 20% rate). Below that the search is
chasing its own rounding noise, so the vault stays put instead of burning fees.

If every APY candidate fails, or the final APY cannot be computed, the strategy keeps current weights,
reports APY `0`, and emits nothing.

Two limits are worth knowing. Dripping only *redistributes* an existing allocation, so a vault whose
total healthy weight is zero (unallocated, or all weight sitting on blacklisted reserves) stays
unchanged, because dripping from zero would be a jump rather than a drip. And fixed-reserve floors are
unsupported here; use `MAX_YIELD_WITH_FIXED_RESERVES` or `MAX_YIELD_STABLE` instead.

---

## Danger trigger catalog

Full details (measurement, scoring curves, per-appetite thresholds) are in
[`danger_triggers_catalog.md`](../investing-bot/src/danger/danger_triggers_catalog.md). Summary of what
is implemented:

| Trigger | Class | Score | Alone triggers pull-out? |
| --- | --- | --- | --- |
| Infinite mint (supply +50% between checks) | Catastrophic | 0 or 1 | Yes → permanent blacklist |
| Exchange-rate anomaly (cToken rate rises >0.1%, or cTokens with zero backing) | Catastrophic | 0 or 1 | Yes → permanent blacklist |
| Supply APY spike (>20% APY) | Slippery slope | 0 or 1 | Yes → cooldown, not blacklist |
| Insufficient exit liquidity (available vs vault position) | Slippery slope | graduated | PARANOID <65%, SENSIBLE <51%, YOLO <37% coverage |
| Oracle vs market divergence | Slippery slope | graduated, sqrt decay | PARANOID >4%, SENSIBLE >5.92%, YOLO >8.48% |
| Secondary-market depeg ($1 stables and LSTs, classified from Kamino's token-flags feed) | Slippery slope | graduated, sqrt decay | $1: >88/124/172 bps; LST: >3.25/5.41/8.29% discount |
| Market utilization (borrowed/supplied) | Slippery slope | graduated, linear 90%→100% | PARANOID >95%, SENSIBLE >97%, YOLO >99% |
| Vault is dominant depositor | Red flag | graduated, floor 0.3 | Only PARANOID, above 70%; or **any** appetite at/above `maxVaultDominanceBps` when set |

Red flags never justify a pull-out on their own, since their score floor sits at or above the `SENSIBLE`
threshold; they make every other signal worse. `maxVaultDominanceBps` is the one configurable override,
and it is a hard step rather than a rescaled curve. "Leave above 60%" means exactly that, and the
graduated score still compounds normally everywhere below it.

Not implemented, but documented in the catalog for future work: DEX liquidity depth,
deposit/withdrawal cap saturation, abnormal borrow spike, standalone oracle staleness, governance-attack
detection.

### Risk appetite

| Mode | Threshold | Behavior |
| --- | --- | --- |
| `PARANOID` | 0.5 | Pulls out early. |
| `SENSIBLE` | 0.3 | Default. |
| `YOLO` | 0.1 | Reacts only to severe danger. |

Set per entry with `riskAppetiteMode`. Because scores multiply, the threshold is a statement about
*combined* safety, not about any single trigger.
