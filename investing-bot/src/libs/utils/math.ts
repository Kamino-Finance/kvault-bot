import BN from 'bn.js';
import { Decimal } from 'decimal.js';

export function fromLamports(amount: string | BN | number | Decimal | bigint, decimals: number): Decimal {
  const factor = 10 ** decimals;
  return new Decimal(amount.toString()).div(factor);
}
