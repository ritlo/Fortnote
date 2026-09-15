import { type SessionRecord } from "./session.js";

export interface SessionRepository {
  create(userId: string): Promise<string>;
  find(token: string | null): Promise<SessionRecord | null>;
  isActive(sessionId: string): Promise<boolean>;
  delete(token: string | null): Promise<string | null>;
  deleteExpired(now: string): Promise<number>;
}
