import { fetchMint } from '@solana-program/token-2022';
import { Decimal } from 'decimal.js';
import { logger } from 'kvaults-investing-bot-logger';
import { DangerTriggerUnavailableError } from '../dangerTypes.js';
import { RPC_REQUEST_TIMEOUT_MS, withTimeout } from '../../utils/timeout.js';
const DEFAULT_SUPPLY_INCREASE_THRESHOLD_PERCENT = 50;
const defaultSupplyFetcher = async (rpc, mint) => (await fetchMint(rpc, mint)).data.supply;
/**
 * Catastrophic trigger: detects abnormal token supply growth (infinite mint attack).
 *
 * Tracks the supply of each underlying token mint across iterations.
 * If supply increases by more than the configured threshold between checks, it indicates
 * someone is minting tokens out of thin air.
 * Binary: below threshold → 1.0 (safe), above threshold → 0.0 (danger).
 */
export class InfiniteMintTrigger {
    name = 'infinite-mint';
    thresholdPercent;
    previousSupplyByMint = new Map();
    pendingSupplyByMint = new Map();
    fetchSupply;
    constructor(thresholdPercent = DEFAULT_SUPPLY_INCREASE_THRESHOLD_PERCENT, fetchSupply = defaultSupplyFetcher) {
        this.thresholdPercent = thresholdPercent;
        this.fetchSupply = fetchSupply;
    }
    async check(rpc, reserveAddress, reserve, context) {
        const mintAddress = reserve.state.liquidity.mintPubkey;
        const mintKey = mintAddress.toString();
        try {
            // Bound the on-chain read so one hung RPC can't stall the whole danger pass (defense in depth
            // on top of the loop's whole-pass timeout). A timeout aborts the danger pass.
            const currentSupply = await withTimeout(this.fetchSupply(rpc, mintAddress), RPC_REQUEST_TIMEOUT_MS, `[danger-detection] infinite-mint fetchMint ${mintKey}`);
            const previousSupply = this.previousSupplyByMint.get(mintKey);
            const finish = (result) => {
                this.pendingSupplyByMint.set(mintKey, currentSupply);
                if (!context.deferObservationCommit) {
                    this.commitObservation(reserveAddress, reserve);
                }
                return result;
            };
            if (previousSupply === undefined) {
                return finish({ safetyScore: 1.0, triggerName: this.name, reserveAddress, details: 'first observation' });
            }
            if (previousSupply === 0n) {
                if (currentSupply > 0n) {
                    return finish({
                        safetyScore: 0.0,
                        triggerName: this.name,
                        reserveAddress,
                        details: `supply went from 0 to ${currentSupply} for mint ${mintKey}`,
                        catastrophic: true,
                    });
                }
                return finish({
                    safetyScore: 1.0,
                    triggerName: this.name,
                    reserveAddress,
                    details: 'supply unchanged at 0',
                });
            }
            const increase = currentSupply - previousSupply;
            if (increase <= 0n) {
                return finish({
                    safetyScore: 1.0,
                    triggerName: this.name,
                    reserveAddress,
                    details: 'supply did not increase',
                });
            }
            // Compute the percentage with full precision.
            const increasePercent = new Decimal(increase.toString()).mul(100).div(previousSupply.toString());
            if (increasePercent.gt(this.thresholdPercent)) {
                const details = `mint ${mintKey} supply increased by ${increasePercent}% (from ${previousSupply} to ${currentSupply}), threshold: ${this.thresholdPercent}%`;
                logger.error(`[danger-detection] INFINITE MINT DETECTED: ${details}`);
                return finish({
                    safetyScore: 0.0,
                    triggerName: this.name,
                    reserveAddress,
                    details,
                    catastrophic: true,
                });
            }
            return finish({
                safetyScore: 1.0,
                triggerName: this.name,
                reserveAddress,
                details: `supply increase ${increasePercent}% within threshold`,
            });
        }
        catch (error) {
            logger.warn(`[danger-detection] error checking mint for reserve ${reserveAddress}: ${error}`);
            throw new DangerTriggerUnavailableError(this.name, reserveAddress, error);
        }
    }
    commitObservation(_reserveAddress, reserve) {
        const mintKey = reserve.state.liquidity.mintPubkey.toString();
        const pendingSupply = this.pendingSupplyByMint.get(mintKey);
        if (pendingSupply !== undefined) {
            this.previousSupplyByMint.set(mintKey, pendingSupply);
            this.pendingSupplyByMint.delete(mintKey);
        }
    }
}
//# sourceMappingURL=infiniteMintTrigger.js.map