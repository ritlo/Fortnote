import type {
  AuthKdfResponse,
  CollaborationEvent,
  ContentManifestCommitPayload,
  ContentManifestSummary,
  ContentUploadBeginPayload,
  ContentUploadStatus,
  CreateNotePayload,
  DownloadedContentChunk,
  EncryptedFolderSummary,
  InviteNoteMemberPayload,
  KeyMaterialResponse,
  LegacyNoteContent,
  LegacySectionReservation,
  LogicalNoteSectionSummary,
  NoteEpochLink,
  NoteKeyShare,
  NoteMembership,
  NoteSummary,
  PublicSharingKey,
  RecoverPayload,
  RecoveryParamsResponse,
  RegisterPayload,
  RotateNoteKeyPayload,
  SectionCreationResult,
  SectionDeletionResult,
  SectionHistoryPage,
  SectionInitializationResult,
  SharingKeyEnvelope,
  StorageQuotaStatus,
  StoreSharingKeyPayload,
  UpdateKeyMaterialPayload,
  UpdateNotePayload,
  User
} from "./api/contracts";
import {
  apiBinaryRequest,
  apiRequest,
  ApiRequestError
} from "./api/http";

export * from "./api/contracts";
export * from "./api/attachments";
export {
  apiRequest,
  ApiRequestError,
  getClientInstanceId,
  isApiRequestError,
  JSON_CONTROL_MAX_BYTES
} from "./api/http";

export function beginContentUpload(
  payload: ContentUploadBeginPayload
): Promise<ContentUploadStatus> {
  return apiRequest<ContentUploadStatus>("/content/uploads", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function inspectContentUpload(uploadId: string): Promise<ContentUploadStatus> {
  return apiRequest<ContentUploadStatus>(`/content/uploads/${uploadId}`);
}

export async function putContentChunk(
  uploadId: string,
  chunkIndex: number,
  bytes: Uint8Array,
  cipherHash: string,
  nonce: string
): Promise<void> {
  await apiBinaryRequest(`/content/uploads/${uploadId}/chunks/${String(chunkIndex)}`, {
    method: "PUT",
    headers: {
      "content-type": "application/octet-stream",
      "x-fortnote-cipher-hash": cipherHash,
      "x-fortnote-nonce": nonce
    },
    body: new Blob([bytes.slice()])
  });
}

export function abortContentUpload(uploadId: string): Promise<undefined> {
  return apiRequest<undefined>(`/content/uploads/${uploadId}`, { method: "DELETE" });
}

export function commitContentManifest(
  uploadId: string,
  payload: ContentManifestCommitPayload
): Promise<ContentManifestSummary> {
  return apiRequest<ContentManifestSummary>(`/content/uploads/${uploadId}/commit`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function downloadContentChunk(
  manifestId: string,
  chunkIndex: number
): Promise<DownloadedContentChunk> {
  return apiBinaryRequest(
    `/content/manifests/${manifestId}/chunks/${String(chunkIndex)}`
  ).then(({ bytes, headers }) => {
    const cipherHash = headers.get("x-fortnote-cipher-hash") ?? "";
    const nonce = headers.get("x-fortnote-nonce") ?? "";
    const cipherLength = Number(headers.get("content-length"));
    if (
      !/^[0-9a-f]{64}$/u.test(cipherHash) ||
      !canonicalNonce(nonce) ||
      !Number.isSafeInteger(cipherLength) ||
      cipherLength <= 0 ||
      cipherLength !== bytes.byteLength
    ) {
      throw new ApiRequestError(
        0,
        "invalid_binary_response",
        "Encrypted content response metadata is invalid"
      );
    }
    return { bytes, cipherHash, cipherLength, nonce };
  });
}

function canonicalNonce(value: string): boolean {
  try {
    const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    return bytes.byteLength === 24 && btoa(String.fromCharCode(...bytes)) === value;
  } catch {
    return false;
  }
}

export function listNoteSections(noteId: string): Promise<{ sections: LogicalNoteSectionSummary[] }> {
  return apiRequest<{ sections: LogicalNoteSectionSummary[] }>(`/notes/${noteId}/sections`);
}

export function getLegacyNoteContent(noteId: string): Promise<LegacyNoteContent> {
  return apiRequest<LegacyNoteContent>(`/notes/${noteId}/legacy-content`);
}

export function reserveLegacyRootSection(
  noteId: string,
  payload: {
    sectionId: string;
    expectedKeyEpoch: number;
    expectedRootVersion: number;
  }
): Promise<LegacySectionReservation> {
  return apiRequest<LegacySectionReservation>(
    `/notes/${noteId}/sections/legacy-reservation`,
    { method: "POST", body: JSON.stringify(payload) }
  );
}

export function initializeNoteSection(
  noteId: string,
  sectionId: string,
  payload: {
    manifestId: string;
    expectedKeyEpoch: number;
    expectedRootVersion: number;
  }
): Promise<SectionInitializationResult> {
  return apiRequest<SectionInitializationResult>(
    `/notes/${noteId}/sections/${sectionId}/initialization`,
    { method: "POST", body: JSON.stringify(payload) }
  );
}

export function createNoteSection(
  noteId: string,
  payload: {
    sectionId: string;
    expectedKeyEpoch: number;
    expectedRootVersion: number;
  }
): Promise<SectionCreationResult> {
  return apiRequest<SectionCreationResult>(`/notes/${noteId}/sections`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function deleteNoteSection(
  noteId: string,
  sectionId: string,
  payload: { expectedKeyEpoch: number; expectedRootVersion: number }
): Promise<SectionDeletionResult> {
  return apiRequest<SectionDeletionResult>(`/notes/${noteId}/sections/${sectionId}`, {
    method: "DELETE",
    body: JSON.stringify(payload)
  });
}

export function getSectionHistory(
  noteId: string,
  sectionId: string,
  afterSequence: number
): Promise<SectionHistoryPage> {
  return apiRequest<SectionHistoryPage>(
    `/notes/${noteId}/sections/${sectionId}/history?after=${String(afterSequence)}`
  );
}

export function getStorageQuota(): Promise<StorageQuotaStatus> {
  return apiRequest<StorageQuotaStatus>("/content/quota");
}

export function getMe(): Promise<User> {
  return apiRequest<User>("/auth/me");
}

const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{1,62}[a-z0-9])$/u;

export function normalizeAccountHandle(value: string): string {
  const canonical = value.trim().toLowerCase();
  return HANDLE_PATTERN.test(canonical) ? canonical : value;
}

export function getAuthKdfParams(username: string): Promise<AuthKdfResponse> {
  return apiRequest<AuthKdfResponse>(
    `/auth/kdf-params?username=${encodeURIComponent(username)}`
  );
}

export function getRecoveryParams(username: string): Promise<RecoveryParamsResponse> {
  return apiRequest<RecoveryParamsResponse>(
    `/auth/recovery-params?username=${encodeURIComponent(username)}`
  );
}

export function login(username: string, authVerifier: string): Promise<User> {
  return apiRequest<User>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, authVerifier })
  });
}

export function register(payload: RegisterPayload): Promise<User> {
  return apiRequest<User>("/auth/register", {
    method: "POST",
    body: JSON.stringify({
      ...payload,
      username: normalizeAccountHandle(payload.username)
    })
  });
}

export function recover(payload: RecoverPayload): Promise<User> {
  return apiRequest<User>("/auth/recover", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function logout(): Promise<undefined> {
  return apiRequest<undefined>("/auth/logout", { method: "POST" });
}

export function repairAccountHandle(handle: string): Promise<User> {
  return apiRequest<User>("/auth/handle", {
    method: "PUT",
    body: JSON.stringify({ handle: normalizeAccountHandle(handle) })
  });
}

export function getKeyMaterial(): Promise<KeyMaterialResponse> {
  return apiRequest<KeyMaterialResponse>("/key-material");
}

export function updateKeyMaterial(
  payload: UpdateKeyMaterialPayload
): Promise<{ keyMaterialVersion: number }> {
  return apiRequest<{ keyMaterialVersion: number }>("/key-material", {
    method: "PUT",
    body: JSON.stringify(payload)
  });
}

export function getCurrentSharingKey(): Promise<SharingKeyEnvelope> {
  return apiRequest<SharingKeyEnvelope>("/sharing-keys/current");
}

export function getSharingKeyVersion(version: number): Promise<SharingKeyEnvelope> {
  return apiRequest<SharingKeyEnvelope>(`/sharing-keys/versions/${String(version)}`);
}

export function storeCurrentSharingKey(
  payload: StoreSharingKeyPayload
): Promise<{ sharingKeyVersion: number }> {
  return apiRequest<{ sharingKeyVersion: number }>("/sharing-keys/current", {
    method: "PUT",
    body: JSON.stringify(payload)
  });
}

export function cleanupRetiredSharingKeys(): Promise<{ deleted: number }> {
  return apiRequest<{ deleted: number }>("/sharing-keys/cleanup", {
    method: "POST"
  });
}

export function lookupSharingKey(username: string): Promise<PublicSharingKey> {
  return apiRequest<PublicSharingKey>(
    `/sharing-keys/lookup?username=${encodeURIComponent(normalizeAccountHandle(username))}`
  );
}

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

export function listCollaborationEvents(
  after: number,
  limit = 100
): Promise<{ events: CollaborationEvent[] }> {
  return apiRequest<{ events: CollaborationEvent[] }>(
    `/events?after=${String(after)}&limit=${String(limit)}`
  );
}

export function getCollaborationEventCursor(): Promise<{ cursor: number }> {
  return apiRequest<{ cursor: number }>("/events/cursor");
}

export function acknowledgeCollaborationEvents(cursor: number): Promise<undefined> {
  return apiRequest<undefined>("/events/ack", {
    method: "POST",
    body: JSON.stringify({ cursor })
  });
}

export function listFolders(): Promise<{ folders: EncryptedFolderSummary[] }> {
  return apiRequest<{ folders: EncryptedFolderSummary[] }>("/folders");
}

export function createFolder(
  payload:
    | { name: string; parentFolderId?: string | null }
    | {
        id: string;
        nameCipher: string;
        nameNonce: string;
        nameFormatVersion: 2;
        parentFolderId?: string | null;
      }
): Promise<EncryptedFolderSummary> {
  return apiRequest<EncryptedFolderSummary>("/folders", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function updateFolder(
  folderId: string,
  payload: {
    nameCipher: string;
    nameNonce: string;
    nameFormatVersion: 2;
    parentFolderId?: string | null;
  }
): Promise<EncryptedFolderSummary> {
  return apiRequest<EncryptedFolderSummary>(`/folders/${folderId}`, {
    method: "PUT",
    body: JSON.stringify(payload)
  });
}

export function deleteFolder(folderId: string): Promise<undefined> {
  return apiRequest<undefined>(`/folders/${folderId}`, { method: "DELETE" });
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
