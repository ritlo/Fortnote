import { randomBytes } from "node:crypto";
import { and, eq, gt, lte, or } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import { hashToken, type SessionRecord } from "./session.js";

export interface SessionRepository {
  create(userId: string): Promise<string>;
  find(token: string | null): Promise<SessionRecord | null>;
  isActive(sessionId: string): Promise<boolean>;
  delete(token: string | null): Promise<string | null>;
  deleteExpired(now: string): Promise<number>;
}

export class SqliteSessionRepository implements SessionRepository {
  constructor(
    private readonly orm: BetterSQLite3Database<typeof schema>,
    private readonly idleTimeoutMs: number,
    private readonly absoluteTimeoutMs: number
  ) {}

  create(userId: string): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    this.orm.insert(schema.sessions).values({
      id: crypto.randomUUID(),
      userId,
      sessionHash: hashToken(token),
      idleExpiresAt: new Date(now + this.idleTimeoutMs).toISOString(),
      absoluteExpiresAt: new Date(now + this.absoluteTimeoutMs).toISOString()
    }).run();
    return Promise.resolve(token);
  }

  find(token: string | null): Promise<SessionRecord | null> {
    if (!token) {
      return Promise.resolve(null);
    }

    const now = new Date().toISOString();
    const row = this.orm
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
      .get();

    if (!row) {
      return Promise.resolve(null);
    }

    this.orm
      .update(schema.sessions)
      .set({
        lastSeenAt: new Date().toISOString(),
        idleExpiresAt: new Date(Date.now() + this.idleTimeoutMs).toISOString()
      })
      .where(eq(schema.sessions.id, row.id))
      .run();

    return Promise.resolve({
      ...row,
      displayName: row.displayName ?? row.username
    });
  }

  isActive(sessionId: string): Promise<boolean> {
    const now = new Date().toISOString();
    const row = this.orm
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(and(
        eq(schema.sessions.id, sessionId),
        gt(schema.sessions.idleExpiresAt, now),
        gt(schema.sessions.absoluteExpiresAt, now)
      ))
      .get();
    return Promise.resolve(Boolean(row));
  }

  delete(token: string | null): Promise<string | null> {
    if (!token) {
      return Promise.resolve(null);
    }

    const row = this.orm
      .delete(schema.sessions)
      .where(eq(schema.sessions.sessionHash, hashToken(token)))
      .returning({ id: schema.sessions.id })
      .get();
    return Promise.resolve(row?.id ?? null);
  }

  deleteExpired(now: string): Promise<number> {
    const result = this.orm
      .delete(schema.sessions)
      .where(or(
        lte(schema.sessions.idleExpiresAt, now),
        lte(schema.sessions.absoluteExpiresAt, now)
      ))
      .run();
    return Promise.resolve(result.changes);
  }
}
