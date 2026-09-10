import { createHash } from 'node:crypto';
export function ixDiscrim(name) {
    const str = `global:${name}`;
    const hash = createHash('sha256').update(str).digest();
    return hash.subarray(0, 8);
}
//# sourceMappingURL=anchor.js.map