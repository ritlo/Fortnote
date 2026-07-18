import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, lte, or, sql } from "drizzle-orm";
import type { Request, Response } from "express";
import type { AppDb } from "../db/client.js";
import * as schema from "../db/schema.js";
import { sendApiError } from "../http/errors.js";

const SESSION_COOKIE = "fortnote_session";
export interface SessionRecord {
  id: string;
  userId: string;
  username: string;
  displayName: string;
  canonicalHandle: string | null;
  handleState: string;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export function createSession(
  db: AppDb,
  userId: string,
  orm: Pick<AppDb["orm"], "insert"> = db.orm
): string {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  orm.insert(schema.sessions).values({
    id: crypto.randomUUID(),
    userId,
    sessionHash: hashToken(token),
    idleExpiresAt: new Date(now + db.sessionIdleTimeoutMs).toISOString(),
    absoluteExpiresAt: new Date(now + db.sessionAbsoluteTimeoutMs).toISOString()
  }).run();
  return token;
}

export function setSessionCookie(
  response: Response,
  token: string,
  secure: boolean
): void {
  response.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/"
  });
}

export function clearSessionCookie(response: Response, secure: boolean): void {
  response.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/"
  });
}

export function readSessionToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) {
    return null;
  }

  const cookies = cookieHeader.split(";").map((part) => part.trim());
  const match = cookies.find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  return match ? decodeURIComponent(match.slice(SESSION_COOKIE.length + 1)) : null;
}

export function findSession(db: AppDb, token: string | null): SessionRecord | null {
  if (!token) {
    return null;
  }

  const now = new Date().toISOString();
  const row = db.orm
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
    return null;
  }

  db.orm
    .update(schema.sessions)
    .set({
      lastSeenAt: sql`CURRENT_TIMESTAMP`,
      idleExpiresAt: new Date(Date.now() + db.sessionIdleTimeoutMs).toISOString()
    })
    .where(eq(schema.sessions.id, row.id))
    .run();

  return {
    ...row,
    displayName: row.displayName ?? row.username
  };
}

export function deleteSession(db: AppDb, token: string | null): string | null {
  if (!token) {
    return null;
  }

  const row = db.orm
    .delete(schema.sessions)
    .where(eq(schema.sessions.sessionHash, hashToken(token)))
    .returning({ id: schema.sessions.id })
    .get();
  return row?.id ?? null;
}

export function deleteUserSessions(
  db: AppDb,
  userId: string,
  orm: Pick<AppDb["orm"], "delete"> = db.orm
): string[] {
  const rows = orm
    .delete(schema.sessions)
    .where(eq(schema.sessions.userId, userId))
    .returning({ id: schema.sessions.id })
    .all();
  return rows.map((row) => row.id);
}

export function deleteExpiredSessions(db: AppDb): number {
  const now = new Date().toISOString();
  return db.orm
    .delete(schema.sessions)
    .where(or(
      lte(schema.sessions.idleExpiresAt, now),
      lte(schema.sessions.absoluteExpiresAt, now)
    ))
    .run().changes;
}

export function isSessionActive(db: AppDb, sessionId: string): boolean {
  const now = new Date().toISOString();
  const row = db.orm
    .select({ id: schema.sessions.id })
    .from(schema.sessions)
    .where(and(
      eq(schema.sessions.id, sessionId),
      gt(schema.sessions.idleExpiresAt, now),
      gt(schema.sessions.absoluteExpiresAt, now)
    ))
    .get();
  return Boolean(row);
}

export function requireSession(
  db: AppDb,
  request: Request,
  response: Response
): SessionRecord | null {
  const session = findSession(db, readSessionToken(request.get("cookie")));
  if (!session) {
    sendApiError(response, "unauthorized", "Not signed in");
    return null;
  }

  return session;
}
