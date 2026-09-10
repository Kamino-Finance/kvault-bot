import { Decimal } from 'decimal.js';
import { ReserveAllocationConfig, } from '@kamino-finance/klend-sdk';
import { logger } from 'kvaults-investing-bot-logger';
import { computeOverallVaultAPYFromReservesMap } from '../utils/allocationHelper.js';
import { getAllocationCapInTokensOrDefault, shouldUpdateAllocation } from '../vaultUtils.js';
import { DEFAULT_ALLOCATION_WEIGHT } from '../consts.js';
import { getReserveAllocationsForUniverse, getVaultReserveAddressesInUniverse } from '../rebalanceUniverse.js';
export async function getUnchangedAllocationRebalanceIxs(kaminoManager, kaminoVault, vaultsReserves, currentLedgerInstant, compoundingPeriods = 1, verbose = false, allVaultReserves = vaultsReserves, forcedZeroReserves = new Set()) {
    const vaultState = await kaminoVault.getState();
    const vaultHoldings = await kaminoManager.getVaultHoldings(vaultState, currentLedgerInstant, allVaultReserves, currentLedgerInstant);
    const currentReservesAllocations = getReserveAllocationsForUniverse(vaultState, vaultsReserves);
    const bestAllocation = {
        reservesWithAllocation: currentReservesAllocations,
        apy: computeOverallVaultAPYFromReservesMap(currentReservesAllocations, currentReservesAllocations, vaultHoldings.totalAUMIncludingFees.sub(vaultHoldings.pendingFees ?? 0), vaultHoldings.investedInReserves, vaultsReserves, currentLedgerInstant, compoundingPeriods, verbose, {
            vaultState,
            vaultAUMTokens: vaultHoldings.totalAUMIncludingFees.sub(vaultHoldings.pendingFees ?? 0),
            currentVaultAllocations: kaminoManager.getVaultAllocations(vaultState),
            allVaultReserves,
            currentLedgerInstant,
            forcedZeroReserves,
        }),
    };
    return { ixns: [], bestAllocation };
}
export async function getFixedWeightsAllocationRebalanceIxs(kaminoManager, kaminoVault, vaultsReserves, fixedReservesWeights, signer, currentLedgerInstant, compoundingPeriods = 1, verbose = false, allVaultReserves = vaultsReserves, forcedZeroReserves = new Set()) {
    const vaultState = await kaminoVault.getState();
    const currentReservesWithWeights = getReserveAllocationsForUniverse(vaultState, vaultsReserves);
    const allocationRebalanceIxs = [];
    const bestAllocation = {
        reservesWithAllocation: new Map(),
        apy: new Decimal(0),
    };
    for (const [reserve] of currentReservesWithWeights) {
        const fixedReserveWeight = fixedReservesWeights.find(({ reserve: configuredReserve }) => configuredReserve === reserve);
        if (!fixedReserveWeight) {
            continue;
        }
        const kaminoReserveState = vaultsReserves.get(reserve);
        if (!kaminoReserveState) {
            throw new Error(`Reserve ${reserve} not found`);
        }
        bestAllocation.reservesWithAllocation.set(reserve, new Decimal(fixedReserveWeight.weight));
        const reserveWithAddress = {
            address: reserve,
            state: kaminoReserveState.state,
        };
        const reserveAllocationConfig = new ReserveAllocationConfig(reserveWithAddress, fixedReserveWeight.weight, getAllocationCapInTokensOrDefault(vaultState, reserve));
        if (shouldUpdateAllocation(vaultState, reserveAllocationConfig)) {
            logger.info(`[allocation-rebalance-loop] Updating reserve allocation for vault ${kaminoVault.address.toString()} with reserve ${reserve} to weight ${fixedReserveWeight.weight}`);
            const updateIxs = await kaminoManager.updateVaultReserveAllocationIxs(kaminoVault, reserveAllocationConfig, signer);
            allocationRebalanceIxs.push(updateIxs.updateReserveAllocationIx);
        }
    }
    const vaultHoldings = await kaminoManager.getVaultHoldings(vaultState, currentLedgerInstant, allVaultReserves, currentLedgerInstant);
    bestAllocation.apy = computeOverallVaultAPYFromReservesMap(bestAllocation.reservesWithAllocation, getReserveAllocationsForUniverse(vaultState, vaultsReserves), vaultHoldings.totalAUMIncludingFees.sub(vaultHoldings.pendingFees ?? 0), vaultHoldings.investedInReserves, vaultsReserves, currentLedgerInstant, compoundingPeriods, verbose, {
        vaultState,
        vaultAUMTokens: vaultHoldings.totalAUMIncludingFees.sub(vaultHoldings.pendingFees ?? 0),
        currentVaultAllocations: kaminoManager.getVaultAllocations(vaultState),
        allVaultReserves,
        currentLedgerInstant,
        forcedZeroReserves,
    });
    return { ixns: allocationRebalanceIxs, bestAllocation };
}
export async function getEqualAllocationRebalanceIxs(kaminoManager, kaminoVault, vaultsReserves, signer, currentLedgerInstant, compoundingPeriods = 1, verbose = false, allVaultReserves = vaultsReserves, forcedZeroReserves = new Set()) {
    const vaultState = await kaminoVault.getState();
    const reserves = getVaultReserveAddressesInUniverse(kaminoManager, vaultState, vaultsReserves);
    const vaultHoldings = await kaminoManager.getVaultHoldings(vaultState, currentLedgerInstant, allVaultReserves, currentLedgerInstant);
    const allocationRebalanceIxs = [];
    const bestAllocation = {
        reservesWithAllocation: new Map(),
        apy: new Decimal(0),
    };
    logger.info(`[allocation-rebalance-loop] Rebalancing allocation for vault ${kaminoVault.address.toString()}; strategy: EQUAL; ${reserves
        .map((reserve) => `Reserve ${reserve.toString()} weight: ${DEFAULT_ALLOCATION_WEIGHT};`)
        .join(' ')}`);
    for (const reserve of reserves) {
        const kaminoReserveState = vaultsReserves.get(reserve);
        if (!kaminoReserveState) {
            throw new Error(`Reserve ${reserve} not found`);
        }
        bestAllocation.reservesWithAllocation.set(reserve, new Decimal(DEFAULT_ALLOCATION_WEIGHT));
        const reserveAllocationConfig = new ReserveAllocationConfig({ address: reserve, state: kaminoReserveState.state }, DEFAULT_ALLOCATION_WEIGHT, getAllocationCapInTokensOrDefault(vaultState, reserve));
        if (shouldUpdateAllocation(vaultState, reserveAllocationConfig)) {
            const updateIxs = await kaminoManager.updateVaultReserveAllocationIxs(kaminoVault, reserveAllocationConfig, signer);
            allocationRebalanceIxs.push(updateIxs.updateReserveAllocationIx);
        }
    }
    bestAllocation.apy = computeOverallVaultAPYFromReservesMap(bestAllocation.reservesWithAllocation, getReserveAllocationsForUniverse(vaultState, vaultsReserves), vaultHoldings.totalAUMIncludingFees.sub(vaultHoldings.pendingFees ?? 0), vaultHoldings.investedInReserves, vaultsReserves, currentLedgerInstant, compoundingPeriods, verbose, {
        vaultState,
        vaultAUMTokens: vaultHoldings.totalAUMIncludingFees.sub(vaultHoldings.pendingFees ?? 0),
        currentVaultAllocations: kaminoManager.getVaultAllocations(vaultState),
        allVaultReserves,
        currentLedgerInstant,
        forcedZeroReserves,
    });
    return { ixns: allocationRebalanceIxs, bestAllocation };
}
export async function getRandomAllocationRebalanceIxs(kaminoManager, kaminoVault, vaultsReserves, signer, currentLedgerInstant, compoundingPeriods = 1, verbose = false, allVaultReserves = vaultsReserves, forcedZeroReserves = new Set()) {
    const vaultState = await kaminoVault.getState();
    const reserves = getVaultReserveAddressesInUniverse(kaminoManager, vaultState, vaultsReserves);
    const vaultHoldings = await kaminoManager.getVaultHoldings(vaultState, currentLedgerInstant, allVaultReserves, currentLedgerInstant);
    const weights = reserves.map(() => Math.floor(Math.random() * 100_000) + 100);
    const allocationRebalanceIxs = [];
    const bestAllocation = {
        reservesWithAllocation: new Map(),
        apy: new Decimal(0),
    };
    logger.info(`[allocation-rebalance-loop] Rebalancing allocation for vault ${kaminoVault.address.toString()}; strategy: RANDOM; ${reserves
        .map((reserve, index) => `Reserve ${reserve.toString()} weight: ${weights[index]};`)
        .join(' ')}`);
    for (let index = 0; index < reserves.length; index++) {
        const reserve = reserves[index];
        const weight = weights[index];
        const kaminoReserveState = vaultsReserves.get(reserve);
        if (!kaminoReserveState) {
            throw new Error(`Reserve ${reserve} not found`);
        }
        const reserveAllocationConfig = new ReserveAllocationConfig({ address: reserve, state: kaminoReserveState.state }, weight, getAllocationCapInTokensOrDefault(vaultState, reserve));
        if (shouldUpdateAllocation(vaultState, reserveAllocationConfig)) {
            const updateIxs = await kaminoManager.updateVaultReserveAllocationIxs(kaminoVault, reserveAllocationConfig, signer);
            allocationRebalanceIxs.push(updateIxs.updateReserveAllocationIx);
        }
        bestAllocation.reservesWithAllocation.set(reserve, new Decimal(weight));
    }
    bestAllocation.apy = computeOverallVaultAPYFromReservesMap(bestAllocation.reservesWithAllocation, getReserveAllocationsForUniverse(vaultState, vaultsReserves), vaultHoldings.totalAUMIncludingFees.sub(vaultHoldings.pendingFees ?? 0), vaultHoldings.investedInReserves, vaultsReserves, currentLedgerInstant, compoundingPeriods, verbose, {
        vaultState,
        vaultAUMTokens: vaultHoldings.totalAUMIncludingFees.sub(vaultHoldings.pendingFees ?? 0),
        currentVaultAllocations: kaminoManager.getVaultAllocations(vaultState),
        allVaultReserves,
        currentLedgerInstant,
        forcedZeroReserves,
    });
    return { ixns: allocationRebalanceIxs, bestAllocation };
}
//# sourceMappingURL=basic.js.map