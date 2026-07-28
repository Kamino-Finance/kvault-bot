import { Command } from 'commander';
import { RebalanceStrategy } from './allocationsRebalance/rebalanceTypes.js';
import { initBlacklistFile, readBlacklistFile, updateBlacklistFile } from './danger/blacklistStore.js';
import { DEFAULT_BLACKLIST_PATH } from './libs/utils/consts.js';

/**
 * Default blacklist path for CLI commands: the same DANGER_BLACKLIST_PATH the runtime uses, so an
 * operator running `danger list/clear` without `--path` acts on the live file (e.g. the mounted
 * volume in production) rather than a stale compile-time default in the container's working dir.
 * When the env var is PRESENT it is propagated verbatim (even if blank) so `requireBlacklistPath`
 * can reject a blank value the same way the runtime (`envConfig`) does, instead of silently falling
 * back to a different file. Only when the var is unset do we use the compile-time default.
 */
function defaultBlacklistPath(): string {
  if ('DANGER_BLACKLIST_PATH' in process.env) {
    return process.env.DANGER_BLACKLIST_PATH ?? '';
  }
  return DEFAULT_BLACKLIST_PATH;
}

/**
 * Reject a blank blacklist path before touching the file. Matches the runtime guard in `envConfig`,
 * so the CLI and the bot never disagree about a misconfigured (present-but-empty)
 * DANGER_BLACKLIST_PATH: both refuse rather than silently operating on the wrong file.
 */
function requireBlacklistPath(path: string): string {
  if (path.trim().length === 0) {
    throw new Error(
      'DANGER_BLACKLIST_PATH is set but empty — refusing to operate on an unusable blacklist path. Set it to the intended file or unset it to use the default.'
    );
  }
  return path;
}

async function main() {
  const commands = new Command();

  commands.name('vaults-bot-cli').description('CLI to interact with the vaults bot and config');

  commands.command('print-rebalance-strategies').action(async () => {
    // print all possible values of RebalanceStrategy
    const rebalanceStrategies = Object.values(RebalanceStrategy);
    console.log(rebalanceStrategies);
  });

  const danger = commands.command('danger').description('Manage the danger detection blacklist');

  danger
    .command('init')
    .description('Create an empty blacklist file (no-op if one already exists)')
    .option('--path <path>', 'Path to blacklist file', defaultBlacklistPath())
    .action((opts) => {
      const path = requireBlacklistPath(opts.path);
      const created = initBlacklistFile(path);
      console.log(
        created ? `Created empty blacklist at ${path}.` : `Blacklist already exists at ${path}; leaving it untouched.`
      );
    });

  danger
    .command('list')
    .description('List all blacklisted reserves')
    .option('--path <path>', 'Path to blacklist file', defaultBlacklistPath())
    .action((opts) => {
      const blacklist = readBlacklistFile(requireBlacklistPath(opts.path));
      if (blacklist.blacklistedReserves.length === 0) {
        console.log('No blacklisted reserves.');
        return;
      }
      console.log(`Blacklisted reserves (${blacklist.blacklistedReserves.length}):\n`);
      for (const entry of blacklist.blacklistedReserves) {
        console.log(`  Reserve:  ${entry.reserve}`);
        console.log(`  Trigger:  ${entry.triggerName}`);
        console.log(`  Reason:   ${entry.reason}`);
        console.log(`  Time:     ${entry.timestamp}`);
        console.log('');
      }
    });

  danger
    .command('clear-reserve <address>')
    .description('Remove a specific reserve from the blacklist')
    .option('--path <path>', 'Path to blacklist file', defaultBlacklistPath())
    .action((reserveAddress: string, opts) => {
      const path = requireBlacklistPath(opts.path);
      const removed = updateBlacklistFile(path, (blacklist) => {
        const before = blacklist.blacklistedReserves.length;
        blacklist.blacklistedReserves = blacklist.blacklistedReserves.filter(
          (entry) => entry.reserve !== reserveAddress
        );
        return before - blacklist.blacklistedReserves.length;
      });
      if (removed === 0) {
        console.log(`Reserve ${reserveAddress} was not in the blacklist.`);
        return;
      }
      console.log(`Removed reserve ${reserveAddress} from the blacklist.`);
    });

  danger
    .command('clear-all')
    .description('Clear the entire blacklist')
    .option('--path <path>', 'Path to blacklist file', defaultBlacklistPath())
    .action((opts) => {
      const path = requireBlacklistPath(opts.path);
      const count = updateBlacklistFile(path, (blacklist) => {
        const currentCount = blacklist.blacklistedReserves.length;
        blacklist.blacklistedReserves = [];
        return currentCount;
      });
      if (count === 0) {
        console.log('Blacklist is already empty.');
        return;
      }
      console.log(`Cleared ${count} reserve(s) from the blacklist.`);
    });

  await commands.parseAsync();
}

main()
  .then(() => {
    console.log('\n\nSuccess');
    process.exit();
  })
  .catch((e) => {
    console.error('\n\nKamino CLI exited with error:\n\n', e);
    process.exit(1);
  });
