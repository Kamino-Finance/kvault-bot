import { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import { fetchMint } from '@solana-program/token-2022';
import { Decimal } from 'decimal.js';
import { logger } from 'kvaults-investing-bot-logger';
import {
  CollateralReserve,
  CollateralTrigger,
  DangerTrigger,
  DangerTriggerUnavailableError,
  TriggerContext,
  TriggerResult,
} from '../dangerTypes.js';
import { StagedObservations } from '../observationStaging.js';
import { RPC_REQUEST_TIMEOUT_MS, withTimeout } from '../../utils/timeout.js';

const DEFAULT_SUPPLY_INCREASE_THRESHOLD_PERCENT = 50;

/**
 * Fetches the on-chain total supply for a mint. Injectable so the trigger's detection logic can be
 * unit-tested without RPC; defaults to reading it via `fetchMint`.
 */
export type MintSupplyFetcher = (rpc: Rpc<SolanaRpcApi>, mint: Address) => Promise<bigint>;

const defaultSupplyFetcher: MintSupplyFetcher = async (rpc, mint) => (await fetchMint(rpc, mint)).data.supply;

/** Baselines expire after this interval. The next reading establishes a new baseline. */
export const MAX_SUPPLY_BASELINE_AGE_SECONDS = 24n * 60n * 60n;

/** A supply reading and the ledger time it was taken at. */
interface SupplyBaseline {
  supply: bigint;
  observedAtSeconds: bigint;
}

/**
 * Catastrophic trigger: detects abnormal token supply growth (infinite mint attack).
 *
 * Tracks, for each reserve, the supply of its token mint across iterations. The baseline is per reserve, not per mint:
 * the coordinator commits observations reserve by reserve, so a shared baseline would let one reserve's commit hide
 * another reserve's unacted inflation.
 * If supply increases by more than the configured threshold between checks, it indicates
 * someone is minting tokens out of thin air.
 * Binary: below threshold → 1.0 (safe), above threshold → 0.0 (danger).
 */
export class InfiniteMintTrigger implements DangerTrigger, CollateralTrigger {
  readonly name = 'infinite-mint';
  private readonly thresholdPercent: number;
  private readonly previousSupplyByReserve: Map<string, SupplyBaseline> = new Map();
  /** Staged per pass generation and reserve; see observationStaging.ts. */
  private readonly pendingSupplyByReserve = new StagedObservations<SupplyBaseline>();
  private readonly fetchSupply: MintSupplyFetcher;

  constructor(
    thresholdPercent: number = DEFAULT_SUPPLY_INCREASE_THRESHOLD_PERCENT,
    fetchSupply: MintSupplyFetcher = defaultSupplyFetcher
  ) {
    this.thresholdPercent = thresholdPercent;
    this.fetchSupply = fetchSupply;
  }

  async check(rpc: Rpc<SolanaRpcApi>, reserveAddress: Address, reserve: CollateralReserve, context: TriggerContext) {
    const mintAddress = reserve.state.liquidity.mintPubkey;
    const mintKey = mintAddress.toString();
    const reserveKey = reserveAddress.toString();

    try {
      // Bound the on-chain read so one hung RPC can't stall the whole danger pass (defense in depth
      // on top of the loop's whole-pass timeout). A timeout aborts the danger pass.
      const currentSupply = await withTimeout(
        this.fetchSupply(rpc, mintAddress),
        RPC_REQUEST_TIMEOUT_MS,
        `[danger-detection] infinite-mint fetchMint ${mintKey}`
      );

      const observedAtSeconds = BigInt(context.currentLedgerInstant.blockTime);
      const baseline = this.previousSupplyByReserve.get(reserveKey);
      const finish = (result: TriggerResult): TriggerResult => {
        const reading = { supply: currentSupply, observedAtSeconds };
        const staging = context.observationStaging;
        if (staging) {
          this.pendingSupplyByReserve.stage(staging.generation, reserveKey, reading);
        } else {
          this.previousSupplyByReserve.set(reserveKey, reading);
        }
        return result;
      };

      if (baseline === undefined) {
        return finish({ safetyScore: 1.0, triggerName: this.name, reserveAddress, details: 'first observation' });
      }
      const baselineAgeSeconds = observedAtSeconds - baseline.observedAtSeconds;
      if (baselineAgeSeconds > MAX_SUPPLY_BASELINE_AGE_SECONDS) {
        const details = `baseline is ${baselineAgeSeconds}s old, above the ${MAX_SUPPLY_BASELINE_AGE_SECONDS}s limit; taking a new baseline`;
        logger.warn(`[danger-detection] infinite-mint for reserve ${reserveKey}: ${details}`);
        return finish({ safetyScore: 1.0, triggerName: this.name, reserveAddress, details });
      }
      const previousSupply = baseline.supply;

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
    } catch (error) {
      logger.warn(`[danger-detection] error checking mint for reserve ${reserveAddress}: ${error}`);
      throw new DangerTriggerUnavailableError(this.name, reserveAddress, error);
    }
  }

  commitObservation(reserveAddress: Address, _reserve: CollateralReserve, generation: number): void {
    const reserveKey = reserveAddress.toString();
    const pendingSupply = this.pendingSupplyByReserve.take(generation, reserveKey);
    if (pendingSupply !== undefined) {
      this.previousSupplyByReserve.set(reserveKey, pendingSupply);
    }
  }
}
