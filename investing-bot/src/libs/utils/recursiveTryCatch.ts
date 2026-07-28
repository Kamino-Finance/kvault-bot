import { logger } from 'kvaults-investing-bot-logger';
import { interruptibleSleep } from '../../utils/loop.js';
import { isProcessShuttingDown } from '../../utils/shutdown.js';

export async function recursiveTryCatch(f: () => Promise<void>, errMsg: string) {
  const MIN_BACKOFF_MS = 1_000;
  const MAX_BACKOFF_MS = 60_000;
  let backoffMs = MIN_BACKOFF_MS;

  while (!isProcessShuttingDown()) {
    try {
      await f();
      return;
    } catch (e) {
      if (isProcessShuttingDown()) {
        return;
      }
      logger.error(`${errMsg} (retrying in ${backoffMs / 1000}s)`, e);
      if (await interruptibleSleep(backoffMs)) {
        return;
      }
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    }
  }
}
