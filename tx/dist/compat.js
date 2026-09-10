import { AccountRole } from '@solana/kit';
export function getAccountRole({ isSigner, isMut }) {
    if (isSigner && isMut) {
        return AccountRole.WRITABLE_SIGNER;
    }
    if (isSigner && !isMut) {
        return AccountRole.READONLY_SIGNER;
    }
    if (!isSigner && isMut) {
        return AccountRole.WRITABLE;
    }
    return AccountRole.READONLY;
}
//# sourceMappingURL=compat.js.map