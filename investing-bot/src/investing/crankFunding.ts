import { Decimal } from 'decimal.js';
import { getAtasWithCreateIxsIfMissing, KaminoVault } from '@kamino-finance/klend-sdk';
import { lamports, TransactionSigner, Address } from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { logger } from 'kvaults-investing-bot-logger';
import { ConnectionPool } from 'kvaults-investing-bot-tx/ConnectionPool';
import { sendAndConfirmTransactionV0, WRAPPED_SOL_MINT } from 'kvaults-investing-bot-tx/instruction';
import { InvestConfig } from '../config/loopConfig.js';
import { SwapMode } from '../libs/actions/swap.js';
import { wrapSol } from '../libs/rebalanceWallet.js';
import { getAssociatedTokenAddress } from '../libs/tokenOperations.js';
import { getWalletBalances, MintWithDecimalsAndTokenProgram } from '../libs/utils/wallet.js';
import { KSwapConfig, KSwapWrapper } from '../services/kSwapWrapper.js';
import { attempt, interruptibleSleep, LoopHeartbeat } from '../utils/loop.js';
import { getTokensBatchPrice } from '../utils/price.js';
import { sendInstructionBatches } from '../utils/sendInstructionBatches.js';
import { RPC_REQUEST_TIMEOUT_MS, withTimeout } from '../utils/timeout.js';

/** The reads and sends of crank funding; each defaults to the real one. */
export interface CrankFundingDeps {
  getWalletBalances?: typeof getWalletBalances;
  fetchPrices?: typeof getTokensBatchPrice;
  swapper?: Pick<KSwapWrapper, 'swap'>;
  wrapSol?: typeof wrapSol;
  sleep?: typeof interruptibleSleep;
}

/**
 * Swaps or wraps SOL so that the investor holds enough base units of each vault token to pay the invest-crank fees.
 * Funding is optional housekeeping: a failure is logged and the pass goes on with the existing balances. Returns
 * 'shutdown' when a shutdown arrives during a swap delay.
 */
export async function fundCrankFees(
  c: ConnectionPool,
  investor: TransactionSigner,
  envConfig: InvestConfig,
  vaults: KaminoVault[],
  vaultTokenMints: MintWithDecimalsAndTokenProgram[],
  heartbeat?: LoopHeartbeat,
  deps: CrankFundingDeps = {}
): Promise<'shutdown' | undefined> {
  // for a token mint how many vaults we have with that mint
  const tokensToVaultsCount = new Map<Address, number>();
  for (const vault of vaults) {
    const tokenMint = vault.state!.tokenMint;
    tokensToVaultsCount.set(tokenMint, (tokensToVaultsCount.get(tokenMint) ?? 0) + 1);
  }
  const kSwapWrapper = deps.swapper ?? new KSwapWrapper(investor, c, envConfig.kswapApiBaseUrl, envConfig.kswapApiKey);
  const walletBalances = await attempt(
    '[investing-loop] error reading wallet balances; skipping crank funding this pass',
    () =>
      withTimeout(
        (deps.getWalletBalances ?? getWalletBalances)(c, vaultTokenMints, investor),
        RPC_REQUEST_TIMEOUT_MS,
        '[investing-loop] get wallet balances'
      )
  );

  const nonSolFundingNeeds: Array<{ mint: Address; outputBaseUnitsNeeded: Decimal }> = [];
  let solBaseUnitsToWrap = new Decimal(0);
  let attemptedNonSolSwap = false;
  for (const [mint, count] of tokensToVaultsCount.entries()) {
    // Crank funding is optional housekeeping: without balances, the pass goes on with existing funds.
    if (walletBalances === undefined) break;
    const baseUnitsNeededForInvest = count * 10;

    const balanceBaseUnits = new Decimal((walletBalances.get(mint) ?? 0n).toString());
    const outputBaseUnitsNeeded = new Decimal(baseUnitsNeededForInvest).minus(balanceBaseUnits);
    if (outputBaseUnitsNeeded.lte(0)) {
      continue;
    }

    // Request at least 1,000 base units of the OUTPUT token so tiny crank-fee deficits still get a
    // viable route. This amount is not a WSOL input amount.
    const roundedOutputBaseUnitsNeeded = Decimal.max(outputBaseUnitsNeeded, new Decimal(1_000)).ceil();
    if (mint === WRAPPED_SOL_MINT) {
      solBaseUnitsToWrap = solBaseUnitsToWrap.plus(roundedOutputBaseUnitsNeeded);
    } else {
      nonSolFundingNeeds.push({ mint, outputBaseUnitsNeeded: roundedOutputBaseUnitsNeeded });
    }
  }

  if (nonSolFundingNeeds.length > 0) {
    const priceMints = [WRAPPED_SOL_MINT, ...nonSolFundingNeeds.map(({ mint }) => mint)];
    let referencePrices: Map<Address, Decimal> | undefined;
    try {
      // Lenient: a mint without a fresh price is priced at 0 and skipped below, so it does not stop the other swaps.
      referencePrices = await (deps.fetchPrices ?? getTokensBatchPrice)(priceMints, {
        maxAgeSeconds: envConfig.marketPriceMaxAgeSeconds,
      });
    } catch (error) {
      // Funding swaps are optional housekeeping. Without a trustworthy independent price, skip
      // them and continue the invest pass with existing balances.
      logger.error(`[investing-loop] skipping crank-funding swaps: could not load fresh reference prices: ${error}`);
    }

    const solPrice = referencePrices?.get(WRAPPED_SOL_MINT);
    if (referencePrices && (solPrice === undefined || solPrice.lte(0))) {
      // Every swap spends SOL, so its price guard needs a fresh SOL price.
      logger.error('[investing-loop] skipping crank-funding swaps: no fresh SOL reference price');
    } else if (referencePrices) {
      for (const { mint, outputBaseUnitsNeeded } of nonSolFundingNeeds) {
        const outputPrice = referencePrices.get(mint);
        if (outputPrice === undefined || outputPrice.lte(0)) {
          logger.error(`[investing-loop] skipping the crank-funding swap into ${mint}: no fresh reference price`);
          continue;
        }
        const outputToken = vaultTokenMints.find((token) => token.mint === mint)!;
        const swapConfig: KSwapConfig = {
          swapMode: SwapMode.ExactOut,
          slippageBps: envConfig.defaultSwapSlippageBps,
          wrapAndUnwrapSol: true,
          priceGuard: {
            inputTokenPriceUsd: solPrice!,
            outputTokenPriceUsd: outputPrice,
            inputTokenDecimals: 9,
            outputTokenDecimals: outputToken.decimals,
            maxSlippageBps: envConfig.defaultPriceSlippageBps,
          },
          balanceGuard: {
            inputTokenProgramOwner: TOKEN_PROGRAM_ADDRESS,
            outputTokenProgramOwner: outputToken.tokenProgram,
          },
        };
        try {
          attemptedNonSolSwap = true;
          await kSwapWrapper.swap(
            c,
            WRAPPED_SOL_MINT,
            mint,
            lamports(BigInt(outputBaseUnitsNeeded.toString())),
            swapConfig,
            [],
            'investing-loop KSwap exact-output swap for crank funds'
          );
          const shouldExit = await (deps.sleep ?? interruptibleSleep)(10000, heartbeat);
          if (shouldExit) {
            logger.info('[investing-loop] Shutdown requested during swap delay, exiting...');
            return 'shutdown';
          }
        } catch (e) {
          logger.error(`[investing-loop] error swapping in ${mint.toString()}; error: ${e}`);
        }
      }
    }
  }

  const solVaultCount = tokensToVaultsCount.get(WRAPPED_SOL_MINT) ?? 0;
  if (attemptedNonSolSwap && solVaultCount > 0) {
    // A swap closes the WSOL account. Read it again even after an error, because the swap may have landed.
    heartbeat?.();
    const balances = await attempt(
      '[investing-loop] error refreshing WSOL balance; skipping SOL wrapping this pass',
      () =>
        withTimeout(
          (deps.getWalletBalances ?? getWalletBalances)(
            c,
            vaultTokenMints.filter(({ mint }) => mint === WRAPPED_SOL_MINT),
            investor
          ),
          RPC_REQUEST_TIMEOUT_MS,
          '[investing-loop] refresh WSOL balance'
        )
    );
    heartbeat?.();
    if (balances === undefined) return undefined;
    const deficitBaseUnits = new Decimal(solVaultCount * 10).sub((balances.get(WRAPPED_SOL_MINT) ?? 0n).toString());
    solBaseUnitsToWrap = deficitBaseUnits.gt(0) ? Decimal.max(deficitBaseUnits, 1_000).ceil() : new Decimal(0);
  }

  if (solBaseUnitsToWrap.gt(0)) {
    try {
      const wsolAta = await getAssociatedTokenAddress(WRAPPED_SOL_MINT, investor.address);
      await (deps.wrapSol ?? wrapSol)(c, investor, wsolAta, solBaseUnitsToWrap);
    } catch (e) {
      // Crank funding for SOL vaults is short this pass; the other vaults still get their invest.
      logger.error(`[investing-loop] error wrapping SOL for crank funding; continuing without it: ${e}`);
    }
  }
  return undefined;
}

/** Creates the missing investor token accounts. Each invest also creates its token account, so a failure only logs. */
export async function ensureInvestorTokenAccounts(
  c: ConnectionPool,
  investor: TransactionSigner,
  mintsWithDecimalsAndTokenProgram: Array<MintWithDecimalsAndTokenProgram>,
  heartbeat?: LoopHeartbeat,
  sendTx?: typeof sendAndConfirmTransactionV0
): Promise<void> {
  await attempt('[investing-loop] error creating investor token accounts; continuing the pass', async () => {
    const { createAtaIxs } = await withTimeout(
      getAtasWithCreateIxsIfMissing(
        c.getRpc(),
        investor,
        mintsWithDecimalsAndTokenProgram.map(({ mint, tokenProgram }) => ({
          mint,
          tokenProgram,
        }))
      ),
      RPC_REQUEST_TIMEOUT_MS,
      '[investing-loop] get investor token accounts'
    );

    // send txs to create token accounts if missing, in batch of 4
    await sendInstructionBatches({
      connectionPool: c,
      payer: investor,
      instructions: createAtaIxs,
      lookupTables: [],
      description: 'investing-loop create investor atas',
      batchSize: 4,
      options: { reportSample: false },
      heartbeat,
      sendTx,
    });
  });
}
