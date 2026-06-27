import { createHash, randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import type { AppDb } from "../db/client.js";
import { sendApiError } from "../http/errors.js";

const SESSION_COOKIE = "fortnote_session";
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const ABSOLUTE_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000;

export interface SessionRecord {
  id: string;
  userId: string;
  username: string;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export function createSession(db: AppDb, userId: string): string {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  db.sqlite
    .prepare(
      `INSERT INTO sessions (
        id,
        user_id,
        session_hash,
        idle_expires_at,
        absolute_expires_at
      ) VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      crypto.randomUUID(),
      userId,
      hashToken(token),
      new Date(now + IDLE_TIMEOUT_MS).toISOString(),
      new Date(now + ABSOLUTE_TIMEOUT_MS).toISOString()
    );
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
  const row = db.sqlite
    .prepare(
      `SELECT sessions.id, sessions.user_id AS userId, users.username
       FROM sessions
       JOIN users ON users.id = sessions.user_id
       WHERE sessions.session_hash = ?
         AND sessions.idle_expires_at > ?
         AND sessions.absolute_expires_at > ?`
    )
    .get(hashToken(token), now, now) as SessionRecord | undefined;

  if (!row) {
    return null;
  }

  db.sqlite
    .prepare(
      `UPDATE sessions
       SET last_seen_at = CURRENT_TIMESTAMP,
           idle_expires_at = ?
       WHERE id = ?`
    )
    .run(new Date(Date.now() + IDLE_TIMEOUT_MS).toISOString(), row.id);

  return row;
}

export function deleteSession(db: AppDb, token: string | null): void {
  if (!token) {
    return;
  }

  db.sqlite.prepare("DELETE FROM sessions WHERE session_hash = ?").run(hashToken(token));
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
