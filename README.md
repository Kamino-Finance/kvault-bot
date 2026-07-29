# kvault-bot

An off-chain bot that keeps [Kamino Earn lending vaults](https://kamino.com/earn/lend) invested and
rebalances their reserve allocations according to a configured strategy, with a danger-detection layer
that pulls funds out of a reserve that starts misbehaving.

Source: [github.com/Kamino-Finance/kvault](https://github.com/Kamino-Finance/kvault).
Field-by-field config and environment reference: [`docs/configuration.md`](./docs/configuration.md).

It runs two independent loops, each switchable:

| Loop | Env flag | Signer | What it does |
| --- | --- | --- | --- |
| Invest | `INVEST_LOOP` | `INVESTOR_SECRET_PATH` | Cranks the permissionless `invest` instruction so each vault's actual token placement matches its on-chain allocation weights. |
| Allocation rebalance | `ALLOCATION_REBALANCE_LOOP` | `ALLOCATION_ADMIN_SECRET_PATH` | Runs danger detection, computes new allocation weights per strategy, writes them on-chain, then invests. Must sign as each vault's `allocation_admin`. |

## Which key to run it on

The invest loop is permissionless: any funded keypair can run it.

The allocation loop signs allocation updates and emergency pull-outs, so its keypair should be the
on-chain `vault.allocation_admin` of every configured vault. That role is distinct from
`vault_admin_authority`: you can delegate it without handing over vault administration, and it is the
only authority the bot needs at runtime. The vault admin is needed once per reserve, up front, to add
that reserve to the allocation, because the bot updates allocations but never creates them.

The program also accepts `vault_admin_authority` here, so an admin key works. **Don't.** That puts full
vault administration (fees, whitelists, authority changes) behind a long-lived key on a server, for
zero extra capability. Use `allocation_admin` and keep the admin key offline.

## Quick start

```bash
# 1. clone, install and build (tx/ and logger/ are consumed from dist/, so build is required)
git clone https://github.com/Kamino-Finance/kvault.git && cd kvault
yarn && yarn build

# 2. create a profile file in the repo root
cp .env.example .env.mainnet-beta        # then edit: RPC, loop flags, key paths

# 3. create the runtime config files (use absolute paths)
cp allocation_config_example.json allocation_config.json
yarn cli danger init --path "$PWD/danger_blacklist.json"

# 4. run
PROFILE=mainnet-beta yarn start
```

The profile file is loaded from the repo root as `.env.<PROFILE>`. `PROFILE` defaults to `CLUSTER`,
which defaults to `mainnet-beta`, so with nothing set the bot loads `.env.mainnet-beta`. Values missing
from the file fall through to real environment variables, so containers can skip the file entirely.
`${VAR}` references inside it are expanded.

| Command | Purpose |
| --- | --- |
| `yarn build` | Compiles all three workspaces (`tsc --build`). |
| `yarn start` | Runs the bot. `investing-bot` sources run through ts-node. `tx/` and `logger/` are consumed from `dist/`, so changes there need a rebuild; changes under `investing-bot/src/` only need a restart. |
| `yarn dry-run` | `yarn start` with `PROFILE=local ALLOCATION_DRY_RUN=true`. |
| `yarn cli danger …` | Blacklist management. |
| `yarn cli print-rebalance-strategies` | Prints the valid strategy names. |

The repo is three workspaces plus three example files:

```
investing-bot/     the bot: loops, strategies, danger detection, CLI
tx/                transaction building, sending, RPC pool, priority fees
logger/            structured logging
.env.example                        config template  →  copy to .env.<PROFILE>
allocation_config_example.json      strategy config  →  copy, point ALLOCATION_CONFIG_PATH at it
danger_blacklist_example.json       blacklist format →  DANGER_BLACKLIST_PATH file
```

See [`danger_triggers_catalog.md`](./investing-bot/src/danger/danger_triggers_catalog.md) for the
authoritative risk, measurement, scoring curve and thresholds of each implemented and planned trigger.

## What will bite you

Read this section before the first live run. Everything here fails quietly or costs money, and none of
it is guessable from the config schema.

**Every address and number in this repo is an example.** The vault and reserve addresses, strategies,
thresholds and tuning values in the example files, and any hardcoded address in the source, are
illustrative placeholders showing the shape of a valid config. Nothing here is the configuration anyone
runs. Replace all of it.

**Relative paths resolve against `investing-bot/`, not the repo root, and the failure is silent.** Both
`yarn start` and `yarn cli` run inside that workspace, in the profile file and in a CLI `--path` alike.
That is why `.env.example` writes `../allocation_config.json` and `../danger_blacklist.json`, since
`../` *is* the repo root. A `./danger_blacklist.json` passed to the CLI lands in `investing-bot/`, where
the bot never looks. Only keypair paths are forgiving, because `readSecret` tries the path as given,
then relative to the working directory, then the workspace root. `ALLOCATION_CONFIG_PATH`,
`DANGER_BLACKLIST_PATH` and `--path` go straight to `fs`, so a wrong path means no file, and for the
blacklist an empty blacklist that silently enforces nothing. **Use absolute paths in any real
deployment.**

**Pre-add every reserve with the vault admin key.** The bot only updates allocations already in the
vault's `vault_allocation_strategy` and skips the rest, because the program lets `allocation_admin`
update an existing allocation but requires `vault_admin_authority` to insert one
(`WrongAdminOrAllocationAdmin`). Add every reserve the bot may allocate to before you start it;
afterwards it needs nothing but `allocation_admin`.

**Put the blacklist on a persistent volume.** The blacklist and the pending evacuations live in
`DANGER_BLACKLIST_PATH` and must survive restarts. Losing the file re-admits reserves the bot decided
were permanently compromised. With `NODE_ENV=production` the bot refuses to start unless the path is
set explicitly, since the default is container-ephemeral.

**Re-check `unallocated_weight` whenever you change a vault's strategy.** Weights are absolute and the
total differs by strategy: `EQUAL` writes 100,000 per reserve (300,000 total on a three-reserve vault),
`FIXED_WEIGHTS` writes exactly what the config says, and the max-yield family preserves the vault's
existing total. At `unallocated_weight = 0` only ratios matter, so this is invisible; at nonzero it is
not, because the same ratios at a 3× larger total shrink the uninvested share to roughly a third. No
config field expresses this coupling.

**`EQUAL`, `RANDOM` and `FIXED_WEIGHTS` are cap-unaware.** They emit weights verbatim with no bound
projection, so nothing stops them asking for more than a reserve can absorb or less than it can
release. The weights are written successfully and the mismatch surfaces later at the invest crank,
which under-fills or fails for that reserve. Worth knowing before pointing `FIXED_WEIGHTS` at a thin
reserve.

**Start in dry-run.** `ALLOCATION_DRY_RUN=true` for the first passes computes and logs everything and
sends nothing. Danger detection still evaluates and logs; no transaction is ever sent for a dry-run
vault.

Two more, on operating the thing: never commit secrets, since `.env.*` profiles hold RPC and KSwap API
keys and keypair files hold signing authority. And watch `/ready`, because a wedged loop shows up there
before it shows up in the logs.

## Process model

A health server starts before the loops when `SERVER=true` (default) on `SERVER_PORT` (default `8080`),
via [lightship](https://github.com/gajus/lightship), exposing `/health`, `/live` and `/ready`.
Readiness is driven by loop heartbeats: if any enabled loop goes silent for
`LOOP_HEARTBEAT_TIMEOUT_MS` (default `3 × RPC_REQUEST_TIMEOUT_MS`), the process reports not ready.
Point your orchestrator's readiness probe at `/ready` to catch a wedged loop.

The invest loop runs in the main thread's async context. The allocation loop runs in a worker thread
with a 4 GB heap cap, restarted up to 3 times on unexpected exit, with the counter resetting on any
heartbeat. After 3 failed restarts the loop is marked permanently unhealthy: readiness goes false and
the process needs an external restart. Both loops are wrapped in a retry harness, so a thrown error
inside a pass is logged and the loop re-enters rather than killing the process.

On `SIGINT`/`SIGTERM` the bot stops the health server, signals the worker, waits 5 s for it to finish,
then force-terminates; a hard exit follows after 10 s. The timezone is forced to UTC. Logs are JSON in
production (`NODE_ENV=production`) and colorized otherwise, with verbosity via `LOG_LEVEL` (default
`info`) plus `VERBOSE=true` for per-allocation detail.

## How the invest loop works

Every `LOOP_INTERVAL_MS` the loop resolves its vault set, tops up crank funds, then decides per vault
whether to send an invest crank.

The vault set is the union of `INVEST_VAULTS` (explicit pubkeys), all vaults owned by `INVEST_OWNERS`,
and, when `INVEST_UI_VAULTS=true`, every vault in Kamino's public resources feed. With none of the three
set, it invests **every** vault on-chain. The set is re-resolved every pass, so a new vault under a
configured owner is picked up automatically.

Crank funding exists because the `invest` instruction reconciles cToken↔liquidity rounding with a
top-up of at most a few base units, drawn first from the vault's own `available_crank_funds`, then from
the crank payer's token account. So the signer needs a token account per vault mint with a small
balance; the bot keeps 10 base units per vault holding that mint as the buffer. Missing amounts come
from a KSwap exact-out swap from WSOL, or a plain SOL wrap when the vault token *is* WSOL, with missing
ATAs created first. Each swap is guarded twice over, by `DEFAULT_SWAP_SLIPPAGE_BPS` on the route itself
and by an independent reference-price bound (`DEFAULT_PRICE_SLIPPAGE_BPS`) against fresh KSwap prices,
plus pre/post balance assertions. If reference prices are missing or older than
`MARKET_PRICE_MAX_AGE_SECONDS` the funding swap is skipped rather than executed blind, and the pass
continues with existing balances.

A vault is cranked only when both an amount and a time condition hold. The amount condition is that the
summed positive gap between the vault's target allocation (derived from on-chain weights) and its
current per-reserve holdings exceeds `MIN_INVEST_TOKENS`; only positive gaps count, so a pure reshuffle
is not double-counted, and when a vault has no reserves or all weights are zero the whole invested
balance counts as the gap. The time condition is that at least `MIN_SECONDS_SINCE_LAST_INVEST` worth of
slots have passed since the vault's most recent `last_invest_slot` across all its reserves, and that the
vault's on-chain `min_invest_delay_slots` has elapsed.

One vault address is hardcoded to bypass the `MIN_SECONDS_SINCE_LAST_INVEST` check:
`CONFIG_MIN_SLOT_BYPASS_VAULT` in `investing_loop.ts`, currently
`4TwKA9JXEGeLEpAPLoarhSQoQwoiu12dkDCjSuVvHQUf`. That is an example value, not a vault this bot is run
against, and it only has an effect if that address is in your invest set.

Both checks are off-chain heuristics layered on the program's own gates, which are stricter in two ways:
the delay is enforced per reserve (`last_invest_slot + min_invest_delay_slots`, else `InvestTooSoon`),
and each move must exceed the vault's `min_invest_amount`, else `InvestAmountBelowMinimum`. The one
exemption is an uncapped full evacuation of a `weight == 0` reserve, always allowed to go to zero, so a
danger pull-out is never blocked by the minimum-amount floor.

A vault is skipped when a withdrawal it needs exceeds the source reserve's available liquidity and there
is not enough idle balance to make the move worthwhile, since cranking would just fail on-chain. It is
also skipped when the danger layer has unfinished business with it: the loop reads the blacklist file,
both its blacklisted reserves and its per-vault pending evacuations, and refuses to invest a vault still
holding exposure to a blacklisted reserve or with an evacuation in flight, since investing there would
push funds back into a reserve the bot is trying to leave.

Instructions are sent in batches of 2 (invest) or 4 (ATA creation), preserving SDK order so disinvests
land before the matching invests.

## How rebalancing works

One pass batch-fetches every configured vault and all of their reserves, sleeping 10 s and retrying on a
partial fetch, because it never rebalances on incomplete state. Danger detection then runs over every
vault, producing a per-vault directive: either skip, when the vault was just responded to, or rebalance
with a given set of exclusions. A thrown error or timeout anywhere in the danger pass skips the whole
iteration, failing closed rather than falling through to a normal rebalance.

Next it fetches farm states and prices for every reserve supply farm and reward mint, but only for
vaults with `includeReservesSupplyFarmRewardsApy` on, plus every vault token. Then, per vault, if its
rebalance frequency has elapsed, it computes the new weights with that vault's strategy, sends the
allocation updates in batches of 2 with the vault's LUT when it has one, waits 5 s, reloads state and
sends an invest crank so the funds follow the new weights. Finally it sleeps for the smallest
`rebalanceFrequencySeconds` across the whole config and repeats.

The loop's sleep is that config-wide minimum, but each vault additionally checks its own
`rebalanceFrequencySeconds` before acting. Restarts reset the per-vault timers, so a restart triggers a
rebalance on the next pass unless the chain rejects it. Dry-run vaults are evaluated every pass
regardless of frequency, since nothing is sent and so there is nothing to rate-limit.

Failures are contained per vault. If weight computation throws, the loop falls back to sending only that
vault's blacklist-enforcement instructions, force-zeroing dangerous reserves rather than skipping safety
work; if even that fails, the vault is skipped and the others continue. Danger is scoped per vault, so
one persistently dangerous vault never stalls the fleet.

### What lands on-chain

Every strategy ultimately emits one `update_reserve_allocation` per changed reserve, carrying a
`target_allocation_weight` and a token `allocation_cap`.

The vault takes its cut before the reserves. The program computes the unallocated share from
`unallocated_weight / (unallocated_weight + Σ reserve weights)`, bounded by `unallocated_tokens_cap`,
then splits the remainder across reserves by weight. The bot never writes `unallocated_weight`, since
the vault admin owns it, so raising it proportionally lowers everything the bot's weights control.

Caps are preserved rather than managed. The bot re-sends each reserve's existing `token_allocation_cap`
unchanged, including through a danger pull-out, which zeroes the weight and leaves the cap intact, and
it uses the v1 instruction, preserving whatever `ctoken_allocation_cap` is already set. Both caps stay
the vault admin's tool; treat them as a hard ceiling the bot cannot exceed.

Reserve whitelists gate increases only. Under `allow_allocations_in_whitelisted_reserves_only`, raising
a weight or cap on a reserve with no add-allocation whitelist entry fails with `ReserveNotWhitelisted`;
under `allow_invest_in_whitelisted_reserves_only`, the same applies to an invest that adds liquidity.
Lowering a weight, and any invest that withdraws, are never gated, so a pull-out always goes through and
a whitelist misconfiguration can only stall growth, not an exit.

### The rebalance universe

Before any strategy runs, the vault's reserves are split three ways. **Healthy** reserves are the only
ones a strategy may optimize over. **Blacklisted** reserves are permanently excluded and force-zeroed
on-chain via explicit instructions. **Cooldown** reserves are excluded from receiving new allocation but
not force-zeroed, so an existing position is left where it is.

All weight math, including drip rates, grid budgets and totals, happens on the healthy-universe scale,
so a force-zeroed reserve cannot distort it.

Which strategy runs, how the max-yield grid search works, and the `MAX_YIELD_DRIPPING` drip and
dead-band rules are in [`docs/configuration.md`](./docs/configuration.md#strategies).

## Danger detection and the pull-out mechanism

Before each rebalance iteration, the bot scores every reserve of every configured vault
(`investing-bot/src/danger/`). Each trigger returns a safety score in `[0, 1]`, and a reserve's scores
multiply into one combined safety score, so several mild red flags compound into a pull-out that none of
them would cause alone. When a reserve's combined score falls below the vault's risk-appetite threshold
(`PARANOID` 0.5, `SENSIBLE` 0.3 by default, `YOLO` 0.1), the bot emergency-deinvests from it and forces
its weight to zero in one shot, never stepped down gradually and never dripped. The full trigger list
and per-appetite thresholds are in
[`docs/configuration.md`](./docs/configuration.md#danger-trigger-catalog).

For each dangerous reserve the bot builds an allocation update setting weight `0` while preserving the
configured allocation cap, skipping reserves already at zero. It sends those zeroing instructions in
batches of 2 with the vault's LUT, and sends them even if simulation fails, because a pull-out must not
be blocked by a flaky simulation. It then waits 5 s, reloads vault state, sends a full deinvest crank,
and reloads state again so completion is judged against post-deinvest balances. The vault is marked skip
for this rebalance pass, enforced by the type system: a responded-to vault carries no rebalance
parameters at all, so it structurally cannot be re-exposed in the same pass.

If exposure remains afterwards, say because the reserve had no liquidity to withdraw, it is recorded as
a pending evacuation for that vault in the `pendingEvacuations` array of the same
`DANGER_BLACKLIST_PATH` file, so it survives a restart and is visible to both loops. Pending evacuations
are retried every pass, block the invest loop from touching that vault, clear automatically once the
exposure reaches zero, and are logged as needing operator intervention while they persist.

Where the reserve lands afterwards depends on why it was flagged. A **catastrophic** flag means
irreversible loss of funds, from an infinite mint or a collateral exchange-rate increase, and the
reserve goes on the permanent blacklist persisted to `DANGER_BLACKLIST_PATH`. On every later iteration
it is excluded from every strategy's optimization universe and its on-chain weight is kept force-zeroed.
It leaves only by manual operator action; there is no auto-expiry. A **transient or market** flag,
covering oracle divergence, thin exit liquidity, elevated supply APY, utilization squeeze and depeg,
puts the reserve in a reinvest cooldown for 3 passes: excluded from receiving new allocation, but its
existing position is left untouched and never force-zeroed. That stops a reserve which flaps in and out
of danger from thrashing pull-out → reinvest → pull-out. Cooldowns are in-memory and reset on restart.

Danger is scoped per vault, so only a vault just responded to skips its rebalance this iteration. Every
other vault rebalances normally, with blacklisted reserves force-zeroed and cooldown reserves excluded
from new allocation.

### Fail-closed guarantees

Bad or missing data never reads as "safe". Every reserve needs a positive market price no older than
`MARKET_PRICE_MAX_AGE_SECONDS` (default 300), and missing, stale, malformed or failed trigger data
freezes that allocation iteration rather than triggering either a blind rebalance or a blind mass
withdrawal. A danger-pass error or timeout skips the rebalance and retries; the detector lives outside
the loop, so its in-memory trigger baselines survive a transient failure and the catastrophic triggers
are not blinded on the next pass.

A corrupt or structurally invalid blacklist file makes every danger pass throw, so no rebalance runs.
The loop retries indefinitely rather than halting the process, so fix the file. The peg feed
(`https://tokens.kamino.finance/tokens-flags.json`) is fetched once per pass, and an outage reuses the
last good snapshot while a cold start with no snapshot at all fails the pass closed. A vault marked
dry-run, globally or per entry or per vault, is detected and logged only and never receives real
emergency transactions; catastrophic observations seen only by a dry-run vault stay staged rather than
being committed as a new baseline.

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

Clearing a reserve is the operator saying "this was a false positive, or the cause is resolved". The bot
starts allocating to it again on the next pass, subject to the triggers re-scoring it.

The CLI covers `blacklistedReserves` only: `list` does not print pending evacuations, and neither
`clear-reserve` nor `clear-all` removes them. A pending evacuation normally clears itself once the
exposure is out. One stuck because the reserve genuinely cannot be exited has to be edited out by hand,
and only after deciding the exposure is acceptable. While it is listed, the invest loop leaves that
vault alone.

## Tuning

Grid resolution is the main cost knob. If the allocation worker approaches its 4 GB heap cap or passes
get slow, raise `GRID_SEARCH_RESOLUTION` before anything else. Rolling a new strategy or a new vault out
under `allocationDryRun` first lets it run in observation mode, with danger detection still evaluating
and logging but no transaction ever sent for that vault.
