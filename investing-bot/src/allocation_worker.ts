import { parentPort, workerData } from 'worker_threads';
import { logger } from 'kvaults-investing-bot-logger';
import { Cluster } from 'kvaults-investing-bot-tx/model';
import { runAllocationLoop } from './allocation_loop.js';
import { recursiveTryCatch } from './libs/utils/recursiveTryCatch.js';
import { markProcessShuttingDown } from './utils/shutdown.js';

// Memory monitoring and garbage collection utilities
function getMemoryUsage() {
  const usage = process.memoryUsage();
  return {
    rss: Math.round(usage.rss / 1024 / 1024), // MB
    heapUsed: Math.round(usage.heapUsed / 1024 / 1024), // MB
    heapTotal: Math.round(usage.heapTotal / 1024 / 1024), // MB
    external: Math.round(usage.external / 1024 / 1024), // MB
  };
}

function runGarbageCollection() {
  if (global.gc) {
    const beforeGC = getMemoryUsage();
    global.gc();
    const afterGC = getMemoryUsage();

    const memoryFreed = beforeGC.heapUsed - afterGC.heapUsed;
    if (memoryFreed > 0) {
      logger.debug(`[allocation-worker] GC freed ${memoryFreed}MB of memory`);
    }
  }
}

function checkMemoryUsage() {
  const usage = getMemoryUsage();

  // Warn if heap usage is above 3GB (75% of 4GB limit)
  if (usage.heapUsed > 3072) {
    logger.warn(`[allocation-worker] High memory usage detected: ${usage.heapUsed}MB heap used`);
    // Force garbage collection when memory is high
    runGarbageCollection();
  }

  // Log memory usage every 10 minutes
  if (Date.now() % (10 * 60 * 1000) < 30000) {
    // Within 30 seconds of 10-minute mark
    logger.debug(`[allocation-worker] Memory usage: ${usage.heapUsed}MB heap, ${usage.rss}MB RSS`);
  }
}

// Worker thread for allocation loop to prevent blocking main thread
async function startAllocationWorker() {
  let cleanup = () => {};
  try {
    const cluster = workerData.cluster as Cluster;

    logger.info('[allocation-worker] Starting allocation loop in worker thread');

    // Initial memory report
    const initialMemory = getMemoryUsage();
    logger.info(
      `[allocation-worker] Initial memory usage: ${initialMemory.heapUsed}MB heap, ${initialMemory.rss}MB RSS`
    );

    // Set up periodic memory monitoring
    const memoryMonitorInterval = setInterval(checkMemoryUsage, 30000); // Check every 30 seconds

    // Set up periodic garbage collection
    const gcInterval = setInterval(
      () => {
        runGarbageCollection();
      },
      5 * 60 * 1000
    ); // Run GC every 5 minutes

    // Cleanup function
    cleanup = () => {
      clearInterval(memoryMonitorInterval);
      clearInterval(gcInterval);
    };

    // Handle cleanup on exit
    process.on('exit', cleanup);
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    const heartbeat = () => parentPort?.postMessage({ type: 'heartbeat' });

    // Run allocation loop with recursive try-catch
    await recursiveTryCatch(() => runAllocationLoop(cluster, heartbeat), '[allocation-worker]');
    cleanup();
    parentPort?.close();
  } catch (error) {
    logger.error('[allocation-worker] Critical error in allocation worker:', error);
    cleanup();
    parentPort?.postMessage({ type: 'error', error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
    parentPort?.close();
  }
}

// Handle messages from main thread
parentPort?.on('message', (message) => {
  if (message.type === 'shutdown') {
    logger.info('[allocation-worker] Received shutdown signal');

    // Final memory report before shutdown
    const finalMemory = getMemoryUsage();
    logger.info(`[allocation-worker] Final memory usage: ${finalMemory.heapUsed}MB heap, ${finalMemory.rss}MB RSS`);

    markProcessShuttingDown();
  }
});

// Start the worker
startAllocationWorker().catch((error) => {
  logger.error('[allocation-worker] Failed to start allocation worker:', error);
  parentPort?.postMessage({ type: 'error', error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
  parentPort?.close();
});
