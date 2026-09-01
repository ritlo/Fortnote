import { and, desc, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/postgres/schema.js";
import type {
  PublicSharingKeyRecord,
  PutSharingKeyOutcome,
  SharingKeyInput,
  SharingKeyRecord,
  SharingKeyRepository
} from "./repository.js";

type PostgresDatabase = NodePgDatabase<typeof schema>;

const sharingKeySelection = {
  sharingKeyVersion: schema.userSharingKeys.sharingKeyVersion,
  publicKey: schema.userSharingKeys.publicKey,
  encryptedPrivateKey: schema.userSharingKeys.encryptedPrivateKey,
  privateKeyNonce: schema.userSharingKeys.privateKeyNonce,
  formatVersion: schema.userSharingKeys.formatVersion,
  createdAt: schema.userSharingKeys.createdAt,
  updatedAt: schema.userSharingKeys.updatedAt
};

export class PostgresSharingKeyRepository implements SharingKeyRepository {
  constructor(private readonly orm: PostgresDatabase) {}

  async current(userId: string): Promise<SharingKeyRecord | null> {
    const rows = await this.orm
      .select(sharingKeySelection)
      .from(schema.userSharingKeys)
      .where(eq(schema.userSharingKeys.userId, userId))
      .orderBy(desc(schema.userSharingKeys.sharingKeyVersion))
      .limit(1);
    return rows[0] ?? null;
  }

  async version(
    userId: string,
    sharingKeyVersion: number
  ): Promise<SharingKeyRecord | null> {
    const rows = await this.orm
      .select(sharingKeySelection)
      .from(schema.userSharingKeys)
      .where(
        and(
          eq(schema.userSharingKeys.userId, userId),
          eq(schema.userSharingKeys.sharingKeyVersion, sharingKeyVersion)
        )
      )
      .limit(1);
    return rows[0] ?? null;
  }

  put(userId: string, input: SharingKeyInput): Promise<PutSharingKeyOutcome> {
    return this.orm.transaction(async (transaction) => {
      const existingRows = await transaction
        .select({
          publicKey: schema.userSharingKeys.publicKey,
          formatVersion: schema.userSharingKeys.formatVersion
        })
        .from(schema.userSharingKeys)
        .where(
          and(
            eq(schema.userSharingKeys.userId, userId),
            eq(
              schema.userSharingKeys.sharingKeyVersion,
              input.sharingKeyVersion
            )
          )
        )
        .limit(1)
        .for("update");
      const existing = existingRows[0];
      if (existing) {
        if (
          existing.publicKey !== input.publicKey ||
          existing.formatVersion !== 1 ||
          input.formatVersion !== 2
        ) {
          return "conflict" as const;
        }
        const migrated = await transaction
          .update(schema.userSharingKeys)
          .set({
            encryptedPrivateKey: input.encryptedPrivateKey,
            privateKeyNonce: input.privateKeyNonce,
            formatVersion: 2,
            updatedAt: sql`CURRENT_TIMESTAMP`
          })
          .where(
            and(
              eq(schema.userSharingKeys.userId, userId),
              eq(
                schema.userSharingKeys.sharingKeyVersion,
                input.sharingKeyVersion
              ),
              eq(schema.userSharingKeys.publicKey, input.publicKey),
              eq(schema.userSharingKeys.formatVersion, 1)
            )
          )
          .returning({ userId: schema.userSharingKeys.userId });
        return migrated.length === 1 ? "upgraded" as const : "conflict" as const;
      }

      const inserted = await transaction
        .insert(schema.userSharingKeys)
        .values({ userId, ...input })
        .onConflictDoNothing()
        .returning({ userId: schema.userSharingKeys.userId });
      return inserted.length === 1 ? "created" as const : "conflict" as const;
    });
  }

  async cleanup(userId: string): Promise<number> {
    const result = await this.orm.execute(sql`
      DELETE FROM ${schema.userSharingKeys}
      WHERE ${schema.userSharingKeys.userId} = ${userId}
        AND ${schema.userSharingKeys.sharingKeyVersion} < (
          SELECT MAX(current_keys.sharing_key_version)
          FROM ${schema.userSharingKeys} AS current_keys
          WHERE current_keys.user_id = ${schema.userSharingKeys.userId}
        )
        AND NOT EXISTS (
          SELECT 1
          FROM ${schema.noteKeyShares}
          WHERE ${schema.noteKeyShares.recipientUserId} = ${schema.userSharingKeys.userId}
            AND ${schema.noteKeyShares.sharingKeyVersion} =
              ${schema.userSharingKeys.sharingKeyVersion}
        )
    `);
    return result.rowCount ?? 0;
  }

  async lookup(canonicalHandle: string): Promise<PublicSharingKeyRecord | null> {
    const rows = await this.orm
      .select({
        userId: schema.users.id,
        canonicalHandle: schema.users.canonicalHandle,
        displayName: schema.users.displayName,
        sharingKeyVersion: schema.userSharingKeys.sharingKeyVersion,
        publicKey: schema.userSharingKeys.publicKey,
        formatVersion: schema.userSharingKeys.formatVersion,
        createdAt: schema.userSharingKeys.createdAt
      })
      .from(schema.users)
      .innerJoin(schema.userSharingKeys, eq(schema.userSharingKeys.userId, schema.users.id))
      .where(
        and(
          eq(schema.users.canonicalHandle, canonicalHandle),
          eq(schema.users.handleState, "active")
        )
      )
      .orderBy(desc(schema.userSharingKeys.sharingKeyVersion))
      .limit(1);
    return rows[0] ?? null;
  }
}
