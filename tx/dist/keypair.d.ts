import { TransactionSigner } from '@solana/kit';
import { KeyPairSigner } from '@solana/signers';
export declare function readKeypairFile(path: string): Promise<KeyPairSigner>;
export declare function writeKeypairFile(path: string, bytes: Uint8Array): void;
export declare function generateExtractableKeyPairSigner(): Promise<[TransactionSigner, Uint8Array]>;
//# sourceMappingURL=keypair.d.ts.map