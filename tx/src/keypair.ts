import { existsSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'fs';
import { createKeyPairSignerFromBytes, createKeyPairSignerFromPrivateKeyBytes, TransactionSigner } from '@solana/kit';
import { KeyPairSigner } from '@solana/signers';
import * as ed25519 from '@noble/ed25519';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

export async function readKeypairFile(path: string): Promise<KeyPairSigner> {
  if (!existsSync(path)) {
    throw new Error(`Wallet file not found at ${path}`);
  }
  const wallet = Buffer.from(JSON.parse(readFileSync(path).toString()));
  return await createKeyPairSignerFromBytes(wallet);
}

export function writeKeypairFile(path: string, bytes: Uint8Array): void {
  const x = `[${[...Buffer.from(bytes)]}]`;
  writeFileSync(path, x, { encoding: 'utf-8' });
}

export async function generateExtractableKeyPairSigner(): Promise<[TransactionSigner, Uint8Array]> {
  const kpBytes = await generateEd25519KeyPair();
  const signer = await createKeyPairSignerFromPrivateKeyBytes(kpBytes.slice(0, 32));
  return [signer, kpBytes];
}

async function generateEd25519KeyPair(): Promise<Uint8Array> {
  // Generate a private key (32 bytes)
  const privateKey = ed25519.utils.randomPrivateKey();

  // Derive the public key (32 bytes)
  const publicKey = ed25519.getPublicKey(privateKey);

  // Concatenate private and public keys (64 bytes total)
  const solanaKeyBytes = new Uint8Array(64);
  solanaKeyBytes.set(privateKey, 0);
  solanaKeyBytes.set(publicKey, 32);

  return solanaKeyBytes;
}
