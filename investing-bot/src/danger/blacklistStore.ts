import fs from 'fs';
import pathModule from 'path';
import { isAddress } from '@solana/kit';
import { logger } from 'kvaults-investing-bot-logger';
import { BlacklistFile } from './dangerTypes.js';

const BLACKLIST_LOCK_STALE_MS = 30_000;

/**
 * Single source of truth for reading/writing the danger-detection blacklist file. Used by both the
 * runtime (DangerDetector / DangerCoordinator) and the admin CLI, so the two can never diverge on
 * how this safety-critical state is interpreted or persisted.
 *
 * A missing file is treated as an empty blacklist so fresh local runs and freshly-mounted volumes can
 * start without manual bootstrapping. A missing parent directory, corrupt file, unreadable file, or
 * structurally invalid entry still throws because that indicates the persistence path or existing
 * safety state may be invalid.
 */

function isNonNullObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Checks the fields of one entry, `addressFields` first; `prefix` names the entry in the error. */
function validateEntry(entry: unknown, prefix: string, addressFields: readonly string[]): void {
  const corrupt = (problem: string) => new Error(`${prefix}${problem} Refusing to continue with corrupt safety state.`);
  if (!isNonNullObject(entry)) {
    throw corrupt(' must be an object.');
  }
  for (const field of addressFields) {
    const value = entry[field];
    if (!isNonEmptyString(value) || !isAddress(value)) {
      throw corrupt(`.${field} must be a non-empty Solana address string.`);
    }
  }
  for (const field of ['triggerName', 'reason']) {
    if (!isNonEmptyString(entry[field])) {
      throw corrupt(`.${field} must be a non-empty string.`);
    }
  }
  if (!isNonEmptyString(entry.timestamp) || Number.isNaN(Date.parse(entry.timestamp))) {
    throw corrupt('.timestamp must be a valid timestamp string.');
  }
}

/** Checks the fields of one deposit freeze; `prefix` names the entry in the error. */
function validateDepositFreeze(entry: unknown, prefix: string): void {
  const corrupt = (problem: string) => new Error(`${prefix}${problem} Refusing to continue with corrupt safety state.`);
  if (!isNonNullObject(entry)) {
    throw corrupt(' must be an object.');
  }
  for (const field of ['vault', 'reserve']) {
    const value = entry[field];
    if (!isNonEmptyString(value) || !isAddress(value)) {
      throw corrupt(`.${field} must be a non-empty Solana address string.`);
    }
  }
  for (const field of ['originalCapLamports', 'frozenCapLamports']) {
    const value = entry[field];
    if (typeof value !== 'string' || !/^\d+$/.test(value)) {
      throw corrupt(`.${field} must be a non-negative integer string.`);
    }
  }
  const unresolvedCaps = entry.unresolvedCaps;
  const isIntegerString = (value: unknown) => typeof value === 'string' && /^\d+$/.test(value);
  if (
    unresolvedCaps !== undefined &&
    (!Array.isArray(unresolvedCaps) ||
      !unresolvedCaps.every(
        (sent) =>
          isNonNullObject(sent) && isIntegerString(sent.capLamports) && isIntegerString(sent.expiresAtBlockHeight)
      ))
  ) {
    throw corrupt(
      '.unresolvedCaps must be an array of objects with non-negative integer strings capLamports and expiresAtBlockHeight.'
    );
  }
  if (!isNonEmptyString(entry.timestamp) || Number.isNaN(Date.parse(entry.timestamp))) {
    throw corrupt('.timestamp must be a valid timestamp string.');
  }
}

function validateBlacklistFile(parsed: unknown, path: string): BlacklistFile {
  if (!isNonNullObject(parsed) || !Array.isArray(parsed.blacklistedReserves)) {
    throw new Error(
      `[danger-detection] Invalid blacklist file at ${path}: missing "blacklistedReserves" array. ` +
        `Refusing to continue with corrupt safety state.`
    );
  }

  const blacklistedReserves = parsed.blacklistedReserves;
  blacklistedReserves.forEach((entry, index) =>
    validateEntry(entry, `[danger-detection] Invalid blacklist file at ${path}: blacklistedReserves[${index}]`, [
      'reserve',
    ])
  );

  const pendingEvacuations = parsed.pendingEvacuations ?? [];
  if (!Array.isArray(pendingEvacuations)) {
    throw new Error(
      `[danger-detection] Invalid blacklist file at ${path}: "pendingEvacuations" must be an array. ` +
        `Refusing to continue with corrupt safety state.`
    );
  }
  pendingEvacuations.forEach((entry, index) =>
    validateEntry(entry, `[danger-detection] Invalid blacklist file at ${path}: pendingEvacuations[${index}]`, [
      'vault',
      'reserve',
    ])
  );

  const depositFreezes = parsed.depositFreezes ?? [];
  if (!Array.isArray(depositFreezes)) {
    throw new Error(
      `[danger-detection] Invalid blacklist file at ${path}: "depositFreezes" must be an array. ` +
        `Refusing to continue with corrupt safety state.`
    );
  }
  depositFreezes.forEach((entry, index) =>
    validateDepositFreeze(entry, `[danger-detection] Invalid blacklist file at ${path}: depositFreezes[${index}]`)
  );

  return {
    blacklistedReserves: blacklistedReserves as BlacklistFile['blacklistedReserves'],
    pendingEvacuations: pendingEvacuations as BlacklistFile['pendingEvacuations'],
    depositFreezes: depositFreezes as BlacklistFile['depositFreezes'],
  };
}

/**
 * Read and validate the blacklist file. A missing file or whitespace-only file is a valid empty
 * blacklist. Throws when the parent directory is missing, or when the file exists but is unreadable,
 * not valid JSON, or structurally invalid.
 */
export function readBlacklistFile(path: string): BlacklistFile {
  let raw: string;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const parentDir = pathModule.dirname(path);
      if (!fs.existsSync(parentDir)) {
        throw new Error(
          `[danger-detection] Could not read blacklist file at ${path}: parent directory ${parentDir} does not exist. ` +
            `Create the directory or mount the persistent volume before starting.`
        );
      }
      return { blacklistedReserves: [], pendingEvacuations: [], depositFreezes: [] };
    }
    throw new Error(
      `[danger-detection] Could not read blacklist file at ${path}: ${error}. ` +
        `If the file exists, it must be readable.`
    );
  }

  // An empty (or whitespace-only) file is a valid empty blacklist
  if (raw.trim() === '') {
    return { blacklistedReserves: [], pendingEvacuations: [], depositFreezes: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `[danger-detection] Malformed blacklist file at ${path}: ${error}. Refusing to continue with corrupt safety state.`
    );
  }

  return validateBlacklistFile(parsed, path);
}

/**
 * Persist the blacklist atomically (temp file + rename) so a crash mid-write can never leave a
 * truncated/corrupt blacklist on disk. Throws (fail-closed) if the write cannot be completed.
 */
export function writeBlacklistFile(path: string, blacklist: BlacklistFile): void {
  const tmpPath = `${path}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(blacklist, null, 2), 'utf8');
    fs.renameSync(tmpPath, path);
  } catch (error) {
    logger.error(`[danger-detection] Failed to write blacklist file: ${error}`);
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // best-effort cleanup of the temp file; ignore failure
    }
    // Fail closed: if we couldn't persist a newly blacklisted reserve, surface it so a restart
    // doesn't silently un-block it.
    throw error;
  }
}

/**
 * Serialize a read-modify-write update across the runtime and admin CLI. The lock uses O_EXCL, so
 * two actors can never both read the same old file and overwrite each other's changes. A lock left
 * behind by a crashed process is recoverable after a short stale window.
 */
export function updateBlacklistFile<T>(path: string, update: (blacklist: BlacklistFile) => T): T {
  return withBlacklistLock(path, () => {
    const blacklist = readBlacklistFile(path);
    const result = update(blacklist);
    writeBlacklistFile(path, blacklist);
    return result;
  });
}

/** Runs `action` while holding the blacklist lock, and releases it after. */
function withBlacklistLock<T>(path: string, action: () => T): T {
  const lockPath = `${path}.lock`;
  const lockFd = acquireBlacklistLock(lockPath);
  try {
    return action();
  } finally {
    try {
      fs.closeSync(lockFd);
    } finally {
      fs.unlinkSync(lockPath);
    }
  }
}

function acquireBlacklistLock(lockPath: string): number {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`, 'utf8');
      return fd;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        throw new Error(`[danger-detection] Could not acquire blacklist lock at ${lockPath}: ${error}`, {
          cause: error,
        });
      }

      let lockMtimeMs: number;
      try {
        lockMtimeMs = fs.statSync(lockPath).mtimeMs;
      } catch (statError) {
        // The holder released the lock between our open and this stat: try the open once more.
        if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw statError;
      }
      const ageMs = Date.now() - lockMtimeMs;
      if (attempt === 0 && ageMs > BLACKLIST_LOCK_STALE_MS) {
        logger.warn(`[danger-detection] Removing stale blacklist lock at ${lockPath} (${Math.ceil(ageMs)}ms old)`);
        fs.unlinkSync(lockPath);
        continue;
      }
      throw new Error(
        `[danger-detection] Blacklist update already in progress (lock ${lockPath}, age ${Math.ceil(ageMs)}ms). Retry the operation.`
      );
    }
  }
  throw new Error(`[danger-detection] Could not acquire blacklist lock at ${lockPath}`);
}

/**
 * Explicitly create an empty blacklist file. This is optional bootstrap convenience; runtime reads
 * treat a missing file as empty. Returns false (and does not touch the file) when one already exists,
 * so it can never clobber existing safety state.
 */
export function initBlacklistFile(path: string): boolean {
  return withBlacklistLock(path, () => {
    if (fs.existsSync(path)) {
      return false;
    }
    writeBlacklistFile(path, { blacklistedReserves: [], pendingEvacuations: [], depositFreezes: [] });
    return true;
  });
}

/** The blacklisted reserves and the pending evacuations, as `danger list` prints them. */
export function formatBlacklistFile(blacklist: BlacklistFile): string {
  const lines: string[] = [];
  const section = (title: string, entries: Array<Record<string, string>>, empty: string) => {
    if (entries.length === 0) {
      lines.push(empty, '');
      return;
    }
    lines.push(`${title} (${entries.length}):`, '');
    for (const entry of entries) {
      for (const [label, value] of Object.entries(entry)) {
        lines.push(`  ${`${label}:`.padEnd(10)}${value}`);
      }
      lines.push('');
    }
  };
  section(
    'Blacklisted reserves',
    blacklist.blacklistedReserves.map(({ reserve, triggerName, reason, timestamp }) => ({
      Reserve: reserve,
      Trigger: triggerName,
      Reason: reason,
      Time: timestamp,
    })),
    'No blacklisted reserves.'
  );
  // A pending evacuation keeps its vault out of new investment until the vault holds none of the reserve.
  section(
    'Pending evacuations',
    blacklist.pendingEvacuations.map(({ vault, reserve, triggerName, reason, timestamp }) => ({
      Vault: vault,
      Reserve: reserve,
      Trigger: triggerName,
      Reason: reason,
      Time: timestamp,
    })),
    'No pending evacuations.'
  );
  section(
    'Deposit freezes',
    blacklist.depositFreezes.map(({ vault, reserve, originalCapLamports, frozenCapLamports, timestamp }) => ({
      Vault: vault,
      Reserve: reserve,
      Cap: `${frozenCapLamports} (was ${originalCapLamports})`,
      Time: timestamp,
    })),
    'No deposit freezes.'
  );
  return lines.join('\n').trimEnd();
}
