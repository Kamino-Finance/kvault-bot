# Configuration details

Use the generated [environment settings](../README.md#environment-settings) and [allocation fields](../README.md#allocation-fields) for defaults, units, and validation.
Use the [quick start](../README.md#quick-start) for profiles, paths, signers, and dry-run operation.

## Allocation file

The file contains an `allocationsConfig` array. Each entry contains a strategy and a `vaults` array.
A vault can be an address string or an object with its own settings.
Replace the placeholders in this structural example before use.

```json
{
  "allocationsConfig": [
    {
      "strategy": "MAX_YIELD_DRIPPING",
      "vaults": [
        {
          "vault": "<vaultAddress>",
          "drippingRatePercent": 10,
          "allocationDryRun": true
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

Strategy fields use the vault-object value before the entry value.
`rebalanceFrequencySeconds` is an exception: an entry value overrides the vault-object value.
For object vaults, `allocationDryRun` defaults to `false`, regardless of the entry's value.
`ALLOCATION_DRY_RUN=true` forces allocation dry-run for every vault. It does not disable the independent invest loop.

The loader rejects invalid strategies, addresses, duplicates, frequencies, flags, rates, and basis-point ranges.
It ignores an entry with an empty vault array and logs a warning.
Before a rebalance, it checks that fixed reserves belong to the vault's on-chain allocation list.
The allocation loop loads the file at startup. Restart it after changes.

## Strategies

See the generated [strategy table](../README.md#strategies) for available names.

`EQUAL` targets equal shares. `FIXED_WEIGHTS` reads configured weights as relative shares.
For example, weights `1` and `3` target 25% and 75% of the active reserve weight total.
`FIXED_WEIGHTS` must list every healthy reserve. A missing reserve keeps current weights and logs an error.
`RANDOM` is for testing.

The bot scales these targets to the vault's current reserve weight total.
It preserves the idle share controlled by `unallocated_weight` and leaves excluded reserves' weights unchanged.
With zero unallocated weight, it can raise a small weight total by an integer factor to reduce rounding error.
These three strategies bypass reserve capacity projection. Their target can exceed available deposit or withdrawal capacity.
On-chain caps still apply, so a later invest can underfill or fail.

The max-yield family uses current reserve state to bound deposits and withdrawals.
Deposit ceilings round down. Withdrawal floors round up.
The final projection preserves the selected integer weight total and checks the projected token targets.
An infeasible result keeps the allocation unchanged or blocks normal investment when the current target is unsafe.
Danger enforcement can still zero blacklisted reserves.

`MAX_YIELD_WITH_FIXED_RESERVES` and `MAX_YIELD_STABLE` accept `fixedReserves` and `reservesAllocationPercentageBPS` as search floors.
Final capacity constraints can change the search target. The floor is not an unconditional final allocation guarantee.
A plain vault address supplies no fixed-reserve set.
`fixedReservesStrategy` is validated metadata and does not select another optimizer.

### Search limits

Max-yield strategies search a coarse grid, then refine promising regions.
The optimizer can increase the requested `GRID_SEARCH_RESOLUTION` for wide vaults to limit search size.
Farm rewards contribute when enabled and when farm states and reward prices load successfully.
A vault that requires unavailable farm data skips its normal rebalance for that pass.

`GRID_SEARCH_MAX_CANDIDATES` and `GRID_SEARCH_MAX_MS` bound each vault's search across all phases.
Each generated point and each evaluation counts. Overlapping regions can count a point more than once.
Reaching either limit keeps the current allocation for that pass.
Raise `GRID_SEARCH_RESOLUTION` to reduce resource use before increasing these limits.
The worker's old-generation heap limit is 4 GB, independent of the main process's `NODE_OPTIONS`.

### Drift

`driftRatePercent` applies to strategies that support drift, except `MAX_YIELD_DRIPPING`.
When absent, the strategy applies its target immediately.
When present, it moves that percentage of the current-to-target weight gap per due rebalance.
The calculation normalizes target shares and rounds the vector while preserving its total.
`UNCHANGED` does not support drift.

`MAX_YIELD_DRIPPING` uses `drippingRatePercent`, which defaults to 20%.
It rejects `driftRatePercent`, including an inherited entry value when a vault overrides its strategy.
With `enforceUtilizationCap=false`, it drifts from configured weights.
With that cap enabled, it starts from actual token holdings and checks the final projected movement.
The default limit is 100 basis points of utilization change per reserve.
Final constraints and normal invest instructions recheck the utilization policy.
Separate investing processes must read the same allocation file to enforce it.

Drift does not initialize a vault whose healthy weight total is zero.
Small target gaps below the rounding and optimizer noise limits emit no weight updates.
Danger evacuation is immediate and does not use drift.
`MAX_YIELD_DRIPPING` ignores fixed-reserve floors.

## Danger configuration

`riskAppetiteMode` selects the combined safety-score threshold for each allocation entry.
`maxVaultDominanceBps` adds a hard dominance limit at either entry or vault level.
`DANGER_PASS_INTERVAL_SECONDS` controls the maximum sleep between danger passes, rather than a real-time deadline.
Network calls, search, and transaction confirmation add to the elapsed time.

Read the [danger catalog](../investing-bot/src/danger/danger_triggers_catalog.md) for every implemented check, threshold, recovery rule, and coverage limit.
Scope freshness and market collateral checks require no separate reserve or collateral list.
Keep their persistent safety file intact across deployments.
