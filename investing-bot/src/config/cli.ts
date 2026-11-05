import path from 'path';
import { fileURLToPath } from 'url';
import { checkConfigDocs, generateConfigDocs } from './docs.js';

// This file sits in investing-bot/src/config or investing-bot/dist/config; the repo root is three levels up.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const command = process.argv[2];
if (command === 'generate') {
  generateConfigDocs(repoRoot);
  console.log('Generated .env.example and the README config tables');
} else if (command === 'check') {
  const problems = checkConfigDocs(repoRoot);
  for (const problem of problems) {
    console.log(problem);
  }
  if (problems.length > 0) {
    process.exit(1);
  }
  console.log('Config docs are up to date');
} else {
  console.error('Usage: node dist/config/cli.js generate|check');
  process.exit(2);
}
