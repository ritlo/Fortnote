export interface RegisterPayload {
  username: string;
  authVerifier: string;
  authKdf: KdfParams;
  vaultKdf: KdfParams;
  encryptedRootKey: string;
  rootKeyNonce: string;
  recoveryAuthVerifier: string;
  recoveryKdf: KdfParams;
  recoveryEncryptedRootKey: string;
  recoveryRootKeyNonce: string;
}

export interface KdfParams {
  salt: string;
  opsLimit: number;
  memLimit: number;
  version: number;
}

export interface User {
  id: string;
  username: string;
}

export interface AuthKdfResponse {
  authKdfSalt: string;
  authKdfOpsLimit: number;
  authKdfMemLimit: number;
  authKdfVersion: number;
  vaultKdfSalt: string;
  vaultKdfOpsLimit: number;
  vaultKdfMemLimit: number;
  vaultKdfVersion: number;
}

export interface RecoveryParamsResponse {
  recoveryEncryptedRootKey: string;
  recoveryRootKeyNonce: string;
  recoveryKdfSalt: string;
  recoveryKdfOpsLimit: number;
  recoveryKdfMemLimit: number;
  recoveryKdfVersion: number;
  keyMaterialVersion: number;
}

export interface KeyMaterialResponse {
  encryptedRootKey: string;
  rootKeyNonce: string;
  kdfSalt: string;
  kdfOpsLimit: number;
  kdfMemLimit: number;
  kdfVersion: number;
  recoveryEncryptedRootKey: string;
  recoveryRootKeyNonce: string;
  recoveryKdfSalt: string;
  recoveryKdfOpsLimit: number;
  recoveryKdfMemLimit: number;
  recoveryKdfVersion: number;
  keyMaterialVersion: number;
}

export interface NoteSummary {
  id: string;
  folderId: string | null;
  title: string;
  encryptedNoteKey: string;
  noteKeyNonce: string;
  contentCipher: string;
  contentNonce: string;
  contentLength: number;
  version: number;
  isDeleted: boolean | 0 | 1;
  deletedAt?: string | null;
  updatedAt: string;
}

export interface FolderSummary {
  id: string;
  name: string;
  parentFolderId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateNotePayload {
  id: string;
  folderId?: string | null;
  title: string;
  encryptedNoteKey: string;
  noteKeyNonce: string;
  contentCipher: string;
  contentNonce: string;
  contentLength: number;
}

export interface UpdateNotePayload {
  title?: string;
  folderId?: string | null;
  contentCipher: string;
  contentNonce: string;
  contentLength: number;
  version: number;
}

export interface AttachmentSummary {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  encryptedAttachmentKey: string;
  attachmentKeyNonce: string;
  fileNonce: string;
  createdAt: string;
}

export interface AttachmentDownload extends AttachmentSummary {
  noteId: string;
  encryptedBytes: string;
}

export interface UploadAttachmentPayload {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  encryptedAttachmentKey: string;
  attachmentKeyNonce: string;
  fileNonce: string;
  encryptedBytes: Uint8Array;
}

export interface UpdateKeyMaterialPayload {
  newAuthVerifier?: string;
  authKdf?: KdfParams;
  encryptedRootKey: string;
  rootKeyNonce: string;
  vaultKdf: KdfParams;
  recoveryAuthVerifier?: string;
  recoveryKdf?: KdfParams;
  recoveryEncryptedRootKey?: string;
  recoveryRootKeyNonce?: string;
  keyMaterialVersion: number;
}

export interface SharingKeyEnvelope {
  sharingKeyVersion: number;
  publicKey: string;
  encryptedPrivateKey: string;
  privateKeyNonce: string;
  formatVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface PublicSharingKey {
  userId: string;
  username: string;
  sharingKeyVersion: number;
  publicKey: string;
  formatVersion: number;
  createdAt: string;
}

export interface StoreSharingKeyPayload {
  sharingKeyVersion: number;
  publicKey: string;
  encryptedPrivateKey: string;
  privateKeyNonce: string;
  formatVersion: number;
}

export interface RecoverPayload {
  username: string;
  recoveryAuthVerifier: string;
  newAuthVerifier: string;
  authKdf: KdfParams;
  vaultKdf: KdfParams;
  encryptedRootKey: string;
  rootKeyNonce: string;
  keyMaterialVersion: number;
}

export async function apiRequest<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: "include",
    headers
  });

  if (!response.ok) {
    const error = (await response.json().catch(() => undefined)) as
      | { message?: string }
      | undefined;
    throw new Error(error?.message ?? `Request failed: ${String(response.status)}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export function getMe(): Promise<User> {
  return apiRequest<User>("/auth/me");
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
    body: JSON.stringify(payload)
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

export function storeCurrentSharingKey(
  payload: StoreSharingKeyPayload
): Promise<{ sharingKeyVersion: number }> {
  return apiRequest<{ sharingKeyVersion: number }>("/sharing-keys/current", {
    method: "PUT",
    body: JSON.stringify(payload)
  });
}

export function lookupSharingKey(username: string): Promise<PublicSharingKey> {
  return apiRequest<PublicSharingKey>(
    `/sharing-keys/lookup?username=${encodeURIComponent(username)}`
  );
}

export function listNotes(deleted = false): Promise<{ notes: NoteSummary[] }> {
  return apiRequest<{ notes: NoteSummary[] }>(`/notes?deleted=${String(deleted)}`);
}

export function createNote(payload: CreateNotePayload): Promise<{ id: string; version: number }> {
  return apiRequest<{ id: string; version: number }>("/notes", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function updateNote(
  noteId: string,
  payload: UpdateNotePayload
): Promise<{ id: string; version: number }> {
  return apiRequest<{ id: string; version: number }>(`/notes/${noteId}`, {
    method: "PUT",
    body: JSON.stringify(payload)
  });
}

export function listAttachments(noteId: string): Promise<{ attachments: AttachmentSummary[] }> {
  return apiRequest<{ attachments: AttachmentSummary[] }>(`/notes/${noteId}/attachments`);
}

export function uploadAttachment(
  noteId: string,
  payload: UploadAttachmentPayload
): Promise<{ id: string }> {
  return apiRequest<{ id: string }>(`/notes/${noteId}/attachments`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-fortnote-attachment-id": payload.id,
      "x-fortnote-filename": encodeURIComponent(payload.filename),
      "x-fortnote-mime-type": encodeURIComponent(payload.mimeType),
      "x-fortnote-size": String(payload.size),
      "x-fortnote-encrypted-attachment-key": payload.encryptedAttachmentKey,
      "x-fortnote-attachment-key-nonce": payload.attachmentKeyNonce,
      "x-fortnote-file-nonce": payload.fileNonce
    },
    body: new Blob([payload.encryptedBytes.slice()])
  });
}

export function downloadAttachment(attachmentId: string): Promise<AttachmentDownload> {
  return apiRequest<AttachmentDownload>(`/attachments/${attachmentId}`);
}

export function deleteAttachment(attachmentId: string): Promise<undefined> {
  return apiRequest<undefined>(`/attachments/${attachmentId}`, { method: "DELETE" });
}

export function listFolders(): Promise<{ folders: FolderSummary[] }> {
  return apiRequest<{ folders: FolderSummary[] }>("/folders");
}

export function createFolder(payload: {
  name: string;
  parentFolderId?: string | null;
}): Promise<{ id: string; name: string; parentFolderId: string | null }> {
  return apiRequest<{ id: string; name: string; parentFolderId: string | null }>(
    "/folders",
    {
      method: "POST",
      body: JSON.stringify(payload)
    }
  );
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
