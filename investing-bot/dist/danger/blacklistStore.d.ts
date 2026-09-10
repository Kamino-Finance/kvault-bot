import { BlacklistFile } from './dangerTypes.js';
/**
 * Read and validate the blacklist file. A missing file or whitespace-only file is a valid empty
 * blacklist. Throws when the parent directory is missing, or when the file exists but is unreadable,
 * not valid JSON, or structurally invalid.
 */
export declare function readBlacklistFile(path: string): BlacklistFile;
/**
 * Persist the blacklist atomically (temp file + rename) so a crash mid-write can never leave a
 * truncated/corrupt blacklist on disk. Throws (fail-closed) if the write cannot be completed.
 */
export declare function writeBlacklistFile(path: string, blacklist: BlacklistFile): void;
/**
 * Serialize a read-modify-write update across the runtime and admin CLI. The lock uses O_EXCL, so
 * two actors can never both read the same old file and overwrite each other's changes. A lock left
 * behind by a crashed process is recoverable after a short stale window.
 */
export declare function updateBlacklistFile<T>(path: string, update: (blacklist: BlacklistFile) => T): T;
/**
 * Explicitly create an empty blacklist file. This is optional bootstrap convenience; runtime reads
 * treat a missing file as empty. Returns false (and does not touch the file) when one already exists,
 * so it can never clobber existing safety state.
 */
export declare function initBlacklistFile(path: string): boolean;
//# sourceMappingURL=blacklistStore.d.ts.map