# kvault-bot

An off-chain bot that keeps [Kamino Earn lending vaults](https://kamino.com/earn/lend) invested and
rebalances their reserve allocations according to a configured strategy, with a danger-detection layer
that pulls funds out of a reserve that starts misbehaving.

Source: [github.com/Kamino-Finance/kvault](https://github.com/Kamino-Finance/kvault).

It runs two independent loops, each switchable:

| Loop | Env flag | Signer | What it does |
| --- | --- | --- | --- |
| Invest | `INVEST_LOOP` | `INVESTOR_SECRET_PATH` | Cranks the permissionless `invest` instruction so each vault's actual token placement matches its on-chain allocation weights. |
| Allocation rebalance | `ALLOCATION_REBALANCE_LOOP` | `ALLOCATION_ADMIN_SECRET_PATH` | Runs danger detection, computes new allocation weights per strategy, writes them on-chain, then invests. Must sign as each vault's `allocation_admin`. |

The invest loop is permissionless: any funded keypair can run it.

The allocation loop signs allocation updates and emergency pull-outs, so its keypair should be the
on-chain `vault.allocation_admin` of every configured vault. That role is distinct from
`vault_admin_authority`: you can delegate it without handing over vault administration, and it is the
only authority the bot needs at *runtime*. The vault admin is needed once per reserve, up front, to add
that reserve to the allocation. The bot updates allocations but never creates them.

The program also accepts `vault_admin_authority` here, so an admin key works. **Don't.** That puts full
vault administration (fees, whitelists, authority changes) behind a long-lived key on a server, for
zero extra capability. Use `allocation_admin` and keep the admin key offline.

---

## 1. Quick start

```bash
# 1. clone, install and build (tx/ and logger/ are consumed from dist/, so build is required)
git clone https://github.com/Kamino-Finance/kvault.git && cd kvault
yarn && yarn build

# 2. create a profile file in the repo root
cp .env.example .env.mainnet-beta        # then edit: RPC, loop flags, key paths

# 3. create the runtime config files (absolute paths — see "Where paths resolve from" below)
cp allocation_config_example.json allocation_config.json
yarn cli danger init --path "$PWD/danger_blacklist.json"

# 4. run
PROFILE=mainnet-beta yarn start
```

Before the first live run:

1. **Fund the signers with SOL.** `INVESTOR_SECRET_PATH` pays for invest cranks.
   `ALLOCATION_ADMIN_SECRET_PATH` pays for allocation updates and emergency pull-outs, and must be an
   authority every configured vault accepts: its `allocation_admin` (recommended) or its
   `vault_admin_authority`. Anything else is rejected on-chain.
2. **Pre-add the reserves with the vault admin key.** The bot only *updates* allocations already in the
   vault's `vault_allocation_strategy`; inserting one is a vault-admin operation it cannot perform. Add
   every reserve it should be able to allocate to first.
3. **Point `ALLOCATION_CONFIG_PATH`** at your allocation JSON (section 5).
4. **Point `DANGER_BLACKLIST_PATH`** at a file on a *persistent* volume: the blacklist and pending
   evacuations live there and must survive restarts. With `NODE_ENV=production` the bot refuses to start
   unless this is set explicitly.
5. **Start in dry-run.** Set `ALLOCATION_DRY_RUN=true` for the first passes: everything is computed and
   logged, nothing is sent.

### Profile selection

The profile file is loaded from the repo root as `.env.<PROFILE>`. `PROFILE` defaults to `CLUSTER`,
which defaults to `mainnet-beta`, so with nothing set the bot loads `.env.mainnet-beta`. Values missing
from the file fall through to real environment variables, so containers can skip the file entirely.
`${VAR}` references inside it are expanded.

### Commands

| Command | Purpose |
| --- | --- |
| `yarn build` | Compiles all three workspaces (`tsc --build`). |
| `yarn start` | Runs the bot. `investing-bot` sources run through ts-node. `tx/` and `logger/` are consumed from `dist/`, so changes there need a rebuild; changes under `investing-bot/src/` only need a restart. |
| `yarn dry-run` | `yarn start` with `PROFILE=local ALLOCATION_DRY_RUN=true`. |
| `yarn cli danger …` | Blacklist management (section 6). |
| `yarn cli print-rebalance-strategies` | Prints the valid strategy names. |

### Where paths resolve from

**Use absolute paths for both config files and both keypairs in any real deployment.** The relative
form works, but only from the repo root, and it fails quietly.

`yarn start` and `yarn cli` both run inside the `investing-bot/` workspace, so every relative path
resolves against `investing-bot/`, not the repo root, in the profile file and in a CLI `--path` alike.
Hence `.env.example` writing `../allocation_config.json` and `../danger_blacklist.json`: `../` *is* the
repo root. A `./danger_blacklist.json` passed to the CLI lands in `investing-bot/`, where the bot never
looks.

Only keypair paths are forgiving: `readSecret` tries the path as given, then relative to the working
directory, then the workspace root. `ALLOCATION_CONFIG_PATH`, `DANGER_BLACKLIST_PATH` and `--path` go
straight to `fs`, so a wrong path means no file, and for the blacklist an empty blacklist that silently
enforces nothing.

### Every address and number here is an example

Every vault and reserve address, strategy, threshold and tuning value in `.env.example`,
`allocation_config_example.json`, `danger_blacklist_example.json`, and any hardcoded address in the
source is an illustrative placeholder showing the shape of a valid config. Nothing here is the
configuration anyone runs. Replace all of it with your own vaults and tuning.

### Layout

```
investing-bot/     the bot: loops, strategies, danger detection, CLI
tx/                transaction building, sending, RPC pool, priority fees
logger/            structured logging
.env.example                        config template  →  copy to .env.<PROFILE>
allocation_config_example.json      strategy config  →  copy, point ALLOCATION_CONFIG_PATH at it
danger_blacklist_example.json       blacklist format →  DANGER_BLACKLIST_PATH file
```

`investing-bot/src/danger/danger_triggers_catalog.md` is the authoritative per-trigger catalog: risk,
measurement, scoring curve and thresholds for every implemented and planned trigger.

---

## 2. Process model

- **Health server.** Started before the loops when `SERVER=true` (default) on `SERVER_PORT`
  (default `8080`), via [lightship](https://github.com/gajus/lightship), exposing `/health`, `/live` and
  `/ready`. Readiness is driven by loop heartbeats: if any enabled loop goes silent for
  `LOOP_HEARTBEAT_TIMEOUT_MS` (default `3 × RPC_REQUEST_TIMEOUT_MS`), the process reports not ready.
  Point your orchestrator's readiness probe at `/ready` to catch a wedged loop.
- **Invest loop** runs in the main thread's async context.
- **Allocation loop** runs in a worker thread with a 4 GB heap cap, restarted up to 3 times on
  unexpected exit (the counter resets on any heartbeat). After 3 failed restarts the loop is marked
  permanently unhealthy: readiness goes false and the process needs an external restart.
- **Crash isolation.** Both loops are wrapped in a retry harness, so a thrown error inside a pass is
  logged and the loop re-enters rather than killing the process.
- **Graceful shutdown.** `SIGINT`/`SIGTERM` stop the health server, signal the worker, wait 5 s for it
  to finish, then force-terminate; a hard exit follows after 10 s.
- **Timezone** is forced to UTC. Logs are JSON in production (`NODE_ENV=production`), colorized
  otherwise; verbosity via `LOG_LEVEL` (default `info`) plus `VERBOSE=true` for per-allocation detail.

---

## 3. The invest loop

Every `LOOP_INTERVAL_MS` the loop resolves its vault set, tops up crank funds, then decides per vault
whether to send an invest crank.

**Vault set.** The union of `INVEST_VAULTS` (explicit pubkeys), all vaults owned by `INVEST_OWNERS`,
and, when `INVEST_UI_VAULTS=true`, every vault in Kamino's public resources feed. With none of the three
set, it invests **every** vault on-chain. The set is re-resolved every pass, so a new vault under a
configured owner is picked up automatically.

**Crank funding.** The `invest` instruction reconciles cToken↔liquidity rounding with a top-up of at
most a few base units, drawn first from the vault's own `available_crank_funds`, then from the crank
payer's token account. So the signer needs a token account per vault mint with a small balance; the bot
keeps 10 base units per vault holding that mint as the buffer.

Missing amounts come from a KSwap exact-out swap from WSOL, or a plain SOL wrap when the vault token
*is* WSOL; missing ATAs are created first. Each swap is guarded twice over: `DEFAULT_SWAP_SLIPPAGE_BPS`
on the route itself, and an independent reference-price bound (`DEFAULT_PRICE_SLIPPAGE_BPS`) against
fresh KSwap prices, plus pre/post balance assertions. **If reference prices are missing or older than
`MARKET_PRICE_MAX_AGE_SECONDS`, the funding swap is skipped** rather than executed blind, and the pass
continues with existing balances.

**Invest decision.** A vault is cranked only when *both* hold:

- **Amount:** the summed positive gap between the vault's target allocation (derived from on-chain
  weights) and its current per-reserve holdings exceeds `MIN_INVEST_TOKENS`. Only positive gaps count,
  so a pure reshuffle is not double-counted. When a vault has no reserves, or all weights are zero,
  the whole invested balance counts as the gap (full deinvest).
- **Time:** at least `MIN_SECONDS_SINCE_LAST_INVEST` worth of slots have passed since the vault's most
  recent `last_invest_slot` across all its reserves, *and* the vault's on-chain
  `min_invest_delay_slots` has elapsed.

One vault address is hardcoded to bypass the `MIN_SECONDS_SINCE_LAST_INVEST` check:
`CONFIG_MIN_SLOT_BYPASS_VAULT` in `investing_loop.ts`, currently
`4TwKA9JXEGeLEpAPLoarhSQoQwoiu12dkDCjSuVvHQUf`. That is an example value, not a vault this bot is run
against, and it only has an effect if that address is in your invest set.

Both checks are off-chain heuristics layered on the program's own gates, which are stricter in two ways:
the delay is enforced per reserve (`last_invest_slot + min_invest_delay_slots`, else `InvestTooSoon`),
and each move must exceed the vault's `min_invest_amount`, else `InvestAmountBelowMinimum`. The one
exemption is an uncapped full evacuation of a `weight == 0` reserve, always allowed to go to zero, so a
danger pull-out is never blocked by the minimum-amount floor.

**Skips.** A vault is skipped when a withdrawal it needs exceeds the source reserve's available
liquidity and there is not enough idle balance to make the move worthwhile, since cranking would just
fail on-chain.

It is also skipped when the danger layer has unfinished business with it. The loop reads the blacklist
file, both its blacklisted reserves and its per-vault pending evacuations, and refuses to invest a vault
still holding exposure to a blacklisted reserve or with an evacuation in flight, since investing there
would push funds back into a reserve the bot is trying to leave.

Instructions are sent in batches of 2 (invest) or 4 (ATA creation), preserving SDK order so disinvests
land before the matching invests.

---

## 4. The allocation rebalance loop

One pass, in order:

1. **Batch-fetch** every configured vault and all of their reserves. On a partial fetch, sleep 10 s and
   retry. Never rebalance on incomplete state.
2. **Danger detection** over every vault (section 6). This produces a per-vault directive: either
   *skip* (the vault was just responded to) or *rebalance with these exclusion sets*. A thrown error or
   timeout anywhere in the danger pass **skips the whole iteration**. It fails closed and never falls
   through to a normal rebalance.
3. **Fetch farm states and prices** for every reserve supply farm and reward mint (only for vaults with
   `includeReservesSupplyFarmRewardsApy` on) plus every vault token.
4. **Per vault:** if its rebalance frequency has elapsed, compute the new weights with its strategy,
   send the allocation updates (batches of 2, with the vault's LUT when it has one), wait 5 s, reload
   state and send an invest crank so the funds follow the new weights.
5. **Sleep** for the smallest `rebalanceFrequencySeconds` across the whole config, then repeat.

**Frequency semantics.** The loop's sleep is the config-wide minimum; each vault additionally checks its
own `rebalanceFrequencySeconds` before acting. Restarts reset the per-vault timers, so a restart triggers
a rebalance on the next pass unless the chain rejects it. Dry-run vaults are evaluated every pass
regardless of frequency (nothing is sent, so there is nothing to rate-limit).

**Failure containment.** If weight computation throws for a vault, the loop falls back to sending only
that vault's blacklist-enforcement instructions (force-zeroing dangerous reserves) instead of skipping
safety work; if even that fails, the vault is skipped and the others continue. Danger is scoped per
vault, so one persistently dangerous vault never stalls the fleet.

### What the bot writes on-chain, and what it needs from the vault

Every strategy ultimately emits one `update_reserve_allocation` per changed reserve, carrying a
`target_allocation_weight` and a token `allocation_cap`. Consequences worth knowing before running it:

- **The vault takes its cut before the reserves.** The program computes the unallocated share from
  `unallocated_weight / (unallocated_weight + Σ reserve weights)`, bounded by `unallocated_tokens_cap`,
  then splits the remainder across reserves by weight. The bot never writes `unallocated_weight` (the
  vault admin owns it), so raising it proportionally lowers everything the bot's weights control.
- **Weights are absolute, and the total differs by strategy.** Nothing normalizes them to a fixed sum:
  `EQUAL` writes 100,000 *per reserve* (300,000 total on a three-reserve vault), `FIXED_WEIGHTS` writes
  exactly what the config says, and the max-yield family preserves the vault's existing total. At
  `unallocated_weight = 0` only ratios matter, so this is invisible; at nonzero it is not, because the
  same ratios at a 3× larger total shrink the uninvested share to roughly a third. **Re-check
  `unallocated_weight` whenever you change a vault's strategy.** No config field expresses this coupling.
- **The bot only ever updates existing allocations.** It optimizes over reserves already in
  `vault_allocation_strategy` and skips the rest, because the program lets `allocation_admin` update an
  existing allocation but requires `vault_admin_authority` to insert one
  (`WrongAdminOrAllocationAdmin`). **Add every reserve the bot may allocate to with the vault admin key
  first.** Afterwards it needs nothing but `allocation_admin`.
- **Caps are preserved, not managed.** The bot re-sends each reserve's existing `token_allocation_cap`
  unchanged, including through a danger pull-out, which zeroes the weight and leaves the cap intact. It
  uses the v1 instruction, preserving whatever `ctoken_allocation_cap` is already set. Both caps stay
  the vault admin's tool; treat them as a hard ceiling the bot cannot exceed.
- **Reserve whitelists gate increases only.** Under
  `allow_allocations_in_whitelisted_reserves_only`, raising a weight or cap on a reserve with no
  add-allocation whitelist entry fails with `ReserveNotWhitelisted`; under
  `allow_invest_in_whitelisted_reserves_only`, the same applies to an invest that *adds* liquidity.
  Lowering a weight, and any invest that withdraws, are never gated, so a pull-out always goes through
  and a whitelist misconfiguration can only stall growth, not an exit.

### The rebalance universe

Before any strategy runs, the vault's reserves are split into:

- **healthy** — the only reserves a strategy may optimize over;
- **blacklisted** — permanently excluded *and* force-zeroed on-chain via explicit instructions;
- **cooldown** — excluded from receiving new allocation, but **not** force-zeroed; an existing position
  is left where it is.

All weight math (drip rates, grid budgets, totals) happens on the healthy-universe scale, so a
force-zeroed reserve cannot distort it.

### Strategies

| Strategy | What it does |
| --- | --- |
| `EQUAL` | Equal weight to every healthy reserve: a flat 100,000 each, not a normalized split. |
| `MAX_YIELD` | Coarse-to-fine grid search over the allocation simplex, maximizing projected vault APY; applies the optimum immediately. |
| `MAX_YIELD_STABLE` | Same search machinery, minimizing the spread between simulated per-reserve yields. APY is reported but is not currently a tie-breaker. |
| `MAX_YIELD_WITH_FIXED_RESERVES` | `MAX_YIELD` with a minimum combined allocation (`reservesAllocationPercentageBPS`) across a named `fixedReserves` set. Needs the object vault form; on a plain address string the floor set is empty and the entry silently behaves as `MAX_YIELD`. |
| `MAX_YIELD_DRIPPING` | Computes the `MAX_YIELD` target (optionally utilization-bounded) and moves only a fraction of the current→target gap per iteration. See below. |
| `FIXED_WEIGHTS` | Explicit per-reserve weights from config (`fixedReserves` as `{ reserve, weight }` objects). |
| `RANDOM` | Random weights. Testing and experimentation only. |
| `UNCHANGED` | No-op; recomputes and reports current APY without changing the allocation. |

#### How the max-yield search works

Exhaustively enumerating allocations is exponential in reserve count, so the search runs in three
phases: a **coarse** grid over the whole simplex, a **medium** refinement around the best few coarse
candidates, then a **fine** refinement around the winner. Every candidate is scored by simulating each
reserve's supply APY at that allocation, including farm-reward APY when
`includeReservesSupplyFarmRewardsApy` is on, priced from the token price feed.

`GRID_SEARCH_RESOLUTION` sets the requested coarse granularity (default `0.01` = 1% of AUM per step;
`0.1` = 10%). It is a *floor request*: the optimizer raises the coarse resolution automatically as
reserve count grows (up to 20% steps for wide vaults) to keep the candidate count tractable, then
recovers precision in the refinement phases. Lower values give better allocations and cost
exponentially more CPU and memory.

#### Deposit and withdrawal constraints

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

#### `MAX_YIELD_DRIPPING`

Built for vaults where a single large reallocation would move the market or shock depositor APY.

- **Drip.** Candidate weights are `current + drippingRate × (target − current)` per reserve, where
  `drippingRate = drippingRatePercent / 100` (default 20%). The vector is rounded as a whole so the
  integer total exactly matches the current total, then clamped into the deposit/withdrawal bounds
  above. If no exact bounded allocation exists, no instructions are emitted.
- **Utilization cap (opt-in, off by default; `enforceUtilizationCap: true`).** While searching for the
  target, any candidate that would move a reserve's utilization by more than `maxUtilizationChangeBps`
  (default `100` = 1%), or hit a chain-side deposit/withdrawal cap, is rejected. This bounds the
  *target itself* by each reserve's liquidity depth, so the same nominal move is fine in a deep reserve
  and rejected in a thin one, and it stacks with the drip rate. If every candidate is rejected, the
  vault stays put. With the cap disabled (the default), the search runs straight at the raw `MAX_YIELD`
  optimum.
- **Dead-band.** No instructions are emitted when the largest current→target gap is at most
  `max(healthy weight total × fine-grid resolution, 0.5 / drippingRate)`. The first term is the
  optimizer's own resolution floor, where the fine resolution is derived from the vault's
  invested-reserve count. The second is the smallest gap a drip can move by at least one integer weight
  unit (2.5 units at the default 20% rate). Below that the search is chasing its own rounding noise, so
  the vault stays put instead of burning fees.
- **Bail-outs.** If every APY candidate fails, or the final APY cannot be computed, the strategy keeps
  current weights, reports APY `0`, and emits nothing.
- **Limits.** Dripping only *redistributes* an existing allocation. A vault whose total healthy weight
  is zero (unallocated, or all weight sitting on blacklisted reserves) stays unchanged, because
  dripping from zero would be a jump, not a drip. Fixed-reserve floors are unsupported here; use
  `MAX_YIELD_WITH_FIXED_RESERVES` or `MAX_YIELD_STABLE`.

---

## 5. Allocation config

JSON at `ALLOCATION_CONFIG_PATH`, shaped `{ "allocationsConfig": [ … ] }`: an array of entries, each
applying one strategy to a list of vaults. See
[`allocation_config_example.json`](./allocation_config_example.json) for a full example.

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

A vault entry is either a plain address string or an object; use the object form when the vault needs
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
| `maxVaultDominanceBps` | no | Hard dominant-depositor pull-out threshold, in bps of a reserve's total supply (see section 6). Unset by default. Must be in `(0, 10000]`. |
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

## 6. Danger detection and the pull-out mechanism

Before each rebalance iteration, the bot scores every reserve of every configured vault
(`investing-bot/src/danger/`). Each trigger returns a safety score in `[0, 1]`; a reserve's scores
**multiply** into one combined safety score, so several mild red flags compound into a pull-out that
none of them would cause alone. When a reserve's combined score falls below the vault's risk-appetite
threshold, the bot **emergency-deinvests from it and forces its weight to zero in one shot**, never
stepped down gradually and never dripped.

### Risk appetite

| Mode | Threshold | Behavior |
| --- | --- | --- |
| `PARANOID` | 0.5 | Pulls out early. |
| `SENSIBLE` | 0.3 | Default. |
| `YOLO` | 0.1 | Reacts only to severe danger. |

Set per entry with `riskAppetiteMode`. Because scores multiply, the threshold is a statement about
*combined* safety, not about any single trigger.

### The pull-out sequence

For each dangerous reserve in the vault:

1. Build an allocation update setting weight `0` while preserving the configured allocation cap; skip
   reserves already at zero.
2. Send the zeroing instructions (batches of 2, with the vault's LUT). These are sent **even if
   simulation fails**, because a pull-out must not be blocked by a flaky simulation.
3. Wait 5 s, reload vault state, send a full deinvest crank, then reload state again so completion is
   judged against post-deinvest balances.
4. The vault is marked **skip** for this rebalance pass. This is enforced by the type system: a
   responded-to vault carries no rebalance parameters at all, so it structurally cannot be re-exposed
   in the same pass.

If exposure remains afterwards (e.g. the reserve had no liquidity to withdraw), it is recorded as a
**pending evacuation** for that vault in the `pendingEvacuations` array of the same
`DANGER_BLACKLIST_PATH` file, so it survives a restart and is visible to both loops. Pending evacuations
are retried every pass, block the invest loop from touching that vault, clear automatically once the
exposure reaches zero, and are logged as needing operator intervention while they persist.

### What happens after the pull-out

Where the reserve lands depends on *why* it was flagged:

- **Catastrophic** — irreversible loss of funds (infinite mint, collateral exchange-rate increase).
  The reserve goes on the **permanent blacklist**, persisted to `DANGER_BLACKLIST_PATH`. On every later
  iteration it is excluded from every strategy's optimization universe and its on-chain weight is kept
  force-zeroed. It leaves only by manual operator action; there is no auto-expiry.
- **Transient / market** — oracle divergence, thin exit liquidity, elevated supply APY, utilization
  squeeze, depeg. The reserve is pulled out and put in a **reinvest cooldown** for 3 passes: excluded
  from receiving new allocation, but its existing position is left untouched and never force-zeroed.
  This stops a reserve that flaps in and out of danger from thrashing pull-out → reinvest → pull-out.
  Cooldowns are in-memory and reset on restart.

Danger is scoped **per vault**: only a vault just responded to skips its rebalance this iteration. Every
other vault rebalances normally, with blacklisted reserves force-zeroed and cooldown reserves excluded
from new allocation.

### Fail-closed guarantees

Bad or missing data never reads as "safe":

- Every reserve needs a positive market price no older than `MARKET_PRICE_MAX_AGE_SECONDS`
  (default 300). Missing, stale, malformed or failed trigger data **freezes that allocation iteration**
  instead of triggering either a blind rebalance or a blind mass withdrawal.
- A danger-pass error or timeout skips the rebalance and retries. The detector lives outside the loop,
  so its in-memory trigger baselines survive a transient failure and the catastrophic triggers are not
  blinded on the next pass.
- A corrupt or structurally invalid blacklist file makes every danger pass throw, so no rebalance runs.
  The loop retries indefinitely; it does not halt the process. Fix the file.
- The peg feed (`https://tokens.kamino.finance/tokens-flags.json`) is fetched once per pass. An outage
  reuses the last good snapshot; a cold start with no snapshot at all fails the pass closed.
- A vault marked dry-run (globally, per entry, or per vault) is detected and logged only; it never
  receives real emergency transactions. Catastrophic observations seen only by a dry-run vault stay
  staged rather than being committed as a new baseline.

### Trigger catalog

Full details (measurement, scoring curves, per-appetite thresholds) are in
`investing-bot/src/danger/danger_triggers_catalog.md`. Summary of what is implemented:

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

Red flags never justify a pull-out on their own (their score floor sits at or above the `SENSIBLE`
threshold); they make every other signal worse. `maxVaultDominanceBps` is the one configurable
override, and it is a hard step, not a rescaled curve. "Leave above 60%" means exactly that, and the
graduated score still compounds normally everywhere below it.

Not implemented (documented in the catalog for future work): DEX liquidity depth, deposit/withdrawal
cap saturation, abnormal borrow spike, standalone oracle staleness, governance-attack detection.

### Blacklist operations

The file is JSON with two arrays. `blacklistedReserves` holds the reserve, trigger name, a
human-readable reason carrying the exact scores, and a timestamp (see
[`danger_blacklist_example.json`](./danger_blacklist_example.json)); `pendingEvacuations` holds the same
plus the vault address.

Manage it with the CLI. Every subcommand takes `--path`, defaulting to `DANGER_BLACKLIST_PATH`; a
relative `--path` resolves against `investing-bot/`, so prefer an absolute one.

```bash
yarn cli danger init                       # create an empty blacklist file (no-op if it exists)
yarn cli danger list                       # show blacklisted reserves with trigger, reason, timestamp
yarn cli danger clear-reserve <address>    # un-blacklist one reserve (manual re-entry decision)
yarn cli danger clear-all                  # clear the whole blacklist
```

Clearing a reserve is the operator saying "this was a false positive, or the cause is resolved". The
bot starts allocating to it again on the next pass, subject to the triggers re-scoring it.

The CLI covers `blacklistedReserves` only: `list` does not print pending evacuations, and neither
`clear-reserve` nor `clear-all` removes them. A pending evacuation normally clears itself once the
exposure is out. One stuck because the reserve genuinely cannot be exited has to be edited out by hand,
and only after deciding the exposure is acceptable. While it is listed, the invest loop leaves that
vault alone.

---

## 7. Environment reference

Copy [`.env.example`](./.env.example) and edit. Defaults below are the *code* defaults, which the
example file sometimes overrides.

### Loops and identity

| Variable | Default | Meaning |
| --- | --- | --- |
| `CLUSTER` | `mainnet-beta` | Solana cluster. |
| `PROFILE` | value of `CLUSTER` | Selects the `.env.<PROFILE>` file at the repo root. |
| `NODE_ENV` | — | `production` switches logs to JSON and makes `DANGER_BLACKLIST_PATH` mandatory. |
| `INVEST_LOOP` | `false` | Enable the invest loop. |
| `ALLOCATION_REBALANCE_LOOP` | `false` | Enable the allocation-rebalance loop. |
| `INVESTOR_SECRET_PATH` | `/run/secrets/investor_keypair` | JSON keypair array signing invest cranks. |
| `ALLOCATION_ADMIN_SECRET_PATH` | `/run/secrets/allocation_admin` | JSON keypair array signing allocation updates and pull-outs. Should be each configured vault's on-chain `allocation_admin`; `vault_admin_authority` also works but is not recommended (section 1). |

Secret paths are the one forgiving case: tried as given, then relative to the working directory, then
relative to the workspace root, so `../allocation_admin.json` resolves from either the repo root or
`investing-bot/`. Config and blacklist paths have no such fallback (see
[Where paths resolve from](#where-paths-resolve-from)).

### RPC and transactions

| Variable | Default | Meaning |
| --- | --- | --- |
| `RPC_ENDPOINT` | — | Primary RPC URL. |
| `WS_ENDPOINT` | — | Websocket URL. |
| `RPC_ENDPOINTS` | — | JSON array of fallback endpoints: `[{"name","url","dedicatedWriteUrl"}]`. |
| `RPC_ENDPOINT_<NAME>` | — | Helm-friendly per-endpoint variant of the above. |
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
| `ALLOCATION_CONFIG_PATH` | — | Path to the allocation JSON (section 5). Required for the rebalance loop. |
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

Invalid values fail fast at startup rather than being silently coerced: non-integer or non-positive
timeouts, out-of-range slippage or percentiles, inconsistent priority-fee bounds, a non-HTTP KSwap URL,
a bad `SERVER_PORT`, and a blank `DANGER_BLACKLIST_PATH` all throw.

---

## 8. Operating notes

- **Never commit secrets.** `.env.*` profiles hold RPC and KSwap API keys; keypair files hold signing
  authority. Keep both out of version control.
- **Persist the blacklist.** On a container platform, mount `DANGER_BLACKLIST_PATH` on a volume. Losing
  it re-admits reserves the bot decided were permanently compromised.
- **Roll out with dry-run.** `ALLOCATION_DRY_RUN=true` globally, or `allocationDryRun` per entry/vault,
  lets a new strategy or a new vault run in observation mode. Danger detection still evaluates and
  logs, but no transaction is ever sent for that vault.
- **Watch `/ready`.** A wedged loop shows up there before it shows up in the logs.
- **Grid resolution is the main cost knob.** If the allocation worker approaches its 4 GB heap cap or
  passes get slow, raise `GRID_SEARCH_RESOLUTION` before anything else.
