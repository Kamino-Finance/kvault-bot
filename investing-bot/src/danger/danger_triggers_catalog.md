# Danger Triggers Catalog

## Catastrophic — Binary events requiring immediate pullout

These are "it happened or it didn't" signals. When they fire, the reserve is compromised.

### Infinite Mint (implemented)
**Risk**: Token supply grows abnormally, indicating someone is minting tokens out of thin air.
**How to measure**: `fetchMint(rpc, mintAddress)` — track supply across iterations, trigger if supply increases >50% between checks.
**Safety score**: Binary. Below threshold → 1.0. Above threshold → 0.0.

### Exchange Rate Anomaly (implemented)
**Risk**: The SDK rate is cTokens per liquidity token. It normally stays flat or decreases as interest grows the liquidity backing; an increase above the 0.1% tolerance indicates lost backing.
**How to measure**: `reserve.getEstimatedCollateralExchangeRate(slot, 0)`, plus a direct check for cTokens outstanding with zero liquidity. Track across iterations and trigger on an increase above tolerance.
**Safety score**: Binary. Rate stable/decreasing → 1.0. An anomalous increase or zero backing → 0.0.

---

## Slippery Slope — Potentially catastrophic, but gradual

These worsen over time or with magnitude. They can independently trigger pullout if severe enough.

### Supply APY Spike (implemented, transient)
**Risk**: Supply APY above a sane ceiling indicates rate model manipulation, oracle issues, or an exploited reserve inflating apparent yields.
**How to measure**: `reserve.totalSupplyAPY(currentLedgerInstant)`. Hard threshold: 20%.
**Safety score**: Binary. APY ≤ 20% → 1.0. APY > 20% → 0.0. This causes an emergency pullout and cooldown, not a permanent blacklist.

### Insufficient Exit Liquidity (implemented)
**Risk**: The reserve's available liquidity drops below a threshold relative to the vault's position, meaning the vault cannot fully exit if needed.
**How to measure**: Compare `reserve.getLiquidityAvailableAmount()` against `vaultHoldings.investedInReserves.get(reserve)`.
**Safety score**: Graduated. `ratio = availableLiquidity / vaultInvested`. Score = `clamp((ratio - 0.3) / 0.7, 0, 1)`. At 100% coverage → 1.0. At 65% → 0.5. At 30% or below → 0.0 (forces pullout for any risk appetite).

### Oracle Price vs Market Price Divergence (Depeg) (implemented)
**Risk**: The on-chain oracle price diverges from the market price (Kamino API), indicating a depeg or oracle manipulation.
**How to measure**: Compare `reserve.tokenOraclePrice.price` against `getTokensBatchPrice()` result. Compute `divergencePercent = abs(oracle - market) / market * 100`.
**Safety score**: Graduated, sqrt decay. Below 2% → 1.0. Formula: `divergence <= 2 ? 1.0 : max(0, 1 - sqrt((divergence - 2) / 8))`. At 5% → ~0.39. At 7% → ~0.21. At 10%+ → 0 (forces pullout for any risk appetite). Tight thresholds — even 5% divergence is unusual when both price sources are healthy.

### Secondary Market Depeg (implemented)
**Risk**: The token loses its peg (e.g. USDC losing its dollar peg, an LST trading below the SOL backing it). This is the depeg the oracle-divergence trigger cannot see: when a peg genuinely breaks, the on-chain oracle tracks the market down with it, so the two prices agree while both sit well off the peg.

**Which tokens have a peg is not guessed.** It comes from Kamino's token-flags feed (`https://tokens.kamino.finance/tokens-flags.json`, fetched once per pass into `TriggerContext.tokenFlags`):
- `stablecoin` tag → $1 peg, minus `NON_USD_STABLECOIN_SYMBOLS`. That exclusion list is load-bearing: the tag also covers non-USD currencies (EURC, EURCV, EUROE, EUROP, vEUR, VGBP, vCHF) and yield-bearing wrappers (syrupUSDC, sUSD, hyUSD, deJTRSY, …) that are *not* worth a dollar. Applying $1 to those would pull out on every pass forever. Excluded tokens keep oracle-divergence and are logged once so the gap is visible.
- `lst` tag → par with the WSOL market price. No exclusions needed: an LST is redeemable for at least the SOL that minted it, by construction.
- Neither tag → scored 1.0. An explicit per-mint override exists for tests and one-off pegs.

**How to measure**: a $1 stablecoin is checked against **both** price sources — the KSwap market price and the reserve's on-chain oracle — and scored on whichever diverges further from $1, **in either direction** (a hard peg is symmetric). An LST is checked one-sided against par, since trading above par is normal for a token accruing rewards. A feed outage reuses the last good snapshot; a cold start with no snapshot fails the pass closed.

**Safety score**: Graduated, sqrt decay over basis points.
- $1 stablecoins: ≤50 bps → 1.0, decaying to 0 at 200 bps. Pull-out at ~88 bps (PARANOID), ~124 bps (SENSIBLE), ~172 bps (YOLO) — i.e. the ~100 bps target, tightening with risk appetite.
- LSTs: ≤100 bps discount → 1.0, decaying to 0 at 1000 bps.

**Diagnostic**: a token trading outside 0.5x–2x of its peg target is reported once as a probable misclassification. Advisory only — the score is never relaxed, because an implausibly low reading is indistinguishable from a total depeg.

**Known limit**: the LST floor is par, not the stake pool's real (higher) redemption rate, so it catches an LST discounted below its SOL backing but not a milder discount to redemption value. Pricing the stake pool's exchange rate would close it fully.

### Market Utilization (implemented)
**Risk**: The reserve's utilization leaves no room to withdraw. Utilization is borrowed / supplied, so the un-borrowed remainder is what any depositor can actually exit with; at 100% the vault cannot leave until borrowers repay.
**How to measure**: `reserve.getEstimatedUtilizationRatio(slot, 0)` — slot-aware, since interest accrued since the last on-chain refresh moves both sides of the ratio.
**Safety score**: Graduated, linear. 1.0 at or below the 90% safe threshold, decaying to 0.0 at 100%. At 95% → 0.5. At 97% → 0.3. At 99% → 0.1. Reserve-intrinsic and vault-size independent — exit liquidity scores the same squeeze relative to one vault's position, and the two compound.

### Token DEX Liquidity Drying Up (not implemented)
**Risk**: The token's DEX pool depth drops, meaning the vault would face severe slippage trying to exit via swaps.
**How to measure**: Jupiter quote API — request a quote for a vault-sized swap amount and check the price impact.
**Safety score**: Graduated. Formula: `impact <= 1 ? 1.0 : clamp(1 - (impact - 1) / 15, 0.1, 1.0)`. At 5% impact → 0.5. At 15%+ → 0.1.

---

## Red Flags — Risk multipliers that compound with other signals

These never justify pullout on their own, even in the worst case. They make other signals worse.

### Vault Is Dominant Depositor (implemented)
**Risk**: The vault's deposit is a large fraction of the reserve's total supply. If the vault exits, it could cause a liquidity spiral.
**How to measure**: `vaultHoldings.investedInReserves.get(reserve) / reserve.getEstimatedTotalSupply(slot, 0)`.
**Safety score**: Graduated, piecewise linear, skewed so above 50% gets dangerous fast. ≤10% → 1.0 (safe). 10%→50% mild decay 1.0→0.7. 50%→90% steeper decay 0.7→0.3. ≥90% → 0.3 (floor). Sample: 30%→0.85, 50%→0.7, 70%→0.5, 90%→0.3. Floor 0.3 sits at the SENSIBLE threshold — never triggers SENSIBLE/YOLO pullout alone. PARANOID (0.5) can pull out alone above 70% dominance.
**Configurable hard threshold**: `maxVaultDominanceBps`, set per allocation or per vault (the per-vault value wins), is the dominance at or above which the score is 0 — an emergency pull-out at any risk appetite. It is a step, not a rescaled curve: "leave above 60%" means exactly that, and the graduated red-flag score still compounds with the other triggers everywhere below it. Unset by default, so existing vaults keep the graduated behaviour above.

### Deposit/Withdrawal Cap Saturation (not implemented)
**Risk**: The reserve's deposit/withdrawal cap is fully consumed, preventing the vault from moving funds.
**How to measure**: Compare `reserve.getDepositWithdrawalCapCurrent(slot)` vs `reserve.getDepositWithdrawalCapCapacity()`.
**Safety score**: Graduated. `remaining = 1 - (current / capacity)`. Score = `clamp(remaining * 2, 0.1, 1.0)`. At 50%+ remaining → 1.0. At 25% → 0.5. At 5% → 0.1. Cap resets periodically, so floor 0.1.

### Abnormal Borrow Spike (not implemented)
**Risk**: Borrowed amount spikes dramatically, could precede an exploit.
**How to measure**: Track `reserve.getBorrowedAmount()` across iterations.
**Safety score**: Graduated. Formula: `increasePercent <= 50 ? 1.0 : clamp(1 - (increasePercent - 50) / 500, 0.3, 1.0)`. At 100% increase → 0.7. At 300% → 0.4. Floor 0.3 — legitimate demand can cause spikes.

### Oracle Price Stale (not implemented as a separate trigger)
**Risk**: The oracle price hasn't updated recently, may not reflect current market conditions.
**How to measure**: Track `reserve.tokenOraclePrice.price` across iterations, count consecutive unchanged readings.
**Safety score**: Graduated. Formula: `staleCount <= 1 ? 1.0 : clamp(1 - (staleCount - 1) * 0.15, 0.3, 1.0)`. At 3 iterations stale → 0.7. At 5+ → 0.4. Floor 0.3.

### Protocol Governance Attack (not implemented)
**Risk**: The lending protocol's admin makes a suspicious parameter change.
**How to measure**: Track `reserve.state.config` fields across iterations, trigger on unexpected changes.
**Safety score**: Critical param change → 0.1. Non-critical → 0.5. No change → 1.0. Hard to distinguish legitimate governance from attacks — floor at 0.1 keeps it as a strong multiplier but not a standalone trigger.

---

## Priority Matrix

| Priority | Trigger | Category | Score Range | Alone Triggers Pullout? |
|----------|---------|----------|-------------|------------------------|
| 1 | Infinite Mint ✅ | Catastrophic | 0 or 1 | Yes |
| 2 | Exchange Rate Anomaly ✅ | Catastrophic | 0 or 1 | Yes |
| 3 | Supply APY Spike ✅ | Slippery Slope | 0 or 1 | Yes at >20% APY |
| 4 | Insufficient Exit Liquidity ✅ | Slippery Slope | 0 – 1.0 | PARANOID <65%; SENSIBLE <51%; YOLO <37% coverage |
| 5 | Oracle vs Market Divergence ✅ | Slippery Slope | 0 – 1.0 | PARANOID >4%; SENSIBLE >5.92%; YOLO >8.48% |
| 6 | Secondary Market Depeg ✅ | Slippery Slope | 0 – 1.0 | $1: PARANOID >88bps; SENSIBLE >124bps; YOLO >172bps. LST: >3.25%/5.41%/8.29% discount |
| 7 | Market Utilization ✅ | Slippery Slope | 0 – 1.0 | PARANOID >95%; SENSIBLE >97%; YOLO >99% utilization |
| 8 | DEX Liquidity Drying Up | Not implemented | — | — |
| 9 | Vault Is Dominant Depositor ✅ | Red Flag | 0 – 1.0 | PARANOID above 70%; any appetite at/above `maxVaultDominanceBps` when configured |
| 10 | Deposit/Withdrawal Cap Sat. | Not implemented | — | — |
| 11 | Abnormal Borrow Spike | Not implemented | — | — |
| 12 | Oracle Price Stale | Not implemented separately | — | Invalid SDK oracle prices fail closed in the divergence trigger |
| 13 | Protocol Governance Attack | Not implemented | — | — |

**Catastrophic** triggers fire rarely but demand immediate action. **Slippery Slope** triggers can independently cause pullout if severe, and get worse over time. **Red Flags** only matter in combination — they make everything else worse but are never the sole reason to pull out.
