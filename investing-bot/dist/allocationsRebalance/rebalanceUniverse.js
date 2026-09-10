import { ReserveAllocationConfig, } from '@kamino-finance/klend-sdk';
import { logger } from 'kvaults-investing-bot-logger';
import { RPC_REQUEST_TIMEOUT_MS, withTimeout } from '../utils/timeout.js';
import { getAllocationCapInTokensOrDefault, getReserveAllocationsMap, shouldUpdateAllocation } from './vaultUtils.js';
// Preserve vault allocation order while dropping reserves outside the supplied universe.
export function getVaultReserveAddressesInUniverse(kaminoManager, vaultState, vaultsReserves) {
    return kaminoManager.getVaultReserves(vaultState).filter((reserve) => vaultsReserves.has(reserve));
}
// Current allocation weights, scoped to the same reserve universe used by the strategy.
export function getReserveAllocationsForUniverse(vaultState, vaultsReserves) {
    const currentReservesAllocations = getReserveAllocationsMap(vaultState);
    const allocationsInUniverse = new Map();
    for (const [reserve, allocation] of currentReservesAllocations) {
        if (vaultsReserves.has(reserve)) {
            allocationsInUniverse.set(reserve, allocation);
        }
    }
    return allocationsInUniverse;
}
// Holdings can include reserves outside the strategy universe; APY math must not.
export function getInvestedReservesForUniverse(investedInReservesTokens, vaultsReserves) {
    const investedInReservesTokensMap = new Map();
    investedInReservesTokens.forEach((investedTokens, reserve) => {
        if (vaultsReserves.has(reserve)) {
            investedInReservesTokensMap.set(reserve, investedTokens);
        }
    });
    return investedInReservesTokensMap;
}
function getMissingVaultReserves(vaultReserveAddresses, vaultsReserves) {
    return vaultReserveAddresses.filter((reserveAddr) => !vaultsReserves.has(reserveAddr));
}
async function reloadMissingVaultReserves(kaminoManager, vaultState, kaminoVault, vaultReserveAddresses, vaultsReserves) {
    const missingReserveAddresses = getMissingVaultReserves(vaultReserveAddresses, vaultsReserves);
    if (missingReserveAddresses.length === 0) {
        return;
    }
    logger.warn(`[allocation-rebalance-loop] Vault ${kaminoVault.address.toString()} is missing ${missingReserveAddresses.length} loaded reserve(s), retrying: ${missingReserveAddresses.map((r) => r.toString()).join(', ')}`);
    const reloadedReserves = await withTimeout(kaminoManager.loadVaultReserves(vaultState), RPC_REQUEST_TIMEOUT_MS, `[allocation-rebalance-loop] reload missing vault reserves ${kaminoVault.address.toString()}`);
    reloadedReserves.forEach((reserve, reserveAddr) => {
        vaultsReserves.set(reserveAddr, reserve);
    });
}
/**
 * Build the canonical reserve universe once, before any strategy logic runs.
 */
export async function buildRebalanceUniverse(kaminoManager, kaminoVault, vaultsReserves, signer, blacklistedReserves, cooldownReserves = new Set()) {
    const vaultState = await kaminoVault.getState();
    const healthyVaultReserves = new Map();
    const blacklistedVaultReserves = new Set();
    const cooldownVaultReserves = new Set();
    const forcedZeroIxs = [];
    const vaultReserveAddresses = kaminoManager.getVaultReserves(vaultState);
    // Recover from a partial preload once; unresolved misses are logged below.
    await reloadMissingVaultReserves(kaminoManager, vaultState, kaminoVault, vaultReserveAddresses, vaultsReserves);
    for (const reserveAddr of vaultReserveAddresses) {
        const reserveState = vaultsReserves.get(reserveAddr);
        // Reinvest cooldown (transient): exclude from the optimizer so no NEW allocation flows in, but do
        // NOT force-zero — leave any existing position alone (it belongs to a vault that pulled out or is
        // being held; the cooldown only bars fresh reinvestment). A blacklisted reserve takes precedence.
        if (cooldownReserves.has(reserveAddr.toString()) && !blacklistedReserves.has(reserveAddr.toString())) {
            cooldownVaultReserves.add(reserveAddr.toString());
            continue;
        }
        if (blacklistedReserves.has(reserveAddr.toString())) {
            blacklistedVaultReserves.add(reserveAddr.toString());
            // Excluding a reserve from strategy input is not enough; its on-chain weight must be zeroed.
            if (!reserveState) {
                // Log an error instead of throwing so an unresolved reserve load does not crash the bot.
                logger.error(`[allocation-rebalance-loop] Blacklisted reserve ${reserveAddr} is in vault ${kaminoVault.address.toString()} but could not be loaded; cannot enforce zero allocation`);
                continue;
            }
            const reserveWithAddress = {
                address: reserveAddr,
                state: reserveState.state,
            };
            const allocationCapTokens = getAllocationCapInTokensOrDefault(vaultState, reserveAddr);
            const zeroConfig = new ReserveAllocationConfig(reserveWithAddress, 0, allocationCapTokens);
            if (!shouldUpdateAllocation(vaultState, zeroConfig)) {
                continue;
            }
            logger.warn(`[allocation-rebalance-loop] Enforcing zero allocation for blacklisted reserve ${reserveAddr} in vault ${kaminoVault.address.toString()}`);
            const updateIxs = await kaminoManager.updateVaultReserveAllocationIxs(kaminoVault, zeroConfig, signer);
            forcedZeroIxs.push(updateIxs.updateReserveAllocationIx);
            continue;
        }
        if (!reserveState) {
            // Log an error instead of throwing so an unresolved reserve load does not crash the bot.
            logger.error(`[allocation-rebalance-loop] Reserve ${reserveAddr} not found after retrying vault reserve load`);
            continue;
        }
        healthyVaultReserves.set(reserveAddr, reserveState);
    }
    return { healthyVaultReserves, blacklistedVaultReserves, cooldownVaultReserves, forcedZeroIxs };
}
export async function buildBlacklistEnforcementIxs(kaminoManager, kaminoVault, vaultsReserves, signer, blacklistedReserves, cooldownReserves) {
    const universe = await buildRebalanceUniverse(kaminoManager, kaminoVault, vaultsReserves, signer, blacklistedReserves, cooldownReserves);
    return universe.forcedZeroIxs;
}
//# sourceMappingURL=rebalanceUniverse.js.map