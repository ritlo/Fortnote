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
  keyEpoch: number;
  isDeleted: boolean;
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
