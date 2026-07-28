import {
  KaminoManager,
  KaminoVault,
  KaminoReserve,
  ReserveAllocationConfig,
  ReserveWithAddress,
  sleep,
} from '@kamino-finance/klend-sdk';
import { Address, IInstruction, KeyPairSigner, Rpc, SolanaRpcApi } from '@solana/kit';
import { logger } from 'kvaults-investing-bot-logger';
import { ConnectionPool } from 'kvaults-investing-bot-tx/ConnectionPool';
import { DEFAULT_PUBLIC_KEY, sendAndConfirmTransactionV0 } from 'kvaults-investing-bot-tx/instruction';
import { getLut } from '../libs/lut.js';
import { getAllocationCapInTokensOrDefault, shouldUpdateAllocation } from '../allocationsRebalance/vaultUtils.js';
import { sendInstructionBatches } from '../utils/sendInstructionBatches.js';

/**
 * Injectable side-effecting dependencies, so the safety-critical control flow can be unit-tested
 * without real on-chain sends. Defaults to the real implementation.
 */
export interface DangerResponseDeps {
  sendTx?: typeof sendAndConfirmTransactionV0;
  delay?: (milliseconds: number) => Promise<void>;
}

/**
 * Execute emergency deinvestment for a vault: zero the allocation weight while
 * preserving the configured cap for all dangerous reserves, then trigger invest.
 */
export async function executeDangerResponse(
  dangerousReserveAddresses: Set<string>,
  kaminoManager: KaminoManager,
  kaminoVault: KaminoVault,
  vaultsReservesMap: Map<Address, KaminoReserve>,
  allocationAdmin: KeyPairSigner,
  c: ConnectionPool,
  deps: DangerResponseDeps = {}
): Promise<void> {
  const delay = deps.delay ?? sleep;
  const vaultState = await kaminoVault.getState();
  const vaultReserves = kaminoManager.getVaultReserves(vaultState);

  // Filter to only reserves that belong to this vault AND are flagged dangerous
  const dangerousVaultReserves = vaultReserves.filter((r) => dangerousReserveAddresses.has(r.toString()));
  if (dangerousVaultReserves.length === 0) return;

  logger.error(
    `[danger-response] EMERGENCY: zeroing allocation for ${dangerousVaultReserves.length} reserve(s) in vault ${kaminoVault.address}`
  );

  // Build zero-allocation instructions
  const zeroAllocIxs: IInstruction[] = [];
  for (const reserveAddr of dangerousVaultReserves) {
    const reserveState = vaultsReservesMap.get(reserveAddr);
    if (!reserveState) continue;

    const reserveWithAddress: ReserveWithAddress = {
      address: reserveAddr,
      state: reserveState.state,
    };
    const allocationCapTokens = getAllocationCapInTokensOrDefault(vaultState, reserveAddr);
    const zeroConfig = new ReserveAllocationConfig(reserveWithAddress, 0, allocationCapTokens);

    if (!shouldUpdateAllocation(vaultState, zeroConfig)) {
      logger.info(`[danger-response] Reserve ${reserveAddr} already at zero allocation, skipping`);
      continue;
    }

    const updateIxs = await kaminoManager.updateVaultReserveAllocationIxs(kaminoVault, zeroConfig, allocationAdmin);
    zeroAllocIxs.push(updateIxs.updateReserveAllocationIx);
    logger.error(`[danger-response] Reserve ${reserveAddr} allocation will be zeroed`);
  }

  // Get LUT if available
  const luts = [];
  if (vaultState.vaultLookupTable !== DEFAULT_PUBLIC_KEY) {
    const lutState = await getLut(c.getRpc() as Rpc<SolanaRpcApi>, vaultState.vaultLookupTable);
    luts.push(lutState);
  }

  // Send allocation-zeroing txs in batches of 2
  await sendInstructionBatches({
    connectionPool: c,
    payer: allocationAdmin,
    instructions: zeroAllocIxs,
    lookupTables: luts,
    signers: [allocationAdmin],
    description: 'danger-response zero allocation',
    batchSize: 2,
    options: { reportSample: true, sendIfSimulationFailed: true },
    sendTx: deps.sendTx,
  });

  // Reload state and trigger deinvest
  await delay(5000);
  await kaminoVault.reloadState();
  const currentSlot = await kaminoManager.getRpc().getSlot().send();
  const investIxs = await kaminoManager.investAllReservesIxs(allocationAdmin, kaminoVault, currentSlot, true);
  await sendInstructionBatches({
    connectionPool: c,
    payer: allocationAdmin,
    instructions: investIxs,
    lookupTables: luts,
    signers: [allocationAdmin],
    description: 'danger-response emergency deinvest',
    batchSize: 2,
    options: { reportSample: true, sendIfSimulationFailed: true },
    sendTx: deps.sendTx,
  });
  if (investIxs.length > 0) {
    // The caller verifies whether the evacuation completed from this cached state.
    // Refresh after the confirmed deinvest so it does not observe the pre-deinvest cToken balance.
    await kaminoVault.reloadState();
  }

  if (zeroAllocIxs.length === 0 && investIxs.length === 0) {
    logger.error(`[danger-response] No emergency deinvest ixs to send for vault ${kaminoVault.address}`);
  } else {
    logger.error(
      `[danger-response] Emergency deinvest confirmed for vault ${kaminoVault.address}: ${zeroAllocIxs.length} zero-allocation + ${investIxs.length} deinvest ix(s).`
    );
  }
}
