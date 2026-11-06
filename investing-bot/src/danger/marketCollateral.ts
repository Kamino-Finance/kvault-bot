import { getReserveStatesForMarket, KaminoReserve, Reserve } from '@kamino-finance/klend-sdk';
import { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import { logger } from 'kvaults-investing-bot-logger';
import { RPC_REQUEST_TIMEOUT_MS, withTimeout } from '../utils/timeout.js';
import { CollateralReserve, MarketCollateralAssessment } from './dangerTypes.js';
import { ScopeOracleObservation } from './scopeOracleMonitor.js';

/**
 * Market collateral backs borrowing in a vault reserve's lending market. Its danger affects vault reserves in that market.
 */

/** One pass's read of the market collateral of the vault reserves. */
export interface MarketCollateralSnapshot {
  /** The vault reserves of each market, keyed by market. */
  readonly vaultReservesOfMarket: ReadonlyMap<Address, readonly Address[]>;
  /** The collateral of each readable market that reaches at least one vault reserve, keyed by market and reserve. */
  readonly collateralByMarket: ReadonlyMap<Address, ReadonlyMap<Address, CollateralReserve>>;
  /** The markets whose reserves could not be read this pass. */
  readonly unreadableMarkets: ReadonlySet<Address>;
}

/** Reads the reserve states of one lending market. */
export type MarketReserveStatesLoader = (
  market: Address,
  rpc: Rpc<SolanaRpcApi>,
  klendProgramId: Address
) => Promise<{ address: Address; state: Reserve }[]>;

/**
 * Whether a reserve can back a borrow in its market: a loan-to-value above 0, or in an elevation group. Its status does not
 * matter: klend takes a Hidden reserve as collateral by its config.
 */
export function isMarketCollateral(state: Reserve): boolean {
  const { config } = state;
  return config.loanToValuePct > 0 || config.elevationGroups.some((group) => group !== 0);
}

/** The vault reserves of each lending market, keyed by market. */
export function vaultReservesByMarket(vaultsReserves: ReadonlyMap<Address, KaminoReserve>): Map<Address, Address[]> {
  const byMarket = new Map<Address, Address[]>();
  for (const [reserveAddress, reserve] of vaultsReserves) {
    const market = reserve.state.lendingMarket;
    byMarket.set(market, [...(byMarket.get(market) ?? []), reserveAddress]);
  }
  return byMarket;
}

/** The vault reserves of a market that a collateral reaches: all of them except the collateral itself. */
export function vaultReservesReachedBy(
  collateral: Address,
  vaultReservesOfMarket: readonly Address[] | undefined
): Address[] {
  return (vaultReservesOfMarket ?? []).filter((vaultReserve) => vaultReserve !== collateral);
}

/**
 * Reads collateral for markets containing vault reserves. Omits collateral that affects none. Reports unreadable markets without aborting the pass.
 */
export async function loadMarketCollateral(
  rpc: Rpc<SolanaRpcApi>,
  vaultReservesOfMarket: ReadonlyMap<Address, readonly Address[]>,
  klendProgramId: Address,
  heartbeat?: () => void,
  loadReserveStates: MarketReserveStatesLoader = getReserveStatesForMarket
): Promise<MarketCollateralSnapshot> {
  const collateralByMarket = new Map<Address, Map<Address, CollateralReserve>>();
  const unreadableMarkets = new Set<Address>();
  for (const [market, vaultReserves] of vaultReservesOfMarket) {
    heartbeat?.();
    try {
      const reserves = await withTimeout(
        loadReserveStates(market, rpc, klendProgramId),
        RPC_REQUEST_TIMEOUT_MS,
        `[danger-detection] load the reserves of market ${market}`
      );
      const collateral = reserves.filter(
        ({ address, state }) => isMarketCollateral(state) && vaultReservesReachedBy(address, vaultReserves).length > 0
      );
      collateralByMarket.set(market, new Map(collateral.map(({ address, state }) => [address, { state }])));
    } catch (error) {
      logger.error(`[danger-detection] could not read the reserves of market ${market}: ${error}`);
      unreadableMarkets.add(market);
    }
  }
  return { vaultReservesOfMarket, collateralByMarket, unreadableMarkets };
}

/**
 * Blocks deposits for unreadable markets, failed collateral checks, and stale, zero or unreadable collateral Scope prices.
 * Returns a reason per affected vault reserve. These exclusions do not trigger evacuation.
 */
export function marketCollateralNoNewFunds(
  { vaultReservesOfMarket, collateralByMarket, unreadableMarkets }: MarketCollateralSnapshot,
  observations: ReadonlyMap<Address, ScopeOracleObservation>,
  assessments: ReadonlyMap<Address, MarketCollateralAssessment>
): Map<Address, string> {
  const reasons = new Map<Address, string>();
  for (const [market, vaultReserves] of vaultReservesOfMarket) {
    if (unreadableMarkets.has(market)) {
      for (const vaultReserve of vaultReserves)
        reasons.set(vaultReserve, `the reserves of market ${market} are unread`);
      continue;
    }
    const unreadable = new Set(assessments.get(market)?.unreadable ?? []);
    for (const collateral of collateralByMarket.get(market)?.keys() ?? []) {
      const reason = brokenCollateralReason(observations.get(collateral), unreadable.has(collateral));
      if (reason === undefined) continue;
      for (const vaultReserve of vaultReservesReachedBy(collateral, vaultReserves)) {
        reasons.set(vaultReserve, `collateral ${collateral} ${reason}`);
      }
    }
  }
  return reasons;
}

function brokenCollateralReason(
  observation: ScopeOracleObservation | undefined,
  unreadable: boolean
): string | undefined {
  if (unreadable) return 'could not be checked';
  if (observation === undefined || observation.kind === 'unavailable') return 'has an unreadable Scope price';
  if (observation.kind === 'zero') return 'has a zero Scope price';
  if (observation.kind === 'healthy' && observation.stale) return 'has a stale Scope price';
  return undefined;
}

/**
 * The collateral whose staged observations may be committed: every vault reserve it reaches has its own observations
 * committed this pass, so a catastrophic collateral result is committed only once the vault reserve acted on it.
 */
export function committableMarketCollateral(
  { vaultReservesOfMarket, collateralByMarket }: MarketCollateralSnapshot,
  committedVaultReserves: ReadonlySet<string>
): [Address, CollateralReserve][] {
  return Array.from(collateralByMarket).flatMap(([market, collateral]) =>
    Array.from(collateral).filter(([collateralAddress]) =>
      vaultReservesReachedBy(collateralAddress, vaultReservesOfMarket.get(market)).every((vaultReserve) =>
        committedVaultReserves.has(vaultReserve.toString())
      )
    )
  );
}
