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

export interface KeyMaterialResponse {
  encryptedRootKey: string;
  rootKeyNonce: string;
  kdfSalt: string;
  kdfOpsLimit: number;
  kdfMemLimit: number;
  kdfVersion: number;
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
  encryptedBytes: string;
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

export function logout(): Promise<undefined> {
  return apiRequest<undefined>("/auth/logout", { method: "POST" });
}

export function getKeyMaterial(): Promise<KeyMaterialResponse> {
  return apiRequest<KeyMaterialResponse>("/key-material");
}

export function listNotes(): Promise<{ notes: NoteSummary[] }> {
  return apiRequest<{ notes: NoteSummary[] }>("/notes");
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
    body: JSON.stringify(payload)
  });
}

export function downloadAttachment(attachmentId: string): Promise<AttachmentDownload> {
  return apiRequest<AttachmentDownload>(`/attachments/${attachmentId}`);
}

export function deleteAttachment(attachmentId: string): Promise<undefined> {
  return apiRequest<undefined>(`/attachments/${attachmentId}`, { method: "DELETE" });
}
