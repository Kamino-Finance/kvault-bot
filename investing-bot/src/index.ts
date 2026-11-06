import './loadProfileEnv.js';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';
import type { Lightship } from 'lightship';
import { logger } from 'kvaults-investing-bot-logger';
import { Cluster, parseCluster } from 'kvaults-investing-bot-tx/model';
import { readBoolean, readNumber, readString } from './config/schema.js';
import { SETTINGS } from './config/settings.js';
import { isProcessShuttingDown, markProcessShuttingDown } from './utils/shutdown.js';
import { AllocationWorkerSupervisor } from './allocationWorkerSupervisor.js';
import { LoopHealth } from './utils/loopHealth.js';

// Start the health server before the bot loops.
const server = readBoolean(SETTINGS.SERVER);
const port = Number(process.env.SERVER_PORT || SETTINGS.SERVER_PORT.default);
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
    // The application's handlers own the shutdown order: worker first, health server last.
    signals: [],
  });

  console.log(`✅ kvaults-bot health server is running on port ${port}`);

  console.log('Health server is waiting for loop heartbeats');
}

enum LoopName {
  Invest = 'invest-loop',
  AllocationRebalance = 'allocation-rebalance-loop',
}

const LOOP_HEALTH_CHECK_INTERVAL_MS = 15_000;
let loopHealthMonitor: NodeJS.Timeout | undefined;
let loopHealth: LoopHealth<LoopName> | undefined;

function configureLoopHealth(expectedLoops: LoopName[]) {
  const defaultRpcTimeoutMs = readNumber(SETTINGS.RPC_REQUEST_TIMEOUT_MS);
  const timeoutMs = readNumber(SETTINGS.LOOP_HEARTBEAT_TIMEOUT_MS) ?? defaultRpcTimeoutMs * 3;
  const health = new LoopHealth(
    expectedLoops,
    timeoutMs,
    lightship ? (ready) => (ready ? lightship!.signalReady() : lightship!.signalNotReady()) : undefined,
    isProcessShuttingDown
  );
  loopHealth = health;

  if (loopHealthMonitor) {
    clearInterval(loopHealthMonitor);
  }
  loopHealthMonitor = setInterval(() => health.update(), LOOP_HEALTH_CHECK_INTERVAL_MS);
  health.update();
}

function markLoopHeartbeat(loopName: LoopName) {
  loopHealth?.markHeartbeat(loopName);
}

function markLoopUnhealthy(loopName: LoopName) {
  loopHealth?.markUnhealthy(loopName);
}

// Run loops in completely separate async contexts that don't block main thread
async function startLoopAsync(loopName: LoopName, loopFunction: () => Promise<void>) {
  // Use setTimeout instead of setImmediate to ensure we're completely async
  await new Promise((resolve) => setTimeout(resolve, 0));

  try {
    logger.info(`Starting ${loopName}`);
    await loopFunction();
  } catch (error) {
    logger.error(`${loopName} failed:`, error);
    markLoopUnhealthy(loopName);
    // Don't crash the process, just log the error
  }
}

function createAllocationWorkerSupervisor(cluster: Cluster): AllocationWorkerSupervisor {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = dirname(currentFile);
  const workerPath = join(currentDir, 'allocation_worker.js');

  return new AllocationWorkerSupervisor({
    createWorker: () =>
      new Worker(workerPath, {
        workerData: { cluster },
        resourceLimits: {
          maxOldGenerationSizeMb: 4096, // 4GB heap limit
          maxYoungGenerationSizeMb: 2048, // 2GB young generation
        },
      }),
    onHeartbeat: () => markLoopHeartbeat(LoopName.AllocationRebalance),
    onUnhealthy: () => markLoopUnhealthy(LoopName.AllocationRebalance),
    onDangerStatus: (failing) => loopHealth?.setDangerPassesFailing(failing),
    onNoNewFundsReserves: (reserves) => {
      noNewFundsReserves = new Set(reserves);
    },
    isShuttingDown: isProcessShuttingDown,
  });
}

let allocationSupervisor: AllocationWorkerSupervisor | null = null;
/**
 * Deposit exclusions from the last successful danger pass. A worker restart retains them until its first successful pass.
 */
let noNewFundsReserves: ReadonlySet<string> = new Set();

let shutdownTimeout: NodeJS.Timeout | null = null;

const gracefulShutdown = async (signal: string) => {
  if (isProcessShuttingDown()) {
    logger.info(`Shutdown already in progress, ignoring ${signal}`);
    return;
  }

  markProcessShuttingDown();
  logger.info(`Received ${signal}, starting graceful shutdown...`);
  lightship?.signalNotReady();

  try {
    // Terminate worker thread if it exists
    if (allocationSupervisor) {
      await allocationSupervisor.stop();
    }

    // Lightship last: its shutdown sleeps, then schedules its own process exit, so the worker must be
    // told to stop before that clock starts.
    if (lightship) {
      logger.info('Shutting down health server...');
      await lightship.shutdown();
    }

    logger.info('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown:', error);
    process.exit(1);
  }
};

/**
 * Force exit when graceful shutdown does not finish: after the worker's 5 s termination grace and lightship's 5 s
 * shutdown delay, with margin, and inside Kubernetes' default 30 s termination grace period.
 */
const FORCE_EXIT_AFTER_MS = 20_000;

// Force exit after timeout
const forceExit = () => {
  logger.error('Force exit after shutdown timeout');
  process.exit(1);
};

// Set up signal handlers with timeout
process.on('SIGINT', () => {
  logger.info('Received SIGINT (Ctrl+C)');
  gracefulShutdown('SIGINT');

  shutdownTimeout = setTimeout(forceExit, FORCE_EXIT_AFTER_MS);
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM');
  gracefulShutdown('SIGTERM');

  shutdownTimeout = setTimeout(forceExit, FORCE_EXIT_AFTER_MS);
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
  const cluster = parseCluster(readString(SETTINGS.CLUSTER));
  const profile = readString(SETTINGS.PROFILE) ?? cluster;

  const investLoop = readBoolean(SETTINGS.INVEST_LOOP);
  const allocationRebalanceLoop = readBoolean(SETTINGS.ALLOCATION_REBALANCE_LOOP);
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

  // Validate enabled loops before startup to avoid retrying invalid settings. The worker reads them again in its thread.
  const investing = investLoop ? await import('./investing_loop.js') : undefined;
  const investStart = await investing?.loadInvestLoopStart();
  if (allocationRebalanceLoop) {
    const { loadAllocationLoopStart } = await import('./allocation_loop.js');
    await loadAllocationLoopStart();
  }

  // Start loops in completely separate async contexts
  if (investing && investStart) {
    // Don't await - let it run independently. startLoopAsync handles every error.
    void startLoopAsync(LoopName.Invest, async () => {
      const { recursiveTryCatch } = await import('./libs/utils/recursiveTryCatch.js');
      await recursiveTryCatch(
        () =>
          investing.runInvestLoop(
            cluster,
            investStart,
            () => markLoopHeartbeat(LoopName.Invest),
            () => noNewFundsReserves
          ),
        `[${LoopName.Invest}]`
      );
    });
  }

  if (allocationRebalanceLoop) {
    // The allocation loop runs in a supervised worker thread.
    allocationSupervisor = createAllocationWorkerSupervisor(cluster);
    allocationSupervisor.start();
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
