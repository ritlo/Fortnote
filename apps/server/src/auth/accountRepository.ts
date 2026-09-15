export interface AccountIdentity {
  id: string;
  username: string;
  displayName: string | null;
  canonicalHandle: string | null;
}

export interface KdfParametersRecord {
  authKdfSalt: string;
  authKdfOpsLimit: number;
  authKdfMemLimit: number;
  authKdfVersion: number;
  vaultKdfSalt: string;
  vaultKdfOpsLimit: number;
  vaultKdfMemLimit: number;
  vaultKdfVersion: number;
}

export interface RecoveryParametersRecord {
  userId: string;
  recoveryEncryptedRootKey: string;
  recoveryRootKeyNonce: string;
  recoveryRootKeyFormatVersion: number;
  recoveryRootKeyContextVersion: number;
  recoveryKdfSalt: string;
  recoveryKdfOpsLimit: number;
  recoveryKdfMemLimit: number;
  recoveryKdfVersion: number;
  keyMaterialVersion: number;
}

export interface RecoveryVerifierRecord {
  id: string;
  recoveryAuthVerifierHash: string;
  keyMaterialVersion: number;
}

export interface RegisterAccountInput {
  user: {
    id: string;
    username: string;
    displayName: string;
    canonicalHandle: string;
    authVerifierHash: string;
    authKdfSalt: string;
    authKdfOpsLimit: number;
    authKdfMemLimit: number;
    authKdfVersion: number;
  };
  keyMaterial: {
    encryptedRootKey: string;
    rootKeyNonce: string;
    kdfSalt: string;
    kdfOpsLimit: number;
    kdfMemLimit: number;
    kdfVersion: number;
    recoveryEncryptedRootKey: string;
    recoveryRootKeyNonce: string;
    recoveryAuthVerifierHash: string;
    recoveryKdfSalt: string;
    recoveryKdfOpsLimit: number;
    recoveryKdfMemLimit: number;
    recoveryKdfVersion: number;
  };
}

export interface RecoverAccountInput {
  userId: string;
  expectedKeyMaterialVersion: number;
  newAuthVerifierHash: string;
  authKdf: {
    salt: string;
    opsLimit: number;
    memLimit: number;
    version: number;
  };
  vaultKdf: {
    salt: string;
    opsLimit: number;
    memLimit: number;
    version: number;
  };
  encryptedRootKey: string;
  rootKeyNonce: string;
  rootKeyFormatVersion: number;
  rootKeyContextVersion: number;
}

export type RecoverAccountOutcome =
  | { kind: "recovered"; token: string; revokedSessionIds: string[] }
  | { kind: "conflict" };

export interface KeyMaterialRecord {
  encryptedRootKey: string;
  rootKeyNonce: string;
  rootKeyFormatVersion: number;
  rootKeyContextVersion: number;
  kdfSalt: string;
  kdfOpsLimit: number;
  kdfMemLimit: number;
  kdfVersion: number;
  recoveryEncryptedRootKey: string;
  recoveryRootKeyNonce: string;
  recoveryRootKeyFormatVersion: number;
  recoveryRootKeyContextVersion: number;
  recoveryKdfSalt: string;
  recoveryKdfOpsLimit: number;
  recoveryKdfMemLimit: number;
  recoveryKdfVersion: number;
  keyMaterialVersion: number;
}

interface KdfInput {
  salt: string;
  opsLimit: number;
  memLimit: number;
  version: number;
}

export interface RotateKeyMaterialInput {
  userId: string;
  expectedKeyMaterialVersion: number;
  encryptedRootKey: string;
  rootKeyNonce: string;
  rootKeyFormatVersion: number;
  rootKeyContextVersion: number;
  vaultKdf: KdfInput;
  auth?: { verifierHash: string; kdf: KdfInput };
  recovery?: {
    encryptedRootKey: string;
    rootKeyNonce: string;
    rootKeyFormatVersion: number;
    rootKeyContextVersion: number;
    verifierHash: string;
    kdf: KdfInput;
  };
}

export type RotateKeyMaterialOutcome =
  | {
      kind: "rotated";
      keyMaterialVersion: number;
      replacementToken: string | null;
      revokedSessionIds: string[];
    }
  | { kind: "conflict" }
  | { kind: "not-found" };

export interface AccountRepository {
  findIdentity(canonicalHandle: string): Promise<AccountIdentity | null>;
  kdfParameters(userId: string): Promise<KdfParametersRecord | null>;
  recoveryParameters(userId: string): Promise<RecoveryParametersRecord | null>;
  authVerifierHash(userId: string): Promise<string | null>;
  recoveryVerifier(userId: string): Promise<RecoveryVerifierRecord | null>;
  register(input: RegisterAccountInput): Promise<void>;
  recover(input: RecoverAccountInput): Promise<RecoverAccountOutcome>;
  keyMaterial(userId: string): Promise<KeyMaterialRecord | null>;
  rotateKeyMaterial(input: RotateKeyMaterialInput): Promise<RotateKeyMaterialOutcome>;
}
