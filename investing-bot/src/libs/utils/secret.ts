import fs from 'fs';
import { createKeyPairSignerFromBytes, KeyPairSigner } from '@solana/kit';
import { KindSpecWithDefault, readPath } from '../../config/schema.js';
import { getFileMaybeYarnWorkspace } from './file.js';

/**
 * The signer of the keypair file named by `setting`: a JSON array of the 64 secret key bytes. A missing or malformed
 * file throws one error that names the setting and the path.
 */
export async function loadKeypairSigner(setting: KindSpecWithDefault<'path', string>): Promise<KeyPairSigner> {
  const path = readPath(setting);
  try {
    const bytes = JSON.parse(fs.readFileSync(getFileMaybeYarnWorkspace(path), 'utf8'));
    return await createKeyPairSignerFromBytes(Uint8Array.from(bytes));
  } catch (err) {
    throw new Error(
      `${setting.name}: could not load a keypair from ${path}: ${err instanceof Error ? err.message : err}`,
      {
        cause: err,
      }
    );
  }
}
