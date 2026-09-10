import { logger } from 'kvaults-investing-bot-logger';
/**
 * Gets a priority fee estimate using Helius' custom RPC method.
 *
 * Note: Helius does *not* support arbitrary percentile numbers [1-100]. The input percentile will be mapped into one of
 * the coarse-grained {@link PriorityLevel}s.
 */
export async function getPriorityFeeEstimate(heliusRpc, addresses, percentile) {
    const priorityLevel = resolvePriorityLevel(percentile);
    logger.info(`Fetching ${priorityLevel} priority fee from RPC for ${addresses.length || 'all global'} accounts`);
    const response = await heliusRpc
        .getPriorityFeeEstimate({
        accountKeys: addresses.map((address) => address.toString()),
        options: { priorityLevel },
    })
        .send();
    return Number(response.priorityFeeEstimate);
}
/**
 * Resolves a coarse-grained priority level for the given percentile.
 *
 * Follows the mapping at https://docs.helius.dev/solana-apis/priority-fee-api#how-priority-fee-api-works.
 */
function resolvePriorityLevel(percentile) {
    if (percentile == 100) {
        return PriorityLevel.UNSAFE_MAX;
    }
    if (percentile >= 95) {
        return PriorityLevel.VERY_HIGH;
    }
    if (percentile >= 75) {
        return PriorityLevel.HIGH;
    }
    if (percentile >= 50) {
        return PriorityLevel.MEDIUM;
    }
    if (percentile >= 25) {
        return PriorityLevel.LOW;
    }
    if (percentile >= 0) {
        return PriorityLevel.MIN;
    }
    throw new Error(`Invalid percentile: ${percentile}`);
}
var PriorityLevel;
(function (PriorityLevel) {
    PriorityLevel["MIN"] = "Min";
    PriorityLevel["LOW"] = "Low";
    PriorityLevel["MEDIUM"] = "Medium";
    PriorityLevel["HIGH"] = "High";
    PriorityLevel["VERY_HIGH"] = "VeryHigh";
    PriorityLevel["UNSAFE_MAX"] = "UnsafeMax";
})(PriorityLevel || (PriorityLevel = {}));
//# sourceMappingURL=helius.js.map