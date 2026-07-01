import type { AppContext } from "../http/app.js";

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
  isDeleted: 0 | 1;
}

export function getNoteAccess(
  context: AppContext,
  noteId: string,
  userId: string
): NoteAccess | undefined {
  return context.db.sqlite
    .prepare(
      `SELECT notes.id AS noteId,
              notes.user_id AS ownerUserId,
              notes.crypto_owner_id AS cryptoOwnerId,
              note_memberships.role,
              note_memberships.status,
              notes.folder_id AS folderId,
              notes.version,
              notes.is_deleted AS isDeleted
       FROM notes
       JOIN note_memberships ON note_memberships.note_id = notes.id
       WHERE notes.id = ?
         AND note_memberships.user_id = ?`
    )
    .get(noteId, userId) as NoteAccess | undefined;
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
