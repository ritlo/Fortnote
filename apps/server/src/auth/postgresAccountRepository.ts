import { randomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/postgres/schema.js";
import type {
  AccountIdentity,
  AccountRepository,
  KeyMaterialRecord,
  KdfParametersRecord,
  RecoveryParametersRecord,
  RecoverAccountInput,
  RecoverAccountOutcome,
  RecoveryVerifierRecord,
  RegisterAccountInput,
  RotateKeyMaterialInput,
  RotateKeyMaterialOutcome
} from "./accountRepository.js";
import { hashToken } from "./session.js";

type PostgresDatabase = NodePgDatabase<typeof schema>;

const identitySelection = {
  id: schema.users.id,
  username: schema.users.username,
  displayName: schema.users.displayName,
  canonicalHandle: schema.users.canonicalHandle,
  handleState: schema.users.handleState
};

export class PostgresAccountRepository implements AccountRepository {
  constructor(
    private readonly orm: PostgresDatabase,
    private readonly sessionIdleTimeoutMs: number,
    private readonly sessionAbsoluteTimeoutMs: number
  ) {}

  async findIdentity(
    suppliedHandle: string,
    canonicalHandle: string | null
  ): Promise<AccountIdentity | null> {
    if (canonicalHandle) {
      const rows = await this.orm
        .select(identitySelection)
        .from(schema.users)
        .where(eq(schema.users.canonicalHandle, canonicalHandle))
        .limit(1);
      if (rows[0]) {
        return rows[0];
      }
    }
    const rows = await this.orm
      .select(identitySelection)
      .from(schema.users)
      .where(
        and(
          isNull(schema.users.canonicalHandle),
          eq(schema.users.username, suppliedHandle)
        )
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async kdfParameters(userId: string): Promise<KdfParametersRecord | null> {
    const rows = await this.orm
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
      .limit(1);
    return rows[0] ?? null;
  }

  async recoveryParameters(
    userId: string
  ): Promise<RecoveryParametersRecord | null> {
    const rows = await this.orm
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
      .limit(1);
    return rows[0] ?? null;
  }

  async authVerifierHash(userId: string): Promise<string | null> {
    const rows = await this.orm
      .select({ authVerifierHash: schema.users.authVerifierHash })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    return rows[0]?.authVerifierHash ?? null;
  }

  async recoveryVerifier(userId: string): Promise<RecoveryVerifierRecord | null> {
    const rows = await this.orm
      .select({
        id: schema.users.id,
        recoveryAuthVerifierHash: schema.userKeyMaterial.recoveryAuthVerifierHash,
        keyMaterialVersion: schema.userKeyMaterial.keyMaterialVersion
      })
      .from(schema.users)
      .innerJoin(schema.userKeyMaterial, eq(schema.userKeyMaterial.userId, schema.users.id))
      .where(eq(schema.users.id, userId))
      .limit(1);
    return rows[0] ?? null;
  }

  register(input: RegisterAccountInput): Promise<void> {
    return this.orm.transaction(async (transaction) => {
      await transaction.insert(schema.users).values({
        ...input.user,
        handleState: "active"
      });
      await transaction.insert(schema.userKeyMaterial).values({
        userId: input.user.id,
        ...input.keyMaterial
      });
    });
  }

  async activateHandle(userId: string, canonicalHandle: string): Promise<boolean> {
    const rows = await this.orm
      .update(schema.users)
      .set({
        username: canonicalHandle,
        canonicalHandle,
        handleState: "active",
        updatedAt: sql`CURRENT_TIMESTAMP`
      })
      .where(and(eq(schema.users.id, userId), isNull(schema.users.canonicalHandle)))
      .returning({ id: schema.users.id });
    return rows.length === 1;
  }

  recover(input: RecoverAccountInput): Promise<RecoverAccountOutcome> {
    return this.orm.transaction(async (transaction) => {
      const keyMaterialUpdate = await transaction
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
        .returning({ userId: schema.userKeyMaterial.userId });
      if (keyMaterialUpdate.length !== 1) {
        return { kind: "conflict" as const };
      }

      await transaction
        .update(schema.users)
        .set({
          authVerifierHash: input.newAuthVerifierHash,
          authKdfSalt: input.authKdf.salt,
          authKdfOpsLimit: input.authKdf.opsLimit,
          authKdfMemLimit: input.authKdf.memLimit,
          authKdfVersion: input.authKdf.version,
          updatedAt: sql`CURRENT_TIMESTAMP`
        })
        .where(eq(schema.users.id, input.userId));
      const revokedSessions = await transaction
        .delete(schema.sessions)
        .where(eq(schema.sessions.userId, input.userId))
        .returning({ id: schema.sessions.id });
      const token = randomBytes(32).toString("base64url");
      const now = Date.now();
      await transaction.insert(schema.sessions).values({
        id: crypto.randomUUID(),
        userId: input.userId,
        sessionHash: hashToken(token),
        idleExpiresAt: new Date(now + this.sessionIdleTimeoutMs).toISOString(),
        absoluteExpiresAt: new Date(
          now + this.sessionAbsoluteTimeoutMs
        ).toISOString()
      });
      return {
        kind: "recovered" as const,
        token,
        revokedSessionIds: revokedSessions.map(({ id }) => id)
      };
    });
  }

  async keyMaterial(userId: string): Promise<KeyMaterialRecord | null> {
    const rows = await this.orm
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
      .limit(1);
    return rows[0] ?? null;
  }

  rotateKeyMaterial(
    input: RotateKeyMaterialInput
  ): Promise<RotateKeyMaterialOutcome> {
    return this.orm.transaction(async (transaction) => {
      const currentRows = await transaction
        .select({ keyMaterialVersion: schema.userKeyMaterial.keyMaterialVersion })
        .from(schema.userKeyMaterial)
        .where(eq(schema.userKeyMaterial.userId, input.userId))
        .limit(1)
        .for("update");
      const current = currentRows[0];
      if (!current) {
        return { kind: "not-found" as const };
      }
      if (current.keyMaterialVersion !== input.expectedKeyMaterialVersion) {
        return { kind: "conflict" as const };
      }

      const updated = await transaction
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
        .returning({ userId: schema.userKeyMaterial.userId });
      if (updated.length !== 1) {
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

      await transaction
        .update(schema.users)
        .set({
          authVerifierHash: input.auth.verifierHash,
          authKdfSalt: input.auth.kdf.salt,
          authKdfOpsLimit: input.auth.kdf.opsLimit,
          authKdfMemLimit: input.auth.kdf.memLimit,
          authKdfVersion: input.auth.kdf.version,
          updatedAt: sql`CURRENT_TIMESTAMP`
        })
        .where(eq(schema.users.id, input.userId));
      const revokedSessions = await transaction
        .delete(schema.sessions)
        .where(eq(schema.sessions.userId, input.userId))
        .returning({ id: schema.sessions.id });
      const replacementToken = randomBytes(32).toString("base64url");
      const now = Date.now();
      await transaction.insert(schema.sessions).values({
        id: crypto.randomUUID(),
        userId: input.userId,
        sessionHash: hashToken(replacementToken),
        idleExpiresAt: new Date(now + this.sessionIdleTimeoutMs).toISOString(),
        absoluteExpiresAt: new Date(
          now + this.sessionAbsoluteTimeoutMs
        ).toISOString()
      });
      return {
        kind: "rotated" as const,
        keyMaterialVersion: input.expectedKeyMaterialVersion + 1,
        replacementToken,
        revokedSessionIds: revokedSessions.map(({ id }) => id)
      };
    });
  }
}
