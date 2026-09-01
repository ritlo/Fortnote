import { randomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import { hashToken } from "./session.js";

export interface AccountIdentity {
  id: string;
  username: string;
  displayName: string | null;
  canonicalHandle: string | null;
  handleState: string;
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
  findIdentity(
    suppliedHandle: string,
    canonicalHandle: string | null
  ): Promise<AccountIdentity | null>;
  kdfParameters(userId: string): Promise<KdfParametersRecord | null>;
  recoveryParameters(userId: string): Promise<RecoveryParametersRecord | null>;
  authVerifierHash(userId: string): Promise<string | null>;
  recoveryVerifier(userId: string): Promise<RecoveryVerifierRecord | null>;
  register(input: RegisterAccountInput): Promise<void>;
  activateHandle(userId: string, canonicalHandle: string): Promise<boolean>;
  recover(input: RecoverAccountInput): Promise<RecoverAccountOutcome>;
  keyMaterial(userId: string): Promise<KeyMaterialRecord | null>;
  rotateKeyMaterial(
    input: RotateKeyMaterialInput
  ): Promise<RotateKeyMaterialOutcome>;
}

type SqliteDatabase = BetterSQLite3Database<typeof schema>;

const identitySelection = {
  id: schema.users.id,
  username: schema.users.username,
  displayName: schema.users.displayName,
  canonicalHandle: schema.users.canonicalHandle,
  handleState: schema.users.handleState
};

export class SqliteAccountRepository implements AccountRepository {
  constructor(
    private readonly orm: SqliteDatabase,
    private readonly sessionIdleTimeoutMs: number,
    private readonly sessionAbsoluteTimeoutMs: number
  ) {}

  findIdentity(
    suppliedHandle: string,
    canonicalHandle: string | null
  ): Promise<AccountIdentity | null> {
    if (canonicalHandle) {
      const canonical = this.orm
        .select(identitySelection)
        .from(schema.users)
        .where(eq(schema.users.canonicalHandle, canonicalHandle))
        .get();
      if (canonical) {
        return Promise.resolve(canonical);
      }
    }
    const legacy = this.orm
      .select(identitySelection)
      .from(schema.users)
      .where(
        and(
          isNull(schema.users.canonicalHandle),
          eq(schema.users.username, suppliedHandle)
        )
      )
      .get();
    return Promise.resolve(legacy ?? null);
  }

  kdfParameters(userId: string): Promise<KdfParametersRecord | null> {
    const row = this.orm
      .select({
        authKdfSalt: schema.users.authKdfSalt,
        authKdfOpsLimit: schema.users.authKdfOpsLimit,
        authKdfMemLimit: schema.users.authKdfMemLimit,
        authKdfVersion: schema.users.authKdfVersion,
        vaultKdfSalt: schema.userKeyMaterial.kdfSalt,
        vaultKdfOpsLimit: schema.userKeyMaterial.kdfOpsLimit,
        vaultKdfMemLimit: schema.userKeyMaterial.kdfMemLimit,
        vaultKdfVersion: schema.userKeyMaterial.kdfVersion
      })
      .from(schema.users)
      .innerJoin(schema.userKeyMaterial, eq(schema.userKeyMaterial.userId, schema.users.id))
      .where(eq(schema.users.id, userId))
      .get();
    return Promise.resolve(row ?? null);
  }

  recoveryParameters(userId: string): Promise<RecoveryParametersRecord | null> {
    const row = this.orm
      .select({
        userId: schema.userKeyMaterial.userId,
        recoveryEncryptedRootKey: schema.userKeyMaterial.recoveryEncryptedRootKey,
        recoveryRootKeyNonce: schema.userKeyMaterial.recoveryRootKeyNonce,
        recoveryRootKeyFormatVersion: schema.userKeyMaterial.recoveryRootKeyFormatVersion,
        recoveryRootKeyContextVersion: schema.userKeyMaterial.recoveryRootKeyContextVersion,
        recoveryKdfSalt: schema.userKeyMaterial.recoveryKdfSalt,
        recoveryKdfOpsLimit: schema.userKeyMaterial.recoveryKdfOpsLimit,
        recoveryKdfMemLimit: schema.userKeyMaterial.recoveryKdfMemLimit,
        recoveryKdfVersion: schema.userKeyMaterial.recoveryKdfVersion,
        keyMaterialVersion: schema.userKeyMaterial.keyMaterialVersion
      })
      .from(schema.userKeyMaterial)
      .where(eq(schema.userKeyMaterial.userId, userId))
      .get();
    return Promise.resolve(row ?? null);
  }

  authVerifierHash(userId: string): Promise<string | null> {
    const row = this.orm
      .select({ authVerifierHash: schema.users.authVerifierHash })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .get();
    return Promise.resolve(row?.authVerifierHash ?? null);
  }

  recoveryVerifier(userId: string): Promise<RecoveryVerifierRecord | null> {
    const row = this.orm
      .select({
        id: schema.users.id,
        recoveryAuthVerifierHash: schema.userKeyMaterial.recoveryAuthVerifierHash,
        keyMaterialVersion: schema.userKeyMaterial.keyMaterialVersion
      })
      .from(schema.users)
      .innerJoin(schema.userKeyMaterial, eq(schema.userKeyMaterial.userId, schema.users.id))
      .where(eq(schema.users.id, userId))
      .get();
    return Promise.resolve(row ?? null);
  }

  register(input: RegisterAccountInput): Promise<void> {
    this.orm.transaction((transaction) => {
      transaction.insert(schema.users).values({
        ...input.user,
        handleState: "active"
      }).run();
      transaction.insert(schema.userKeyMaterial).values({
        userId: input.user.id,
        ...input.keyMaterial
      }).run();
    });
    return Promise.resolve();
  }

  activateHandle(userId: string, canonicalHandle: string): Promise<boolean> {
    const result = this.orm
      .update(schema.users)
      .set({
        username: canonicalHandle,
        canonicalHandle,
        handleState: "active",
        updatedAt: sql`CURRENT_TIMESTAMP`
      })
      .where(and(eq(schema.users.id, userId), isNull(schema.users.canonicalHandle)))
      .run();
    return Promise.resolve(result.changes === 1);
  }

  recover(input: RecoverAccountInput): Promise<RecoverAccountOutcome> {
    const outcome = this.orm.transaction((transaction) => {
      const keyMaterialUpdate = transaction
        .update(schema.userKeyMaterial)
        .set({
          encryptedRootKey: input.encryptedRootKey,
          rootKeyNonce: input.rootKeyNonce,
          rootKeyFormatVersion: input.rootKeyFormatVersion,
          rootKeyContextVersion: input.rootKeyContextVersion,
          kdfSalt: input.vaultKdf.salt,
          kdfOpsLimit: input.vaultKdf.opsLimit,
          kdfMemLimit: input.vaultKdf.memLimit,
          kdfVersion: input.vaultKdf.version,
          keyMaterialVersion: sql`${schema.userKeyMaterial.keyMaterialVersion} + 1`,
          updatedAt: sql`CURRENT_TIMESTAMP`
        })
        .where(
          and(
            eq(schema.userKeyMaterial.userId, input.userId),
            eq(
              schema.userKeyMaterial.keyMaterialVersion,
              input.expectedKeyMaterialVersion
            )
          )
        )
        .run();
      if (keyMaterialUpdate.changes !== 1) {
        return { kind: "conflict" as const };
      }

      transaction
        .update(schema.users)
        .set({
          authVerifierHash: input.newAuthVerifierHash,
          authKdfSalt: input.authKdf.salt,
          authKdfOpsLimit: input.authKdf.opsLimit,
          authKdfMemLimit: input.authKdf.memLimit,
          authKdfVersion: input.authKdf.version,
          updatedAt: sql`CURRENT_TIMESTAMP`
        })
        .where(eq(schema.users.id, input.userId))
        .run();
      const revokedSessionIds = transaction
        .delete(schema.sessions)
        .where(eq(schema.sessions.userId, input.userId))
        .returning({ id: schema.sessions.id })
        .all()
        .map(({ id }) => id);
      const token = randomBytes(32).toString("base64url");
      const now = Date.now();
      transaction
        .insert(schema.sessions)
        .values({
          id: crypto.randomUUID(),
          userId: input.userId,
          sessionHash: hashToken(token),
          idleExpiresAt: new Date(now + this.sessionIdleTimeoutMs).toISOString(),
          absoluteExpiresAt: new Date(
            now + this.sessionAbsoluteTimeoutMs
          ).toISOString()
        })
        .run();
      return { kind: "recovered" as const, token, revokedSessionIds };
    });
    return Promise.resolve(outcome);
  }

  keyMaterial(userId: string): Promise<KeyMaterialRecord | null> {
    const row = this.orm
      .select({
        encryptedRootKey: schema.userKeyMaterial.encryptedRootKey,
        rootKeyNonce: schema.userKeyMaterial.rootKeyNonce,
        rootKeyFormatVersion: schema.userKeyMaterial.rootKeyFormatVersion,
        rootKeyContextVersion: schema.userKeyMaterial.rootKeyContextVersion,
        kdfSalt: schema.userKeyMaterial.kdfSalt,
        kdfOpsLimit: schema.userKeyMaterial.kdfOpsLimit,
        kdfMemLimit: schema.userKeyMaterial.kdfMemLimit,
        kdfVersion: schema.userKeyMaterial.kdfVersion,
        recoveryEncryptedRootKey: schema.userKeyMaterial.recoveryEncryptedRootKey,
        recoveryRootKeyNonce: schema.userKeyMaterial.recoveryRootKeyNonce,
        recoveryRootKeyFormatVersion: schema.userKeyMaterial.recoveryRootKeyFormatVersion,
        recoveryRootKeyContextVersion: schema.userKeyMaterial.recoveryRootKeyContextVersion,
        recoveryKdfSalt: schema.userKeyMaterial.recoveryKdfSalt,
        recoveryKdfOpsLimit: schema.userKeyMaterial.recoveryKdfOpsLimit,
        recoveryKdfMemLimit: schema.userKeyMaterial.recoveryKdfMemLimit,
        recoveryKdfVersion: schema.userKeyMaterial.recoveryKdfVersion,
        keyMaterialVersion: schema.userKeyMaterial.keyMaterialVersion
      })
      .from(schema.userKeyMaterial)
      .where(eq(schema.userKeyMaterial.userId, userId))
      .get();
    return Promise.resolve(row ?? null);
  }

  rotateKeyMaterial(
    input: RotateKeyMaterialInput
  ): Promise<RotateKeyMaterialOutcome> {
    const outcome = this.orm.transaction((transaction) => {
      const current = transaction
        .select({ keyMaterialVersion: schema.userKeyMaterial.keyMaterialVersion })
        .from(schema.userKeyMaterial)
        .where(eq(schema.userKeyMaterial.userId, input.userId))
        .get();
      if (!current) {
        return { kind: "not-found" as const };
      }
      if (current.keyMaterialVersion !== input.expectedKeyMaterialVersion) {
        return { kind: "conflict" as const };
      }

      const updated = transaction
        .update(schema.userKeyMaterial)
        .set({
          encryptedRootKey: input.encryptedRootKey,
          rootKeyNonce: input.rootKeyNonce,
          rootKeyFormatVersion: input.rootKeyFormatVersion,
          rootKeyContextVersion: input.rootKeyContextVersion,
          kdfSalt: input.vaultKdf.salt,
          kdfOpsLimit: input.vaultKdf.opsLimit,
          kdfMemLimit: input.vaultKdf.memLimit,
          kdfVersion: input.vaultKdf.version,
          ...(input.recovery
            ? {
                recoveryEncryptedRootKey: input.recovery.encryptedRootKey,
                recoveryRootKeyNonce: input.recovery.rootKeyNonce,
                recoveryRootKeyFormatVersion: input.recovery.rootKeyFormatVersion,
                recoveryRootKeyContextVersion: input.recovery.rootKeyContextVersion,
                recoveryAuthVerifierHash: input.recovery.verifierHash,
                recoveryKdfSalt: input.recovery.kdf.salt,
                recoveryKdfOpsLimit: input.recovery.kdf.opsLimit,
                recoveryKdfMemLimit: input.recovery.kdf.memLimit,
                recoveryKdfVersion: input.recovery.kdf.version
              }
            : {}),
          keyMaterialVersion: sql`${schema.userKeyMaterial.keyMaterialVersion} + 1`,
          updatedAt: sql`CURRENT_TIMESTAMP`
        })
        .where(
          and(
            eq(schema.userKeyMaterial.userId, input.userId),
            eq(
              schema.userKeyMaterial.keyMaterialVersion,
              input.expectedKeyMaterialVersion
            )
          )
        )
        .run();
      if (updated.changes !== 1) {
        return { kind: "conflict" as const };
      }
      if (!input.auth) {
        return {
          kind: "rotated" as const,
          keyMaterialVersion: input.expectedKeyMaterialVersion + 1,
          replacementToken: null,
          revokedSessionIds: []
        };
      }

      transaction
        .update(schema.users)
        .set({
          authVerifierHash: input.auth.verifierHash,
          authKdfSalt: input.auth.kdf.salt,
          authKdfOpsLimit: input.auth.kdf.opsLimit,
          authKdfMemLimit: input.auth.kdf.memLimit,
          authKdfVersion: input.auth.kdf.version,
          updatedAt: sql`CURRENT_TIMESTAMP`
        })
        .where(eq(schema.users.id, input.userId))
        .run();
      const revokedSessionIds = transaction
        .delete(schema.sessions)
        .where(eq(schema.sessions.userId, input.userId))
        .returning({ id: schema.sessions.id })
        .all()
        .map(({ id }) => id);
      const replacementToken = randomBytes(32).toString("base64url");
      const now = Date.now();
      transaction
        .insert(schema.sessions)
        .values({
          id: crypto.randomUUID(),
          userId: input.userId,
          sessionHash: hashToken(replacementToken),
          idleExpiresAt: new Date(now + this.sessionIdleTimeoutMs).toISOString(),
          absoluteExpiresAt: new Date(
            now + this.sessionAbsoluteTimeoutMs
          ).toISOString()
        })
        .run();
      return {
        kind: "rotated" as const,
        keyMaterialVersion: input.expectedKeyMaterialVersion + 1,
        replacementToken,
        revokedSessionIds
      };
    });
    return Promise.resolve(outcome);
  }
}
