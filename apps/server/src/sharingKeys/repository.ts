export interface SharingKeyInput {
  sharingKeyVersion: number;
  publicKey: string;
  encryptedPrivateKey: string;
  privateKeyNonce: string;
  formatVersion: number;
}

export interface SharingKeyRecord extends SharingKeyInput {
  createdAt: string;
  updatedAt: string;
}

export interface PublicSharingKeyRecord {
  userId: string;
  canonicalHandle: string | null;
  displayName: string | null;
  sharingKeyVersion: number;
  publicKey: string;
  formatVersion: number;
  createdAt: string;
}

export type PutSharingKeyOutcome = "conflict" | "created";

export interface SharingKeyRepository {
  current(userId: string): Promise<SharingKeyRecord | null>;
  version(userId: string, sharingKeyVersion: number): Promise<SharingKeyRecord | null>;
  put(userId: string, input: SharingKeyInput): Promise<PutSharingKeyOutcome>;
  cleanup(userId: string): Promise<number>;
  lookup(canonicalHandle: string): Promise<PublicSharingKeyRecord | null>;
}
