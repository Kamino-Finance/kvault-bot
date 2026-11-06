import { Decimal } from 'decimal.js';
import { Address } from '@solana/kit';

/**
 * A reserve with a stale or zero Scope price, or in reinvest cooldown, gets no new funds. It keeps
 * its weight, so an invest would still deposit into it by weight when the vault grows: the invest paths drop those
 * deposits and still send the withdrawals.
 */

/** The reserves of `noNewFunds` whose target is above the vault's holding, so that the invest would deposit into them. */
export function depositsInto(
  noNewFunds: ReadonlySet<string>,
  targetTokens: ReadonlyMap<Address, Decimal>,
  heldTokens: ReadonlyMap<Address, Decimal>
): Set<Address> {
  const reserves = new Set<Address>();
  for (const [reserve, target] of targetTokens) {
    if (noNewFunds.has(reserve.toString()) && target.gt(heldTokens.get(reserve) ?? 0)) {
      reserves.add(reserve);
    }
  }
  return reserves;
}
