import BN from 'bn.js';
import {
  Account,
  Address,
  generateKeyPairSigner,
  Instruction,
  Lamports,
  Rpc,
  SolanaRpcApi,
  TransactionSigner,
} from '@solana/kit';
import {
  KswapSdk,
  NON_COMPOSABLE_ROUTERS,
  RouteOutput,
  RouterType,
  SUPPORTED_ROUTER_TYPES,
} from '@kamino-finance/kswap-sdk';
import { ConnectionPool } from 'kvaults-investing-bot-tx/ConnectionPool';
import { logger, LogLevel } from 'kvaults-investing-bot-logger';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { Decimal } from 'decimal.js';
import { getCloseAccountInstruction } from '@solana-program/token-2022';
import { AddressLookupTable } from '@solana-program/address-lookup-table';
import {
  base64EncodeTx,
  MAX_LOCKED_ACCOUNTS,
  maxLockedAccounts,
  sendAndConfirmTransactionV0,
  simulateTxIsSuccessful,
  uniqueAccounts,
  WRAPPED_SOL_MINT,
} from 'kvaults-investing-bot-tx/instruction';
import { fetchBlockhash } from 'kvaults-investing-bot-tx/blockhash';
import { removeComputeBudgetIxs } from 'kvaults-investing-bot-tx/computeBudget';
import { createTokenAccountInstructions } from '../libs/token.js';
import { getAssociatedTokenAddress } from '../libs/tokenOperations.js';
import { BaseSwapConfig, SwapConfig, SwapMode, SwapResponse, SwapTxResponse } from '../libs/actions/swap.js';

export type KSwapResponse = SwapResponse;

export type KSwapConfig = BaseSwapConfig & {
  withSimulation?: boolean;
  composableRoutersOnly?: boolean;
  filterFailedSimulations?: boolean;
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

export type AssertSwapBalancesTokenInfoParam = {
  mint: Address;
  tokenProgramOwner?: Address;
  ata?: Address;
};

export class KSwapWrapper {
  payer: TransactionSigner;
  kswapSdk: KswapSdk;
  routers: RouterType[];
  composableRouters: RouterType[];

  constructor(
    payer: TransactionSigner,
    c: ConnectionPool,
    kswapApiBaseUrl: string,
    kswapApiKey: string | undefined,
    excludeRouters: RouterType[]
  ) {
    this.payer = payer;
    this.kswapSdk = new KswapSdk(kswapApiBaseUrl, c.getRpc() as Rpc<SolanaRpcApi>, c.getWsRpc(), kswapApiKey, {
      logger: logger,
      requestLogLevel: LogLevel.INFO,
      responseLogLevel: LogLevel.INFO,
    });
    this.routers = SUPPORTED_ROUTER_TYPES.filter((routerType) => !excludeRouters.includes(routerType));
    this.composableRouters = this.routers.filter((routerType) => !NON_COMPOSABLE_ROUTERS.includes(routerType));
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
    let { destinationTokenAccount } = swapConfig;
    const solAccountSetupIxs: Instruction[] = [];
    const additionalSigners: TransactionSigner[] = [];
    const solAccountCleanupIxs: Instruction[] = [];
    let finalSwapConfig: KSwapConfig = { ...swapConfig };

    // If we are swapping to SOL and unwrapping, we don't want to use our ATA because it will be emptied completely when close account is called. Instead, we create a temporary account and use that.
    if (outputToken === WRAPPED_SOL_MINT && swapConfig?.wrapAndUnwrapSol && !destinationTokenAccount) {
      const tempSolAcc = await generateKeyPairSigner();
      logger.info(`${description} Using temporary WSOL account ${tempSolAcc.address}`);
      destinationTokenAccount = tempSolAcc.address;
      const tempSolSetupAccIxs = await createTokenAccountInstructions(
        c.getRpc(),
        tempSolAcc,
        outputToken,
        this.payer,
        TOKEN_PROGRAM_ADDRESS
      );
      solAccountSetupIxs.push(...tempSolSetupAccIxs);
      additionalSigners.push(tempSolAcc);
      finalSwapConfig = {
        ...swapConfig,
        destinationTokenAccount,
        withSimulation: false, // The temp SOL account does not exist, so simulations will always fail
        composableRoutersOnly: true, // we are adding ixs either side of the swap
      };
      const tempSolCleanupIx = getCloseAccountInstruction(
        {
          owner: this.payer,
          account: destinationTokenAccount,
          destination: this.payer.address,
        },
        { programAddress: TOKEN_PROGRAM_ADDRESS }
      );
      solAccountCleanupIxs.push(tempSolCleanupIx);
    }

    const responses = await this.swapTxFindSuitableRoutes(
      inputToken,
      outputToken,
      inputAmountLamports,
      finalSwapConfig,
      description
    );

    const blockhash = await fetchBlockhash(c.getRpc());
    for (let i = 0; i < responses.length; i++) {
      const swapResponse = responses[i];
      const descriptionWithIndex = `${description} - Route ${i + 1}/${responses.length} (${swapResponse.router})`;
      if (swapResponse.swapTxs.swapIxs.length === 0) {
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

      const { preAssertBalancesIxs, postAssertBalancesIxs } = swapConfig.balanceGuard
        ? await this.getAssertSwapBalancesIxs(
            swapResponse.swapResponse.swapMaxInAmountLamports,
            swapResponse.swapResponse.swapMinOutAmountLamports,
            { mint: inputToken, tokenProgramOwner: swapConfig.balanceGuard.inputTokenProgramOwner },
            { mint: outputToken, tokenProgramOwner: swapConfig.balanceGuard.outputTokenProgramOwner },
            destinationTokenAccount
          )
        : { preAssertBalancesIxs: [], postAssertBalancesIxs: [] };
      const ixs = [
        ...solAccountSetupIxs,
        ...preAssertBalancesIxs,
        ...swapResponse.swapTxs.swapIxs,
        ...postAssertBalancesIxs,
        ...solAccountCleanupIxs,
      ];
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
        const tx = await sendAndConfirmTransactionV0(
          c,
          this.payer,
          ixs,
          luts,
          additionalSigners,
          descriptionWithIndex,
          { blockhash, reportSample: false, sendIfSimulationFailed: true }
        );
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
        if (responses.length === i + 1) {
          throw e;
        }
      }
    }
    throw new NoSwapRoutesFoundError();
  }

  // This method ignores `useTokenLedger` param and instead assumes that the token ledger ixs are
  // added separately by the caller
  async swapTxFindSuitableRoutes(
    inputMint: Address,
    outputMint: Address,
    amountLamports: Lamports,
    swapConfig: KSwapConfig,
    description: string
  ): Promise<SwapTxResponse[]> {
    const swapMode = swapConfig.swapMode ?? SwapMode.ExactIn;
    const preferredMaxAccounts = swapConfig.txAccounts
      ? maxLockedAccounts(swapConfig.txAccounts!.size + (swapConfig.txAccountsBuffer || 0))
      : undefined;
    logger.info(
      `${description} Requesting KSwap /all-routes with swap type ${swapMode} from ${inputMint} to ${outputMint} with ${amountLamports} lamports, slippage (bps): ${swapConfig.slippageBps}, preferred max accounts: ${preferredMaxAccounts}`
    );

    const response = await this.kswapSdk.getAllRoutes({
      tokenIn: inputMint,
      tokenOut: outputMint,
      amount: new BN(amountLamports.toString()),
      swapType: swapMode,
      executor: this.payer.address,
      maxSlippageBps: swapConfig.slippageBps,
      preferredMaxAccounts,
      wrapAndUnwrapSol: swapConfig.wrapAndUnwrapSol,
      withSimulation: swapConfig.withSimulation,
      routerTypes: this.getRouters(swapConfig.composableRoutersOnly),
      destinationTokenAccount: swapConfig.destinationTokenAccount ? swapConfig.destinationTokenAccount : undefined,
      includeLimoLogs: false,
      assertSwapBalances: false,
    });

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
    if (preferredMaxAccounts === undefined) {
      response.routes.sort(getRouteOutputComparator(swapMode));
      logger.info(
        `${descriptionWithTraceId} no preferred max accounts specified, returning all ${response.routes.length} routes in sorted order (${response.routes.map((r) => r.routerType)})`
      );
      return response.routes.map((route) => swapTxFromRoute(route, swapConfig));
    }

    const notWithin: { routerType: RouterType; accounts: number }[] = [];
    const within = response.routes.filter((route) => {
      const swap = swapTxFromRoute(route, swapConfig);
      if (swap.swapTxs.swapIxs.length === 0) {
        logger.warn(`${descriptionWithTraceId} returned route of type ${route.routerType} with no swap ixs`);
        return false;
      }
      const allAccounts = uniqueAccounts(
        swap.swapTxs.swapIxs,
        swap.swapLookupTableAccounts,
        ...(swapConfig.txAccounts || [])
      );
      const within = allAccounts.size <= MAX_LOCKED_ACCOUNTS;
      if (!within) {
        notWithin.push({
          routerType: route.routerType,
          accounts: allAccounts.size,
        });
      }
      return within;
    });

    if (notWithin.length > 0) {
      logger.info(
        `${descriptionWithTraceId} filtered ${notWithin.length} routes which exceeded the SVM limit of ${MAX_LOCKED_ACCOUNTS} locked accounts (${notWithin.map((x) => `${x.routerType}:${x.accounts}`)})`
      );
    }
    if (within.length === 0) {
      logger.warn(
        `${descriptionWithTraceId} no routes were found within the SVM limit of ${MAX_LOCKED_ACCOUNTS} locked accounts`
      );
      throw new NoSwapRoutesFoundError();
    }

    within.sort(getRouteOutputComparator(swapMode));
    logger.info(`${descriptionWithTraceId} sorted ${within.length} routes (${within.map((r) => r.routerType)})`);
    return within.map((route) => swapTxFromRoute(route, swapConfig));
  }

  async getAssertSwapBalancesIxs(
    swapAmountInLamports: Decimal,
    minSwapAmountOutLamports: Decimal,
    inputToken: AssertSwapBalancesTokenInfoParam,
    outputToken: AssertSwapBalancesTokenInfoParam,
    destinationTokenAccount?: Address
  ): Promise<{ preAssertBalancesIxs: Instruction[]; postAssertBalancesIxs: Instruction[] }> {
    if (!inputToken.tokenProgramOwner && !inputToken.ata) {
      throw new Error(
        'KSwapWrapper::getAssertSwapBalancesIxs: at least one of inputToken.tokenProgramOwner or inputToken.ata must be provided'
      );
    }
    if (!outputToken.tokenProgramOwner && !outputToken.ata) {
      throw new Error(
        'KSwapWrapper::getAssertSwapBalancesIxs: at least one of outputToken.tokenProgramOwner or outputToken.ata must be provided'
      );
    }

    const [inputTa, outputTa] = await Promise.all([
      inputToken.ata
        ? inputToken.ata
        : getAssociatedTokenAddress(inputToken.mint, this.payer.address, inputToken.tokenProgramOwner),
      destinationTokenAccount
        ? destinationTokenAccount
        : outputToken.ata
          ? outputToken.ata
          : getAssociatedTokenAddress(outputToken.mint, this.payer.address, outputToken.tokenProgramOwner),
    ]);

    const { preIx, postIx } = await this.kswapSdk.getLedgerIxs(
      this.payer,
      inputTa,
      outputTa,
      new BN(swapAmountInLamports.toString()), // maxInputAmountChange
      new BN(minSwapAmountOutLamports.toString())
    );
    return {
      preAssertBalancesIxs: [preIx],
      postAssertBalancesIxs: [postIx],
    };
  }

  getRouters(composableRoutersOnly: boolean | undefined): RouterType[] | undefined {
    if (composableRoutersOnly) {
      return this.composableRouters;
    }
    return this.routers;
  }
}

export class NoSwapRoutesFoundError extends Error {
  constructor() {
    super(`Could not find any valid swap routes`);
  }
}

export function swapTxFromRoute(route: RouteOutput, swapConfig: SwapConfig): SwapTxResponse {
  const swapMode = swapConfig.swapMode ?? SwapMode.ExactIn;

  // we already have the lookup table accounts, but not in the type we need so we translate them here
  // from AddressLookupTableAccount to Account<AddressLookupTable>
  const swapLookupTableAccounts = route.lookupTableAccounts ? route.lookupTableAccounts : [];

  const allIxs = route.ixsRouter || [];
  const { computeBudgetIxs, otherIxs: swapIxs } = removeComputeBudgetIxs(allIxs);

  return {
    router: route.routerType,
    swapTxs: {
      computeBudgetIxs,
      tokenLedgerIxs: [],
      setupIxs: [],
      swapIxs,
      cleanupIxs: [],
    },
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
