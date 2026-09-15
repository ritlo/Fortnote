import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import type { ApplicationDatabase } from "../db/types.js";
import { sendApiError } from "../http/errors.js";

const SESSION_COOKIE = "fortnote_session";
export interface SessionRecord {
  id: string;
  userId: string;
  username: string;
  displayName: string;
  canonicalHandle: string | null;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export function createSession(db: ApplicationDatabase, userId: string): Promise<string> {
  return db.sessions.create(userId);
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

export function deleteSession(
  db: ApplicationDatabase,
  token: string | null
): Promise<string | null> {
  return db.sessions.delete(token);
}

export async function requireSessionAsync(
  db: ApplicationDatabase,
  request: Request,
  response: Response
): Promise<SessionRecord | null> {
  const session = await db.sessions.find(readSessionToken(request.get("cookie")));
  if (!session) {
    sendApiError(response, "unauthorized", "Not signed in");
    return null;
  }
  return session;
}
