import { randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/postgres/schema.js";
import { hashToken, type SessionRecord } from "./session.js";
import type { SessionRepository } from "./sessionRepository.js";

type PostgresDatabase = NodePgDatabase<typeof schema>;

export class PostgresSessionRepository implements SessionRepository {
  constructor(
    private readonly orm: PostgresDatabase,
    private readonly idleTimeoutMs: number,
    private readonly absoluteTimeoutMs: number
  ) {}

  async create(userId: string): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    await this.orm.insert(schema.sessions).values({
      id: crypto.randomUUID(),
      userId,
      sessionHash: hashToken(token),
      idleExpiresAt: new Date(now + this.idleTimeoutMs).toISOString(),
      absoluteExpiresAt: new Date(now + this.absoluteTimeoutMs).toISOString()
    });
    return token;
  }

  async find(token: string | null): Promise<SessionRecord | null> {
    if (!token) {
      return null;
    }

    const now = new Date().toISOString();
    const rows = await this.orm
      .select({
        id: schema.sessions.id,
        userId: schema.sessions.userId,
        username: schema.users.username,
        displayName: schema.users.displayName,
        canonicalHandle: schema.users.canonicalHandle,
        handleState: schema.users.handleState
      })
      .from(schema.sessions)
      .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
      .where(and(
        eq(schema.sessions.sessionHash, hashToken(token)),
        gt(schema.sessions.idleExpiresAt, now),
        gt(schema.sessions.absoluteExpiresAt, now)
      ))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return null;
    }

    await this.orm
      .update(schema.sessions)
      .set({
        lastSeenAt: new Date().toISOString(),
        idleExpiresAt: new Date(Date.now() + this.idleTimeoutMs).toISOString()
      })
      .where(eq(schema.sessions.id, row.id));

    return {
      ...row,
      displayName: row.displayName ?? row.username
    };
  }

  async delete(token: string | null): Promise<string | null> {
    if (!token) {
      return null;
    }

    const rows = await this.orm
      .delete(schema.sessions)
      .where(eq(schema.sessions.sessionHash, hashToken(token)))
      .returning({ id: schema.sessions.id });
    return rows[0]?.id ?? null;
  }
}
