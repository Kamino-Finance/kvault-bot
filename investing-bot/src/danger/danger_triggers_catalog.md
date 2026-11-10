# Danger detection

Each allocation pass checks the configured vaults' reserves and collateral in their lending markets before it rebalances.
The invest loop skips vaults with pending evacuations or blacklisted exposure. In the same process, it also blocks
deposits using the allocation loop's last published exclusions.

## How a reserve is scored

Each trigger returns a safety score in `[0, 1]`. A non-finite or non-positive score counts as 0, and a score above 1 as 1.
The scores of a reserve multiply. The reserve is dangerous for a vault when the product is **strictly below** the
threshold of the entry's `riskAppetiteMode`:

| `riskAppetiteMode` | Threshold | Meaning |
| --- | ---: | --- |
| `PARANOID` | 0.5 | Pulls out earlier. |
| `SENSIBLE` | 0.3 | Default. |
| `YOLO` | 0.1 | Pulls out only on severe danger. |

Seven triggers score the reserve itself: infinite mint, exchange-rate anomaly, supply APY spike, oracle divergence, stale
Scope price, secondary-market depeg and market utilization. Two score the vault's position in it: exit liquidity and
dominant depositor. [Market collateral](#market-collateral) adds its shared-check scores. The vault triggers are skipped
when the combined reserve score is already 0.

Between passes, the loop waits for the smallest of `DANGER_PASS_INTERVAL_SECONDS` (300 s by default), the smallest
`rebalanceFrequencySeconds`, and the next KaminoManager refresh. The time a pass takes adds to the gap.

## Triggers

### Catastrophic: one event pulls out and blacklists

**Infinite mint.** A mint supply increase above 50% between observations scores 0. The first observation sets a baseline
per reserve. Baselines expire after 24 h and clear on restart, so the next observation sets a new baseline.

**Exchange-rate anomaly.** The SDK rate is cTokens per liquidity token; it normally stays flat or falls as interest
accrues. A rise above the 0.1% tolerance, or cTokens outstanding with zero liquidity behind them, scores 0.

### Gradual: a severe reading pulls out alone

**Supply APY spike.** Supply APY above 20% scores 0 (rate model manipulation, an oracle problem or an exploit).

**Insufficient exit liquidity** (vault trigger). `ratio = available liquidity / vault position`; score
`clamp((ratio - 0.3) / 0.7, 0, 1)`: 1.0 at full coverage, 0.5 at 65%, 0 at 30% or less.

**Oracle divergence.** Compares the on-chain oracle price with the KSwap market price.
`divergence <= 2% ? 1 : max(0, 1 - sqrt((divergence - 2) / 8))`: about 0.39 at 5%, 0 from 10%. The check pauses while the
Scope price is zero or near zero; the stale-price trigger scores that case.

**Stale, zero or near-zero Scope price.** Reads the oldest publish time in the raw spot chain and any enabled TWAP chain.
A component at its reserve's `maxAgePriceSeconds` or `maxAgeTwapSeconds` limit blocks new funds immediately.

An exact zero, or a price **below one millionth of the KSwap market price**, also blocks new funds immediately. Both
prices are in USD. For example, Scope at `0.0000001` USD against a `1` USD market price is near zero.

Zero and near-zero prices use their publish age. A continuously refreshed zero blocks deposits without triggering
evacuation merely because it persists. Oracle divergence stays paused and secondary depeg drops its oracle leg. Checks
that do not read the Scope price stay active. Market collateral also ages a zero by its duration; see
[Market collateral](#market-collateral).
A reserve without a valid Scope price chain receives no Scope age check.

Let `L = MAX_STALE_PRICE_DURATION_SECONDS` (3,600 s by default). This check alone has the following effect:

| Publish age | Score | Risk modes that exit |
| --- | ---: | --- |
| Through L | 1 | None |
| Past L, through 2L | 0.4 | PARANOID |
| Past 2L, through 4L | 0.2 | PARANOID, SENSIBLE |
| Past 4L | 0 | All |

**Secondary-market depeg.** Catches a broken peg that the oracle follows. Pegs come from Kamino's token-flags feed: the
`stablecoin` tag means a $1 peg, except the non-USD and yield-bearing tokens in `NON_USD_STABLECOIN_SYMBOLS`; the `lst` tag
means par with SOL. A $1 stablecoin is scored on whichever of the market and oracle prices is further from $1, in either
direction: 1.0 up to 50 bps, 0 at 200 bps (pull-out at about 88/124/172 bps for PARANOID/SENSIBLE/YOLO). A zero Scope price
drops only the oracle leg. An LST is scored one-sided on its discount: 1.0 up to 100 bps, 0 at 1000 bps. A feed outage
reuses the last snapshot; with no snapshot the pass fails. Limit: the LST floor is par, not the stake pool's higher
redemption rate.

**Market utilization.** Borrowed over supplied, slot-aware. 1.0 up to 90%, then linear to 0 at 100%: 0.5 at 95%, 0.1 at
99%.

### Red flag: compounds with the others

**Dominant depositor** (vault trigger). The vault's share of the reserve's supply: 1.0 up to 10%, 0.7 at 50%, 0.3 from
90%. The 0.3 floor sits at the SENSIBLE threshold, so alone it pulls out only a PARANOID vault, above 70%.
`maxVaultDominanceBps` (per entry or vault) adds a hard step: at or above it the score is 0 for any risk appetite.

### Not covered

DEX liquidity of the token, deposit or withdrawal cap saturation, abnormal borrow spikes and governance changes have no
trigger. Chain-side caps are still applied by the allocation constraints.

## Market collateral

Collateral discovery is automatic for every lending market used by an allocated reserve. The bot includes a market
reserve when its config has positive loan-to-value or a nonzero elevation group. Status alone does not exclude it,
including Hidden reserves. This is a market-wide eligibility scan, not a trace of current borrower positions or
individual elevation-group loan pairs.

Allocated reserves and this collateral share three checks and their limits. For live vaults:

| Shared check | Effect on each reached allocated reserve |
| --- | --- |
| Infinite mint | The bot blacklists the reached allocated reserve address and starts evacuation. |
| Stale Scope price | New funds stop at the reserve's age limit; its score then falls at the shared L/2L/4L thresholds. |
| Zero or near-zero Scope price | New funds stop immediately; the same thresholds apply to its effective age. |

For collateral, the effective age of a zero or near-zero price is the greater of its publish age and its observed zero
duration. A normal value ends the zero clock; failed passes preserve it. Removing Scope pricing or restarting the
process also clears the clock.

Each collateral's scores contribute to every allocated reserve of the same market, except its own entry. An allocated
reserve already receives its own checks. Other reserve and vault checks remain specific to the allocated reserve.
The combined score uses each vault entry's `riskAppetiteMode`.

For example, an infinite mint in ONRE collateral blacklists the USDC and SOL reserve addresses of a live vault in that market.
A stale or zero ONRE price gives both reserves no new funds, then causes evacuation when their risk threshold is crossed.
Each market is assessed separately, including when a mint is present in more than one market.

No separate collateral list or settings are required. Use `MAX_STALE_PRICE_DURATION_SECONDS` for the shared exit age and
`MARKET_PRICE_MAX_AGE_SECONDS` for the KSwap reference age (300 s by default). The reserve's own Scope age limits remain
separate. See the generated [environment settings](../../../README.md#environment-settings) for all defaults and units.

## Failed reads and recovery

Allocated and collateral mints require fresh, finite, positive KSwap prices. The pass requests the mints without one
again after 1 s and after 2 s. If a price is still missing, stale, invalid or unavailable, the pass assesses no vault. A
missing reference never turns a near-zero Scope price into a healthy reading or ends a collateral zero clock.

| Failure | Allocation-loop behavior |
| --- | --- |
| Market reserve list, collateral observation or collateral check is unreadable | Reached allocated reserves get no new funds for this pass; this failure alone causes no evacuation. |
| A required KSwap price is invalid or unavailable after two retries, a required batch RPC read or allocated-reserve trigger fails, or token flags have no usable snapshot | Assess no vault. Still retry each vault's pending evacuations, or else enforce the blacklist. |
| The ledger time cannot be read, or the pass times out | Abort the pass. |

A pass that assesses no vault counts as failed. It sends no normal rebalance, reconciles no deposit caps, and publishes
no replacement exclusion set. It moves no trigger observation, so it also preserves the collateral zero clocks. An
enabled invest loop keeps running with its last received exclusions and the persisted blacklist state. A later
successful pass can clear temporary price exclusions and restore caps; permanent blacklist entries require an operator
to clear them.

The danger-pass deadline is `max(vault count, 1) × RPC_REQUEST_TIMEOUT_MS × 4`. From the third consecutive failed pass,
the loop logs an escalation on every failure and the bot reports not ready. A configured vault that gets no assessment
for three passes in a row, for example because one of its reserves does not load, is logged on every pass while the
other vaults go on; readiness does not change for it.

If price reads fail:

1. Read the mint or market address and cause from the danger-detection error.
2. Check KSwap price availability and timestamps, or the reported RPC/Scope read failure.
3. Confirm a successful danger pass before expecting temporary exclusions or caps to recover.

## Response and state

For a live vault with a dangerous reserve the coordinator marks the vault as skipped for the pass, then:

1. Writes each catastrophic reserve to the permanent blacklist.
2. Starts the reinvest cooldown of each transient reserve: it gets no new funds for `REINVEST_COOLDOWN_SECONDS` (45 min
   by default). A flag on a reserve the vault does not hold starts the cooldown too.
3. Writes a pending evacuation for each transient (vault, reserve) pair.
4. Sets the reserve weights to zero in batches of two, keeping each allocation cap, waits 5 s and reloads the vault.
5. Withdraws only from the dangerous reserves whose reloaded weight is zero.

A pending evacuation clears only when the vault holds neither weight nor tokens in the reserve. Until then it is retried
on every pass, even after the trigger recovers, and it blocks the vault's strategy and the invest loop. A blacklisted
reserve is force-zeroed and withdrawn from on every pass while a vault still holds it, and it stays excluded until an
operator clears it. One rejected reserve does not stop the others: a failed batch is retried one reserve at a time.

Emergency sends broadcast even when their simulation fails, until a (vault, reserve) pair has three attributed failed
broadcasts; after that it is sent only when simulation passes. A confirmed send resets the count. A funding failure that
an earlier omitted withdrawal can explain is not counted. A failure of an instruction that the sender appends, such as
the Jito tip, is not counted against a reserve.

| State | Scope | Kept in | Ends when |
| --- | --- | --- | --- |
| Permanent blacklist | Reserve, all vaults | Blacklist file | An operator clears it |
| Pending evacuation | Vault and reserve | Blacklist file | The vault holds no weight and no tokens |
| Deposit freeze | Vault and reserve | Blacklist file and the on-chain cap | The reserve recovers and its cap is restored |
| Reinvest cooldown | Reserve, all vaults | Memory | `REINVEST_COOLDOWN_SECONDS` elapse, or a restart |
| Price/collateral exclusion | Reserve, one pass | Memory | A successful pass clears its cause |
| Reserve invest cooldown | Vault and reserve, per loop | Memory | `RESERVE_INVEST_COOLDOWN_MS` elapse, or a restart |
| Emergency failure count | Vault and reserve | Memory | A confirmed send, or a restart |
| Trigger baselines | Reserve | Memory | A restart; mint baselines also expire after 24 h |
| Zero clock | Reserve | Memory | A normal value, removal of Scope pricing, or a restart |

A reserve in reinvest cooldown or with a price/collateral exclusion gets **no new funds**. Its weight stays unchanged.
Both invest paths drop deposits into it and still allow withdrawals.

For live, non-skipped vaults, the allocation loop lowers frozen caps after withdrawals. It records each lower cap before
it sends it, and the lower cap becomes the frozen cap after it lands. Recovery restores the saved cap only when the
current cap equals the recorded frozen cap or a cap the bot sent that can still land. The bot saves each freeze or lower
cap before its transaction leaves the process, with that transaction's last valid block height. While such a send is
left, the bot ends no freeze: it does not restore the cap or keep an operator's cap. The entry clears after
confirmation. A cap that an operator changed, up or down, stays unchanged and its entry clears. Entries also clear when
reserves leave the vault. Failed updates retry next pass.

A dry-run vault only detects and logs: it sends nothing and writes no blacklist entry or pending evacuation.

The blacklist file (`DANGER_BLACKLIST_PATH`) is written under a lock with an atomic rename. A missing or blank file is an
empty blacklist when its directory exists. An unreadable or invalid file fails the danger pass and stops the invest pass.
`danger_blacklist_example.json` shows the format.

### Operator recovery

Run `yarn cli danger <command> --path <path>` against the bot's state file:

| Command | Effect |
| --- | --- |
| `list` | Shows permanent blacklists, pending evacuations and freeze journals. |
| `clear-reserve <address>` | Removes permanent entries for one reserve. |
| `clear-all` | Removes all permanent entries. |
| `init` | Creates the file only if absent. |

`--path` defaults to exported `DANGER_BLACKLIST_PATH`, then `./danger_blacklist.json`. The CLI loads no `.env` file.
Clear commands send no transactions and preserve pending evacuations, freeze journals and in-memory restrictions.
The bot reads edits on later passes without a restart. Successful assessments update temporary exclusions. Cooldowns
still follow their timers.

1. Inspect `list` and resolve the recorded causes.
2. Clear only recovered permanent entries. An active catastrophic trigger can blacklist a reserve again.
3. Keep the allocation loop running with dry run disabled for affected vaults. Verify completed evacuations and expected
   on-chain caps after successful passes.
