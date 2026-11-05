import BN from 'bn.js';
import { Account, Address, Instruction, Lamports, Rpc, SolanaRpcApi, TransactionSigner } from '@solana/kit';
import {
  insertLimoLedgerIxsAroundRouterInstruction,
  isValidRouterType,
  KswapSdk,
  RouteOutput,
  SUPPORTED_ROUTER_TYPES,
} from '@kamino-finance/kswap-sdk';
import { ConnectionPool } from 'kvaults-investing-bot-tx/ConnectionPool';
import { logger, LogLevel } from 'kvaults-investing-bot-logger';
import { Decimal } from 'decimal.js';
import { AddressLookupTable } from '@solana-program/address-lookup-table';
import {
  getTransferSolInstruction,
  getTransferSolInstructionDataDecoder,
  SYSTEM_PROGRAM_ADDRESS,
} from '@solana-program/system';
import {
  getCloseAccountInstruction,
  getCreateAssociatedTokenInstruction,
  getCreateAssociatedTokenIdempotentInstruction,
  getSyncNativeInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import {
  base64EncodeTx,
  sendAndConfirmTransactionV0,
  simulateTxIsSuccessful,
  TransactionError,
  WRAPPED_SOL_MINT,
} from 'kvaults-investing-bot-tx/instruction';
import { fetchBlockhash } from 'kvaults-investing-bot-tx/blockhash';
import { removeComputeBudgetIxs } from 'kvaults-investing-bot-tx/computeBudget';
import { getAssociatedTokenAddress } from '../libs/tokenOperations.js';
import { EXTERNAL_REQUEST_TIMEOUT_MS, withTimeout } from '../utils/timeout.js';
import { SwapMode, SwapResponse, SwapTxResponse } from '../libs/actions/swap.js';

export type KSwapResponse = SwapResponse;

export type KSwapConfig = {
  slippageBps: number;
  swapMode?: SwapMode;
  wrapAndUnwrapSol?: boolean;
  priceGuard?: SwapPriceGuard;
  balanceGuard?: {
    inputTokenProgramOwner: Address;
    outputTokenProgramOwner: Address;
  };
};

export interface SwapPriceGuard {
  inputTokenPriceUsd: Decimal;
  outputTokenPriceUsd: Decimal;
  inputTokenDecimals: number;
  outputTokenDecimals: number;
  maxSlippageBps: number;
}

export class KSwapWrapper {
  payer: TransactionSigner;
  kswapSdk: KswapSdk;
  private readonly sendTx: typeof sendAndConfirmTransactionV0;

  constructor(
    payer: TransactionSigner,
    c: ConnectionPool,
    kswapApiBaseUrl: string,
    kswapApiKey: string | undefined,
    sendTx: typeof sendAndConfirmTransactionV0 = sendAndConfirmTransactionV0
  ) {
    this.payer = payer;
    this.sendTx = sendTx;
    this.kswapSdk = new KswapSdk(kswapApiBaseUrl, c.getRpc() as Rpc<SolanaRpcApi>, c.getWsRpc(), kswapApiKey, {
      logger: logger,
      requestLogLevel: LogLevel.INFO,
      responseLogLevel: LogLevel.INFO,
    });
  }

  async swap(
    c: ConnectionPool,
    inputToken: Address,
    outputToken: Address,
    inputAmountLamports: Lamports,
    swapConfig: KSwapConfig,
    userLuts: Account<AddressLookupTable>[],
    description: string = 'KSwap'
  ): Promise<{ tx: string; response: KSwapResponse }> {
    const responses = await this.swapTxFindSuitableRoutes(
      inputToken,
      outputToken,
      inputAmountLamports,
      swapConfig,
      description
    );

    const blockhash = await fetchBlockhash(c.getRpc());
    for (let i = 0; i < responses.length; i++) {
      const swapResponse = responses[i];
      const descriptionWithIndex = `${description} - Route ${i + 1}/${responses.length} (${swapResponse.router})`;
      if (swapResponse.swapIxs.length === 0) {
        logger.error(
          `${descriptionWithIndex} KSwap returned an empty swap instruction list for route, likely parameters passed are invalid`
        );
        continue;
      }

      if (swapResponse.swapResponse.swapOutAmountLamports.eq(0)) {
        logger.error(
          `${descriptionWithIndex} KSwap returned a swap response with 0 swap out amount, trying next route`
        );
        continue;
      }

      if (swapConfig.priceGuard) {
        assertSwapPriceWithinTolerance(swapResponse.swapResponse, swapConfig.swapMode, swapConfig.priceGuard);
      }

      let ixs = swapResponse.swapIxs;
      if (swapConfig.balanceGuard) {
        if (!isValidRouterType(swapResponse.router)) {
          logger.error(
            `${descriptionWithIndex} Cannot place balance assertions for unknown KSwap router ${swapResponse.router}`
          );
          continue;
        }
        const { preAssertBalancesIx, postAssertBalancesIx } = await this.getAssertSwapBalancesIxs(
          swapResponse.swapResponse.swapMaxInAmountLamports,
          swapResponse.swapResponse.swapMinOutAmountLamports,
          { mint: inputToken, tokenProgramOwner: swapConfig.balanceGuard.inputTokenProgramOwner },
          { mint: outputToken, tokenProgramOwner: swapConfig.balanceGuard.outputTokenProgramOwner }
        );
        const tokens = await Promise.all(
          [
            { mint: inputToken, tokenProgram: swapConfig.balanceGuard.inputTokenProgramOwner },
            { mint: outputToken, tokenProgram: swapConfig.balanceGuard.outputTokenProgramOwner },
          ].map(async (token) => ({
            ...token,
            ata: await getAssociatedTokenAddress(token.mint, this.payer.address, token.tokenProgram),
          }))
        );
        const accountSetupIxs = tokens.flatMap(({ mint, tokenProgram, ata }) => {
          const accounts = { payer: this.payer, owner: this.payer.address, mint, tokenProgram, ata };
          return [
            getCreateAssociatedTokenInstruction(accounts),
            getCreateAssociatedTokenIdempotentInstruction(accounts),
          ];
        });
        const nativeToken = swapConfig.wrapAndUnwrapSol
          ? tokens.find((token) => token.mint === WRAPPED_SOL_MINT && token.tokenProgram === TOKEN_PROGRAM_ADDRESS)
          : undefined;
        // Request unwrapped routes and create native setup locally, including Raydium and DFlow swaps.
        const setupIxs = tokens.map(({ mint, tokenProgram, ata }) =>
          getCreateAssociatedTokenIdempotentInstruction({
            payer: this.payer,
            owner: this.payer.address,
            mint,
            tokenProgram,
            ata,
          })
        );
        const nativeSetupIxs =
          nativeToken?.mint === inputToken
            ? [
                getTransferSolInstruction({
                  source: this.payer,
                  destination: nativeToken.ata,
                  amount: BigInt(swapResponse.swapResponse.swapMaxInAmountLamports.toString()),
                }),
                getSyncNativeInstruction({ account: nativeToken.ata }),
              ]
            : [];
        const cleanupIx = nativeToken
          ? getCloseAccountInstruction({ account: nativeToken.ata, destination: this.payer.address, owner: this.payer })
          : undefined;
        const routeIxs = [...setupIxs, ...nativeSetupIxs, ...swapResponse.swapIxs, ...(cleanupIx ? [cleanupIx] : [])];
        // The accounts must exist and hold wrapped SOL before the snapshot. Cleanup must follow the final assertion.
        ixs = insertLimoLedgerIxsAroundRouterInstruction(
          routeIxs,
          swapResponse.router,
          {
            tokenIn: inputToken,
            tokenOut: outputToken,
            amount: new BN(inputAmountLamports.toString()),
            swapType: swapConfig.swapMode ?? SwapMode.ExactIn,
            executor: this.payer.address,
            maxSlippageBps: swapConfig.slippageBps,
            wrapAndUnwrapSol: false,
          },
          preAssertBalancesIx,
          postAssertBalancesIx
        );
        // The SDK returns the original instructions when it cannot identify the router instruction.
        if (
          ixs.length !== routeIxs.length + 2 ||
          !ixs.includes(preAssertBalancesIx) ||
          !ixs.includes(postAssertBalancesIx)
        ) {
          logger.error(
            `${descriptionWithIndex} Cannot place balance assertions for KSwap router ${swapResponse.router}`
          );
          continue;
        }
        // Exclude only canonical account setup and WSOL cleanup. Reject other effects outside the assertions.
        let wrappedLamports = 0n;
        const maxInputLamports = BigInt(swapResponse.swapResponse.swapMaxInAmountLamports.toString());
        const isSetup = (ix: Instruction): boolean => {
          if (accountSetupIxs.some((expected) => matchesInstruction(ix, expected))) return true;
          if (nativeToken?.mint !== inputToken) return false;
          if (matchesInstruction(ix, getSyncNativeInstruction({ account: nativeToken.ata }))) return true;
          if (ix.programAddress !== SYSTEM_PROGRAM_ADDRESS || ix.data?.length !== 12) return false;
          const { amount } = getTransferSolInstructionDataDecoder().decode(ix.data);
          if (
            wrappedLamports + amount > maxInputLamports ||
            !matchesInstruction(
              ix,
              getTransferSolInstruction({ source: this.payer, destination: nativeToken.ata, amount })
            )
          )
            return false;
          wrappedLamports += amount;
          return true;
        };
        if (
          !ixs.slice(0, ixs.indexOf(preAssertBalancesIx)).every(isSetup) ||
          !ixs
            .slice(ixs.indexOf(postAssertBalancesIx) + 1)
            .every((ix) => cleanupIx && matchesInstruction(ix, cleanupIx))
        ) {
          logger.error(
            `${descriptionWithIndex} KSwap returned unsupported instructions outside the balance assertions`
          );
          continue;
        }
      }
      const luts = [...userLuts, ...swapResponse.swapLookupTableAccounts];
      const simulationIsSuccessful = await simulateTxIsSuccessful(
        c.getRpc(),
        ixs,
        this.payer.address,
        luts,
        descriptionWithIndex
      );
      if (!simulationIsSuccessful) {
        logger.error(`${descriptionWithIndex} KSwap returned a simulation that failed, trying next route`);
        continue;
      }

      try {
        const tx = await this.sendTx(c, this.payer, ixs, luts, [], descriptionWithIndex, {
          blockhash,
          reportSample: false,
          sendIfSimulationFailed: true,
        });
        return {
          tx,
          response: swapResponse.swapResponse,
        };
      } catch (e) {
        // Only print when there's an error
        try {
          const { encodedTx, simulationUrl } = base64EncodeTx('mainnet-beta', this.payer.address, ixs, luts);
          logger.error(`${descriptionWithIndex} KSwap failed txHash: ${e.sig}`, { encodedTx, simulationUrl }, e);
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
        } catch (e2) {
          logger.error(`${descriptionWithIndex} KSwap failed txHash: ${e.sig}`, e);
        }
        // A TransactionError comes from the send path, so this route may already be broadcast. Trying the
        // next route could land a second swap for the same amount; stop here and let the next pass retry.
        if (e instanceof TransactionError || responses.length === i + 1) {
          throw e;
        }
      }
    }
    throw new NoSwapRoutesFoundError();
  }

  async swapTxFindSuitableRoutes(
    inputMint: Address,
    outputMint: Address,
    amountLamports: Lamports,
    swapConfig: KSwapConfig,
    description: string
  ): Promise<SwapTxResponse[]> {
    const swapMode = swapConfig.swapMode ?? SwapMode.ExactIn;
    logger.info(
      `${description} Requesting KSwap /all-routes with swap type ${swapMode} from ${inputMint} to ${outputMint} with ${amountLamports} lamports, slippage (bps): ${swapConfig.slippageBps}`
    );

    const response = await withTimeout(
      this.kswapSdk.getAllRoutes({
        tokenIn: inputMint,
        tokenOut: outputMint,
        amount: new BN(amountLamports.toString()),
        swapType: swapMode,
        executor: this.payer.address,
        maxSlippageBps: swapConfig.slippageBps,
        wrapAndUnwrapSol: swapConfig.balanceGuard ? false : swapConfig.wrapAndUnwrapSol,
        // The complete guarded transaction is simulated after local account setup and wrapping are added.
        withSimulation: swapConfig.balanceGuard ? false : undefined,
        routerTypes: [...SUPPORTED_ROUTER_TYPES],
        includeLimoLogs: false,
        assertSwapBalances: false,
      }),
      EXTERNAL_REQUEST_TIMEOUT_MS,
      `${description} KSwap /all-routes`
    );

    const descriptionWithTraceId = `${description} [${response.traceId}] KSwap /all-routes`;
    logger.info(
      `${descriptionWithTraceId} returned ${response.routes.length} (${response.routes.map((r) => r.routerType)}) routes`
    );

    if (response.routes.length === 0) {
      logger.warn(
        `${descriptionWithTraceId} returned no routes for swap type ${swapMode} from ${inputMint} to ${outputMint} with ${amountLamports} lamports`
      );
      throw new NoSwapRoutesFoundError();
    }
    response.routes.sort(getRouteOutputComparator(swapMode));
    logger.info(
      `${descriptionWithTraceId} returning all ${response.routes.length} routes in sorted order (${response.routes.map((r) => r.routerType)})`
    );
    return response.routes.map((route) => swapTxFromRoute(route, swapConfig));
  }

  async getAssertSwapBalancesIxs(
    swapAmountInLamports: Decimal,
    minSwapAmountOutLamports: Decimal,
    inputToken: { mint: Address; tokenProgramOwner: Address },
    outputToken: { mint: Address; tokenProgramOwner: Address }
  ): Promise<{ preAssertBalancesIx: Instruction; postAssertBalancesIx: Instruction }> {
    const [inputTa, outputTa] = await Promise.all([
      getAssociatedTokenAddress(inputToken.mint, this.payer.address, inputToken.tokenProgramOwner),
      getAssociatedTokenAddress(outputToken.mint, this.payer.address, outputToken.tokenProgramOwner),
    ]);

    const { preIx, postIx } = await this.kswapSdk.getLedgerIxs(
      this.payer,
      inputTa,
      outputTa,
      new BN(swapAmountInLamports.toString()), // maxInputAmountChange
      new BN(minSwapAmountOutLamports.toString())
    );
    return {
      preAssertBalancesIx: preIx,
      postAssertBalancesIx: postIx,
    };
  }
}

/** Compare the complete instruction payload and account permissions. Signer objects do not change instruction semantics. */
function matchesInstruction(actual: Instruction, expected: Instruction): boolean {
  return (
    actual.programAddress === expected.programAddress &&
    Buffer.from(actual.data ?? []).equals(Buffer.from(expected.data ?? [])) &&
    actual.accounts?.length === expected.accounts?.length &&
    (actual.accounts ?? []).every(
      (account, index) =>
        account.address === expected.accounts![index].address && account.role === expected.accounts![index].role
    )
  );
}

export class NoSwapRoutesFoundError extends Error {
  constructor() {
    super(`Could not find any valid swap routes`);
  }
}

export function swapTxFromRoute(route: RouteOutput, swapConfig: KSwapConfig): SwapTxResponse {
  const swapMode = swapConfig.swapMode ?? SwapMode.ExactIn;

  // we already have the lookup table accounts, but not in the type we need so we translate them here
  // from AddressLookupTableAccount to Account<AddressLookupTable>
  const swapLookupTableAccounts = route.lookupTableAccounts ? route.lookupTableAccounts : [];

  // The send path sets its own compute budget.
  const { otherIxs: swapIxs } = removeComputeBudgetIxs(route.ixsRouter || []);

  return {
    router: route.routerType,
    swapIxs,
    swapLookupTableAccounts,
    swapResponse: {
      swapInAmountLamports:
        swapMode === SwapMode.ExactIn
          ? new Decimal(route.amountsExactIn.amountIn.toString())
          : new Decimal(route.amountsExactOut.amountIn.toString()),
      swapMaxInAmountLamports:
        swapMode === SwapMode.ExactIn
          ? new Decimal(route.amountsExactIn.amountIn.toString())
          : new Decimal(route.amountsExactOut.amountInGuaranteed.toString()),
      swapOutAmountLamports:
        swapMode === SwapMode.ExactIn
          ? new Decimal(route.amountsExactIn.amountOut.toString())
          : new Decimal(route.amountsExactOut.amountOut.toString()),
      swapMinOutAmountLamports:
        swapMode === SwapMode.ExactIn
          ? new Decimal(route.amountsExactIn.amountOutGuaranteed.toString())
          : new Decimal(route.amountsExactOut.amountOut.toString()),
      slippageBps: swapConfig.slippageBps,
    },
  };
}

/**
 * Compare a route's guaranteed amounts against an independently-fetched reference price. This
 * rejects a bad quote before signing; the ledger instructions then enforce the accepted amounts
 * on-chain against the executor's actual token-account deltas.
 */
export function assertSwapPriceWithinTolerance(
  response: KSwapResponse,
  swapMode: SwapMode | undefined,
  guard: SwapPriceGuard
): void {
  const { inputTokenPriceUsd, outputTokenPriceUsd, inputTokenDecimals, outputTokenDecimals, maxSlippageBps } = guard;
  if (
    !inputTokenPriceUsd.isFinite() ||
    inputTokenPriceUsd.lte(0) ||
    !outputTokenPriceUsd.isFinite() ||
    outputTokenPriceUsd.lte(0)
  ) {
    throw new Error('KSwap price guard requires finite, positive token prices');
  }
  if (
    !Number.isInteger(inputTokenDecimals) ||
    inputTokenDecimals < 0 ||
    !Number.isInteger(outputTokenDecimals) ||
    outputTokenDecimals < 0
  ) {
    throw new Error('KSwap price guard requires non-negative integer token decimals');
  }
  if (!Number.isFinite(maxSlippageBps) || maxSlippageBps < 0 || maxSlippageBps >= 10_000) {
    throw new Error('KSwap price guard maxSlippageBps must be in [0, 10000)');
  }

  const inputFactor = new Decimal(10).pow(inputTokenDecimals);
  const outputFactor = new Decimal(10).pow(outputTokenDecimals);
  const slippageRatio = new Decimal(maxSlippageBps).div(10_000);

  if ((swapMode ?? SwapMode.ExactIn) === SwapMode.ExactIn) {
    const fairOutputBaseUnits = response.swapInAmountLamports
      .div(inputFactor)
      .mul(inputTokenPriceUsd)
      .div(outputTokenPriceUsd)
      .mul(outputFactor);
    const minOutputBaseUnits = fairOutputBaseUnits.mul(new Decimal(1).sub(slippageRatio)).floor();
    if (response.swapMinOutAmountLamports.lt(minOutputBaseUnits)) {
      throw new Error(
        `KSwap route fails price guard: guaranteed output ${response.swapMinOutAmountLamports.toString()} is below ${minOutputBaseUnits.toString()} base units`
      );
    }
    return;
  }

  const fairInputBaseUnits = response.swapOutAmountLamports
    .div(outputFactor)
    .mul(outputTokenPriceUsd)
    .div(inputTokenPriceUsd)
    .mul(inputFactor);
  const maxInputBaseUnits = fairInputBaseUnits.mul(new Decimal(1).add(slippageRatio)).ceil();
  if (response.swapMaxInAmountLamports.gt(maxInputBaseUnits)) {
    throw new Error(
      `KSwap route fails price guard: maximum input ${response.swapMaxInAmountLamports.toString()} exceeds ${maxInputBaseUnits.toString()} base units`
    );
  }
}

function getRouteOutputComparator(swapMode: SwapMode): (routeLeft: RouteOutput, routeRight: RouteOutput) => number {
  return (routeLeft, routeRight) => {
    if (swapMode === SwapMode.ExactIn) {
      const comparisonAmountLeft = routeLeft.amountsExactIn.amountOutSimulated
        ? routeLeft.amountsExactIn.amountOutSimulated
        : routeLeft.amountsExactIn.amountOutGuaranteed;
      const comparisonAmountRight = routeRight.amountsExactIn.amountOutSimulated
        ? routeRight.amountsExactIn.amountOutSimulated
        : routeRight.amountsExactIn.amountOutGuaranteed;

      return comparisonAmountLeft.eq(comparisonAmountRight)
        ? 0
        : // if `left` is less than `right` then `right` is the better route and we want it
          // to preceed `left` in the sorted output
          comparisonAmountLeft.lt(comparisonAmountRight)
          ? 1
          : -1;
    } else {
      const comparisonAmountLeft = routeLeft.amountsExactOut.amountInSimulated
        ? routeLeft.amountsExactOut.amountInSimulated
        : routeLeft.amountsExactOut.amountInGuaranteed;
      const comparisonAmountRight = routeRight.amountsExactOut.amountInSimulated
        ? routeRight.amountsExactOut.amountInSimulated
        : routeRight.amountsExactOut.amountInGuaranteed;

      return comparisonAmountLeft.eq(comparisonAmountRight)
        ? 0
        : // if `left` is less than `right` then `left` is the better route and we want it
          // to preceed `right` in the sorted output
          comparisonAmountLeft.lt(comparisonAmountRight)
          ? -1
          : 1;
    }
  };
}
