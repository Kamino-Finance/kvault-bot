import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';
import { config } from 'dotenv';
import { expand } from 'dotenv-expand';
import type { Lightship } from 'lightship';
import { logger } from 'kvaults-investing-bot-logger';
import { Cluster } from 'kvaults-investing-bot-tx/model';
import { getEnvOrDefault, getEnvOrDefaultBool, getEnvOrDefaultNum } from './libs/utils/env.js';
import { isProcessShuttingDown, markProcessShuttingDown } from './utils/shutdown.js';

// always set timezone to UTC
process.env.TZ = 'Universal';

// Select and load the profile before reading any setting from it. Process-level PROFILE/CLUSTER
// choose the file; values inside the file configure the bot, including the health server.
const initialCluster = process.env.CLUSTER || 'mainnet-beta';
const initialProfile = process.env.PROFILE || initialCluster;
const envPath = `../.env.${initialProfile}`;
try {
  const envResult = config({ path: envPath });
  if (envResult.error) {
    console.log(`No .env file found at ${envPath}, using environment variables`);
  } else {
    expand(envResult);
    console.log(`Loaded .env file from ${envPath}`);
  }
} catch (error) {
  console.log(`Failed to load ${envPath}, using environment variables:`, error);
}

// Start the health server before the bot loops.
const server = getEnvOrDefaultBool('SERVER', true);
const port = Number(process.env.SERVER_PORT || '8080');
if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
  throw new Error(`SERVER_PORT must be an integer in [1, 65535], received "${process.env.SERVER_PORT}"`);
}

let lightship: Lightship | undefined;

if (server) {
  // Import and start lightship immediately
  const lightshipModule = await import('lightship');
  const { createLightship } = lightshipModule.default;

  lightship = createLightship({
    detectKubernetes: false,
    port,
  });

  console.log(`✅ kvaults-bot health server is running on port ${port}`);

  console.log('Health server is waiting for loop heartbeats');
}

// Global type declaration for worker reference
declare global {
  var allocationWorker: Worker | undefined;
}

enum LoopName {
  Invest = 'invest-loop',
  AllocationRebalance = 'allocation-rebalance-loop',
}

type LoopHealthState = {
  lastHeartbeatMs: number;
  timeoutMs: number;
};

const LOOP_HEALTH_CHECK_INTERVAL_MS = 15_000;
let loopHealthMonitor: NodeJS.Timeout | undefined;
let lastReadinessState: boolean | undefined;
const loopHealth = new Map<LoopName, LoopHealthState>();

function configureLoopHealth(expectedLoops: LoopName[]) {
  const defaultRpcTimeoutMs = getEnvOrDefaultNum('RPC_REQUEST_TIMEOUT_MS', 2 * 60_000);
  const timeoutMs = getEnvOrDefaultNum('LOOP_HEARTBEAT_TIMEOUT_MS', defaultRpcTimeoutMs * 3);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('LOOP_HEARTBEAT_TIMEOUT_MS must be a positive safe integer');
  }
  loopHealth.clear();
  expectedLoops.forEach((loopName) => {
    loopHealth.set(loopName, {
      lastHeartbeatMs: 0,
      timeoutMs,
    });
  });

  if (loopHealthMonitor) {
    clearInterval(loopHealthMonitor);
  }
  loopHealthMonitor = setInterval(updateReadinessFromHeartbeats, LOOP_HEALTH_CHECK_INTERVAL_MS);
  updateReadinessFromHeartbeats();
}

function markLoopHeartbeat(loopName: LoopName) {
  const state = loopHealth.get(loopName);
  if (!state) {
    return;
  }

  state.lastHeartbeatMs = Date.now();
  updateReadinessFromHeartbeats();
}

function markLoopUnhealthy(loopName: LoopName) {
  const state = loopHealth.get(loopName);
  if (!state) {
    return;
  }

  state.lastHeartbeatMs = 0;
  updateReadinessFromHeartbeats();
}

function updateReadinessFromHeartbeats() {
  if (!lightship) {
    return;
  }

  if (isProcessShuttingDown()) {
    setReadiness(false);
    return;
  }

  const now = Date.now();
  const staleLoops = [...loopHealth.entries()]
    .filter(([, state]) => state.lastHeartbeatMs === 0 || now - state.lastHeartbeatMs > state.timeoutMs)
    .map(([loopName]) => loopName);
  const ready = staleLoops.length === 0;

  if (!ready && lastReadinessState !== false) {
    logger.warn(`[health] marking not ready; stale loops: ${staleLoops.join(', ')}`);
  }

  setReadiness(ready);
}

function setReadiness(ready: boolean) {
  if (!lightship || lastReadinessState === ready) {
    return;
  }

  if (ready) {
    lightship.signalReady();
  } else {
    lightship.signalNotReady();
  }
  lastReadinessState = ready;
}

// Run loops in completely separate async contexts that don't block main thread
async function startLoopAsync(loopName: LoopName, loopFunction: () => Promise<void>) {
  // Use setTimeout instead of setImmediate to ensure we're completely async
  await new Promise((resolve) => setTimeout(resolve, 0));

  try {
    logger.info(`Starting ${loopName}`);
    await loopFunction();
  } catch (error) {
    logger.error(`${loopName} failed to start:`, error);
    markLoopUnhealthy(loopName);
    // Don't crash the process, just log the error
  }
}

const MAX_ALLOCATION_WORKER_RESTARTS = 3;

function startAllocationWorker(cluster: Cluster, previousRestartCount: number = 0) {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = dirname(currentFile);
  const workerPath = join(currentDir, 'allocation_worker.js');

  logger.info('[allocation-worker] Starting allocation loop in worker thread');

  const worker = new Worker(workerPath, {
    workerData: { cluster },
    resourceLimits: {
      maxOldGenerationSizeMb: 4096, // 4GB heap limit
      maxYoungGenerationSizeMb: 2048, // 2GB young generation
    },
  });

  let restartCount = previousRestartCount;
  let restartScheduled = false;

  const scheduleRestart = () => {
    if (restartScheduled || isProcessShuttingDown()) {
      return;
    }
    if (restartCount >= MAX_ALLOCATION_WORKER_RESTARTS) {
      logger.error('[allocation-worker] Max restarts reached, stopping');
      markLoopUnhealthy(LoopName.AllocationRebalance);
      return;
    }

    restartCount++;
    restartScheduled = true;
    logger.info(`[allocation-worker] Restarting worker (${restartCount}/${MAX_ALLOCATION_WORKER_RESTARTS})`);
    setTimeout(() => startAllocationWorker(cluster, restartCount), 5000);
  };

  // Worker event handlers
  worker.on('message', (message) => {
    if (message.type === 'heartbeat') {
      restartCount = 0;
      markLoopHeartbeat(LoopName.AllocationRebalance);
    } else if (message.type === 'error') {
      logger.error('[allocation-worker] Worker error:', message.error);
      markLoopUnhealthy(LoopName.AllocationRebalance);
    }
  });

  worker.on('error', (error) => {
    logger.error('[allocation-worker] Worker error:', error);
    markLoopUnhealthy(LoopName.AllocationRebalance);
  });

  worker.on('exit', (code) => {
    if (isProcessShuttingDown()) {
      return;
    }
    logger.error(`[allocation-worker] Worker exited unexpectedly with code ${code}`);
    markLoopUnhealthy(LoopName.AllocationRebalance);
    scheduleRestart();
  });

  // Store worker reference for shutdown
  globalThis.allocationWorker = worker;

  // Note: Signal handlers are now handled globally in the main process
}

let shutdownTimeout: NodeJS.Timeout | null = null;

const gracefulShutdown = async (signal: string) => {
  if (isProcessShuttingDown()) {
    logger.info(`Shutdown already in progress, ignoring ${signal}`);
    return;
  }

  markProcessShuttingDown();
  logger.info(`Received ${signal}, starting graceful shutdown...`);
  setReadiness(false);

  try {
    // Stop the health server first
    if (lightship) {
      logger.info('Shutting down health server...');
      await lightship.shutdown();
    }

    // Terminate worker thread if it exists
    if (globalThis.allocationWorker) {
      logger.info('Terminating allocation worker...');
      globalThis.allocationWorker.postMessage({ type: 'shutdown' });

      // Give worker 5 seconds to terminate gracefully
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          logger.warn('Worker did not terminate gracefully, forcing termination');
          if (globalThis.allocationWorker) {
            globalThis.allocationWorker.terminate();
          }
          resolve();
        }, 5000);

        if (globalThis.allocationWorker) {
          globalThis.allocationWorker.once('exit', () => {
            clearTimeout(timeout);
            resolve();
          });
        }
      });
    }

    logger.info('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown:', error);
    process.exit(1);
  }
};

// Force exit after timeout
const forceExit = () => {
  logger.error('Force exit after shutdown timeout');
  process.exit(1);
};

// Set up signal handlers with timeout
process.on('SIGINT', () => {
  logger.info('Received SIGINT (Ctrl+C)');
  gracefulShutdown('SIGINT');

  // Force exit after 10 seconds if graceful shutdown fails
  shutdownTimeout = setTimeout(forceExit, 10000);
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM');
  gracefulShutdown('SIGTERM');

  // Force exit after 10 seconds if graceful shutdown fails
  shutdownTimeout = setTimeout(forceExit, 10000);
});

// Clean up timeout on successful exit
process.on('exit', () => {
  if (shutdownTimeout) {
    clearTimeout(shutdownTimeout);
  }
  if (loopHealthMonitor) {
    clearInterval(loopHealthMonitor);
  }
});

async function main() {
  const cluster = getEnvOrDefault('CLUSTER', 'mainnet-beta') as Cluster;
  const profile = getEnvOrDefault('PROFILE', cluster);

  const investLoop = getEnvOrDefaultBool('INVEST_LOOP', false);
  const allocationRebalanceLoop = getEnvOrDefaultBool('ALLOCATION_REBALANCE_LOOP', false);
  configureLoopHealth([
    ...(investLoop ? [LoopName.Invest] : []),
    ...(allocationRebalanceLoop ? [LoopName.AllocationRebalance] : []),
  ]);

  logger.info(`Starting kvaults-bot with cluster: ${cluster}, profile: ${profile}`);
  logger.info(`Invest loop: ${investLoop}, Allocation rebalance loop: ${allocationRebalanceLoop}, Server: ${server}`);

  if (server && !lightship) {
    logger.error('Health server was expected to be running but is not initialized');
  } else if (server) {
    logger.info('Health server is running and waiting for loop heartbeats');
  } else {
    logger.info(`✅ kvaults-bot is running`);
  }

  // Start loops in completely separate async contexts
  if (investLoop) {
    // Don't await - let it run independently
    startLoopAsync(LoopName.Invest, async () => {
      const { runInvestLoop } = await import('./investing_loop.js');
      const { recursiveTryCatch } = await import('./libs/utils/recursiveTryCatch.js');
      await recursiveTryCatch(
        () => runInvestLoop(cluster, () => markLoopHeartbeat(LoopName.Invest)),
        `[${LoopName.Invest}]`
      );
    }).catch((e) => {
      logger.error(`[${LoopName.Invest}] Critical error occurred:`, e);
      markLoopUnhealthy(LoopName.Invest);
    });
  }

  if (allocationRebalanceLoop) {
    // Run allocation loop directly in main thread to avoid worker thread issues
    startAllocationWorker(cluster);
  }

  // If no loops are enabled, just keep the health server running
  if (!investLoop && !allocationRebalanceLoop) {
    logger.info('No loops enabled, running health server only');
  }
}

(async () => {
  await main();
})().catch(async (e) => {
  logger.error('Critical startup error:', e);
  if (lightship) {
    await lightship.shutdown();
  } else {
    process.exit(1);
  }
});
