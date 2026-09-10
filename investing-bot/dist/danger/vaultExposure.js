export function vaultHasExposureToReserves(kaminoManager, vaultState, investedInReservesTokens, reserveAddresses) {
    for (const [reserve, allocation] of kaminoManager.getVaultAllocations(vaultState)) {
        if (!reserveAddresses.has(reserve.toString())) {
            continue;
        }
        const investedTokens = investedInReservesTokens.get(reserve);
        if (allocation.targetWeight.gt(0) || (investedTokens !== undefined && investedTokens.gt(0))) {
            return true;
        }
    }
    return false;
}
export function shouldBlockVaultInvestmentForDanger(kaminoManager, vaultState, investedInReservesTokens, blacklistedReserves, pendingEvacuations) {
    return (pendingEvacuations.size > 0 ||
        vaultHasExposureToReserves(kaminoManager, vaultState, investedInReservesTokens, blacklistedReserves));
}
//# sourceMappingURL=vaultExposure.js.map