import { and, desc, eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";

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

export type PutSharingKeyOutcome = "conflict" | "created" | "upgraded";

export interface SharingKeyRepository {
  current(userId: string): Promise<SharingKeyRecord | null>;
  version(userId: string, sharingKeyVersion: number): Promise<SharingKeyRecord | null>;
  put(userId: string, input: SharingKeyInput): Promise<PutSharingKeyOutcome>;
  cleanup(userId: string): Promise<number>;
  lookup(canonicalHandle: string): Promise<PublicSharingKeyRecord | null>;
}

type SqliteDatabase = BetterSQLite3Database<typeof schema>;

const sharingKeySelection = {
  sharingKeyVersion: schema.userSharingKeys.sharingKeyVersion,
  publicKey: schema.userSharingKeys.publicKey,
  encryptedPrivateKey: schema.userSharingKeys.encryptedPrivateKey,
  privateKeyNonce: schema.userSharingKeys.privateKeyNonce,
  formatVersion: schema.userSharingKeys.formatVersion,
  createdAt: schema.userSharingKeys.createdAt,
  updatedAt: schema.userSharingKeys.updatedAt
};

export class SqliteSharingKeyRepository implements SharingKeyRepository {
  constructor(private readonly orm: SqliteDatabase) {}

  current(userId: string): Promise<SharingKeyRecord | null> {
    const row = this.orm
      .select(sharingKeySelection)
      .from(schema.userSharingKeys)
      .where(eq(schema.userSharingKeys.userId, userId))
      .orderBy(desc(schema.userSharingKeys.sharingKeyVersion))
      .limit(1)
      .get();
    return Promise.resolve(row ?? null);
  }

  version(userId: string, sharingKeyVersion: number): Promise<SharingKeyRecord | null> {
    const row = this.orm
      .select(sharingKeySelection)
      .from(schema.userSharingKeys)
      .where(
        and(
          eq(schema.userSharingKeys.userId, userId),
          eq(schema.userSharingKeys.sharingKeyVersion, sharingKeyVersion)
        )
      )
      .get();
    return Promise.resolve(row ?? null);
  }

  put(userId: string, input: SharingKeyInput): Promise<PutSharingKeyOutcome> {
    const outcome = this.orm.transaction((transaction) => {
      const existing = transaction
        .select({
          publicKey: schema.userSharingKeys.publicKey,
          formatVersion: schema.userSharingKeys.formatVersion
        })
        .from(schema.userSharingKeys)
        .where(
          and(
            eq(schema.userSharingKeys.userId, userId),
            eq(schema.userSharingKeys.sharingKeyVersion, input.sharingKeyVersion)
          )
        )
        .get();
      if (existing) {
        if (
          existing.publicKey !== input.publicKey ||
          existing.formatVersion !== 1 ||
          input.formatVersion !== 2
        ) {
          return "conflict" as const;
        }
        const migrated = transaction
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
              eq(schema.userSharingKeys.sharingKeyVersion, input.sharingKeyVersion),
              eq(schema.userSharingKeys.publicKey, input.publicKey),
              eq(schema.userSharingKeys.formatVersion, 1)
            )
          )
          .run();
        return migrated.changes === 1 ? ("upgraded" as const) : ("conflict" as const);
      }

      const inserted = transaction
        .insert(schema.userSharingKeys)
        .values({ userId, ...input })
        .onConflictDoNothing()
        .returning({ userId: schema.userSharingKeys.userId })
        .all();
      return inserted.length === 1 ? ("created" as const) : ("conflict" as const);
    });
    return Promise.resolve(outcome);
  }

  cleanup(userId: string): Promise<number> {
    const result = this.orm.run(sql`
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
    return Promise.resolve(result.changes);
  }

  lookup(canonicalHandle: string): Promise<PublicSharingKeyRecord | null> {
    const row = this.orm
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
      .innerJoin(
        schema.userSharingKeys,
        eq(schema.userSharingKeys.userId, schema.users.id)
      )
      .where(
        and(
          eq(schema.users.canonicalHandle, canonicalHandle),
          eq(schema.users.handleState, "active")
        )
      )
      .orderBy(desc(schema.userSharingKeys.sharingKeyVersion))
      .limit(1)
      .get();
    return Promise.resolve(row ?? null);
  }
}
