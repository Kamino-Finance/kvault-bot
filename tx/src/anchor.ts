import { createHash } from 'node:crypto';

export function ixDiscrim(name: string): Buffer {
  const str = `global:${name}`;
  const hash = createHash('sha256').update(str).digest();
  return hash.subarray(0, 8);
}
