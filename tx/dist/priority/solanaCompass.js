import { logger } from 'kvaults-investing-bot-logger';
const SOLANA_COMPASS_API_URL = 'https://solanacompass.com/api';
export var RecentPeriod;
(function (RecentPeriod) {
    RecentPeriod[RecentPeriod["ONE_MINUTE"] = 1] = "ONE_MINUTE";
    RecentPeriod[RecentPeriod["FIVE_MINUTES"] = 5] = "FIVE_MINUTES";
    RecentPeriod[RecentPeriod["FIFTEEN_MINUTES"] = 15] = "FIFTEEN_MINUTES";
})(RecentPeriod || (RecentPeriod = {}));
export async function getAverageFeesPerCUForPeriodLamports(fetcher, period) {
    const averageFees = await getAverageFees(fetcher);
    // I can't work out how to get the average CU per tx per block, so we assume it's the default 200,000 CU
    // -5000 because the base fee is included
    return Math.max(averageFees[period].avg - 5000, 0) / 200_000;
}
export async function getAverageFees(fetcher) {
    logger.info(`Fetching global average fees from Solana Compass`);
    const res = await fetcher(`${SOLANA_COMPASS_API_URL}/fees`);
    const fees = (await res.json());
    logger.info(`Fetched ${JSON.stringify(fees)} average fees from Solana Compass`);
    return fees;
}
//# sourceMappingURL=solanaCompass.js.map