import { and, eq, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/postgres/schema.js";
import type {
  AccountIdentity,
  AccountRepository,
  KdfParametersRecord,
  RecoveryParametersRecord,
  RecoveryVerifierRecord,
  RegisterAccountInput
} from "./accountRepository.js";

type PostgresDatabase = NodePgDatabase<typeof schema>;

const identitySelection = {
  id: schema.users.id,
  username: schema.users.username,
  displayName: schema.users.displayName,
  canonicalHandle: schema.users.canonicalHandle,
  handleState: schema.users.handleState
};

export class PostgresAccountRepository implements AccountRepository {
  constructor(private readonly orm: PostgresDatabase) {}

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
}
