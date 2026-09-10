import { KaminoManager } from '@kamino-finance/klend-sdk';
import { KeyPairSigner } from '@solana/kit';
import { ConnectionPool } from 'kvaults-investing-bot-tx/ConnectionPool';
import { Cluster } from 'kvaults-investing-bot-tx/model';
import { AllocationsConfig } from './allocationsRebalance/rebalanceConfig.js';
import { LoopHeartbeat } from './utils/loop.js';
export declare function runAllocationLoop(cluster: Cluster, heartbeat?: LoopHeartbeat): Promise<void>;
export declare function runAllocationRebalanceLoop(allocationsConfig: AllocationsConfig, c: ConnectionPool, initialKaminoManager: KaminoManager, allocationAdmin: KeyPairSigner, gridSearchResolution: number, verbose: boolean, dryRun: boolean, blacklistPath: string, marketPriceMaxAgeSeconds: number, heartbeat?: LoopHeartbeat, refreshKaminoManager?: () => Promise<KaminoManager>): Promise<void>;
//# sourceMappingURL=allocation_loop.d.ts.map