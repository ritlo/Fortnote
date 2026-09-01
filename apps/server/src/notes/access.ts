import { and, eq } from "drizzle-orm";
import type { AppContext } from "../http/app.js";
import * as schema from "../db/schema.js";

export type NoteRole = "owner" | "editor" | "viewer";
export type NoteMembershipStatus = "active" | "invited" | "revoked";

export interface NoteAccess {
  noteId: string;
  ownerUserId: string;
  cryptoOwnerId: string;
  role: NoteRole;
  status: NoteMembershipStatus;
  folderId: string | null;
  version: number;
  keyEpoch: number;
  isDeleted: boolean;
}

export function getNoteAccess(
  context: AppContext,
  noteId: string,
  userId: string
): NoteAccess | undefined {
  return context.db.orm
    .select({
      noteId: schema.notes.id,
      ownerUserId: schema.notes.userId,
      cryptoOwnerId: schema.notes.cryptoOwnerId,
      role: schema.noteMemberships.role,
      status: schema.noteMemberships.status,
      folderId: schema.notes.folderId,
      version: schema.notes.version,
      keyEpoch: schema.notes.keyEpoch,
      isDeleted: schema.notes.isDeleted
    })
    .from(schema.notes)
    .innerJoin(
      schema.noteMemberships,
      eq(schema.noteMemberships.noteId, schema.notes.id)
    )
    .where(and(
      eq(schema.notes.id, noteId),
      eq(schema.noteMemberships.userId, userId)
    ))
    .get() as NoteAccess | undefined;
}

export function getNoteAccessAsync(
  context: AppContext,
  noteId: string,
  userId: string
): Promise<NoteAccess | undefined> {
  return context.db.noteAccess.find(noteId, userId);
}

export function canReadNote(access: NoteAccess | undefined): access is NoteAccess {
  return access?.status === "active";
}

export function canEditNote(access: NoteAccess | undefined): access is NoteAccess {
  return (
    access?.status === "active" &&
    (access.role === "owner" || access.role === "editor")
  );
}

export function canOwnNote(access: NoteAccess | undefined): access is NoteAccess {
  return access?.status === "active" && access.role === "owner";
}
