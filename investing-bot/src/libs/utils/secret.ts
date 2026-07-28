import fs from 'fs';
import { logger } from 'kvaults-investing-bot-logger';
import { getEnvOrDefault } from './env.js';
import { FileNotFound, getFileMaybeYarnWorkspace } from './file.js';

export function readSecret(secretName: string, envSecretPath?: string) {
  const envSecretPathName = envSecretPath ?? 'SECRET_PATH';
  const path = getEnvOrDefault(envSecretPathName, `/run/secrets/${secretName}`);
  try {
    return fs.readFileSync(getFileMaybeYarnWorkspace(path), 'utf8');
  } catch (err) {
    if (!(err instanceof FileNotFound) && err.code !== 'ENOENT') {
      logger.error(`An error occurred while trying to read the secret path: ${path}. Err: ${err}`);
    } else {
      logger.error(`Could not find the secret,: ${secretName}. Err: ${err}`);
    }
    throw new Error(`Could not read secret "${secretName}" from ${path}`, { cause: err });
  }
}
