import { Decimal } from 'decimal.js';
export function fromLamports(amount, decimals) {
    const factor = 10 ** decimals;
    return new Decimal(amount.toString()).div(factor);
}
//# sourceMappingURL=math.js.map