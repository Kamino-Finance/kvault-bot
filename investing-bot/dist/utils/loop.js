import { sleep } from '@kamino-finance/klend-sdk';
import { isProcessShuttingDown } from './shutdown.js';
const HEARTBEAT_DURING_SLEEP_INTERVAL_MS = 10_000;
/** Sleeps in short intervals so shutdown and health checks are not blocked. */
export async function interruptibleSleep(milliseconds, heartbeat, checkIntervalMilliseconds = 1_000) {
    let sleptMilliseconds = 0;
    let lastHeartbeatAt = 0;
    while (sleptMilliseconds < milliseconds) {
        if (isProcessShuttingDown()) {
            return true;
        }
        const now = Date.now();
        if (heartbeat && now - lastHeartbeatAt >= HEARTBEAT_DURING_SLEEP_INTERVAL_MS) {
            heartbeat();
            lastHeartbeatAt = now;
        }
        const sleepMilliseconds = Math.min(checkIntervalMilliseconds, milliseconds - sleptMilliseconds);
        await sleep(sleepMilliseconds);
        sleptMilliseconds += sleepMilliseconds;
    }
    return isProcessShuttingDown();
}
//# sourceMappingURL=loop.js.map