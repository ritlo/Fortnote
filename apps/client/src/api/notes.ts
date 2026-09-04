import type {
  CreateNotePayload,
  InviteNoteMemberPayload,
  NoteEpochLink,
  NoteKeyShare,
  NoteMembership,
  NoteSummary,
  RotateNoteKeyPayload,
  UpdateNotePayload
} from "./contracts";
import { apiRequest } from "./http";

export function listNotes(deleted = false): Promise<{ notes: NoteSummary[] }> {
  return apiRequest<{ notes: NoteSummary[] }>(`/notes?deleted=${String(deleted)}`);
}

export function getNote(noteId: string): Promise<NoteSummary> {
  return apiRequest<NoteSummary>(`/notes/${noteId}`);
}

export function createNote(
  payload: CreateNotePayload
): Promise<{
  id: string;
  version: number;
  rootVersion: number;
  rootSectionId: string | null;
  keyEpoch: number;
}> {
  return apiRequest("/notes", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function updateNote(
  noteId: string,
  payload: UpdateNotePayload
): Promise<{
  id: string;
  version?: number;
  rootVersion?: number;
  keyEpoch?: number;
  updatedAt: string;
}> {
  return apiRequest<{
    id: string;
    version?: number;
    rootVersion?: number;
    keyEpoch?: number;
    updatedAt: string;
  }>(`/notes/${noteId}`, {
    method: "PUT",
    body: JSON.stringify(payload)
  });
}

export function rotateNoteKey(
  noteId: string,
  payload: RotateNoteKeyPayload
): Promise<{ id: string; version: number; rootVersion?: number; keyEpoch: number }> {
  return apiRequest<{ id: string; version: number; rootVersion?: number; keyEpoch: number }>(`/notes/${noteId}/key-rotation`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function listNoteEpochLinks(noteId: string): Promise<{ links: NoteEpochLink[] }> {
  return apiRequest<{ links: NoteEpochLink[] }>(`/notes/${noteId}/epoch-links`);
}

export function listNoteMemberships(
  noteId: string
): Promise<{ memberships: NoteMembership[] }> {
  return apiRequest<{ memberships: NoteMembership[] }>(`/notes/${noteId}/memberships`);
}

export function inviteNoteMember(
  noteId: string,
  payload: InviteNoteMemberPayload
): Promise<NoteMembership> {
  return apiRequest<NoteMembership>(`/notes/${noteId}/memberships`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function updateNoteMemberRole(
  noteId: string,
  userId: string,
  role: "editor" | "viewer"
): Promise<Pick<NoteMembership, "userId" | "role" | "status"> & { noteId: string }> {
  return apiRequest<Pick<NoteMembership, "userId" | "role" | "status"> & { noteId: string }>(
    `/notes/${noteId}/memberships/${userId}`,
    {
      method: "PATCH",
      body: JSON.stringify({ role })
    }
  );
}

export function revokeNoteMember(noteId: string, userId: string): Promise<undefined> {
  return apiRequest<undefined>(`/notes/${noteId}/memberships/${userId}`, {
    method: "DELETE"
  });
}

export function getNoteKeyShare(noteId: string): Promise<NoteKeyShare> {
  return apiRequest<NoteKeyShare>(`/notes/${noteId}/key-share`);
}

export function deleteNote(noteId: string): Promise<undefined> {
  return apiRequest<undefined>(`/notes/${noteId}`, { method: "DELETE" });
}

export function restoreNote(noteId: string): Promise<{ id: string }> {
  return apiRequest<{ id: string }>(`/notes/${noteId}/restore`, { method: "POST" });
}

export function permanentlyDeleteNote(noteId: string): Promise<undefined> {
  return apiRequest<undefined>(`/notes/${noteId}/permanent`, { method: "DELETE" });
}
