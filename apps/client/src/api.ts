import { KdfParams } from "@fortnote/shared";

export const JSON_CONTROL_MAX_BYTES = 1024 * 1024;

export type ContentUploadKind = "update" | "checkpoint" | "root-update";

export interface ContentUploadBeginPayload {
  uploadId: string;
  updateId: string;
  noteId: string;
  sectionId: string;
  expectedKeyEpoch: number;
  kind: ContentUploadKind;
  formatVersion: 2;
  totalCipherBytes: number;
  chunkCount: number;
  manifestHash: string;
  checkpointSequenceCutoff?: number;
}

export interface ContentUploadStatus {
  uploadId: string;
  status: "receiving" | "complete" | "committed" | "aborted" | "expired" | "invalid";
  receivedChunkIndexes: number[];
  reservedBytes: number;
  expiresAt: string;
}

export interface ContentManifestCommitPayload {
  requestId: string;
  updateId: string;
  expectedKeyEpoch: number;
}

export interface ContentManifestSummary {
  manifestId: string;
  uploadId: string;
  updateId: string;
  noteId: string;
  sectionId: string;
  keyEpoch: number;
  kind: ContentUploadKind;
  firstSequence: number;
  lastSequence: number;
  totalCipherBytes: number;
  chunkCount: number;
  manifestHash: string;
}

export interface LogicalNoteSectionSummary {
  id: string;
  noteId: string;
  createdEpoch: number;
  currentSequence: number;
  initialized: boolean;
  isDeleted: boolean;
}

export interface SectionHistoryPage {
  sectionId: string;
  keyEpoch: number;
  afterSequence: number;
  nextSequence: number;
  hasMore: boolean;
  entries: Array<
    | { kind: "inline"; updateId: string; serverSequence: number; cipher: Uint8Array }
    | { kind: "manifest"; updateId: string; serverSequence: number; manifestId: string }
  >;
}

export interface StorageQuotaStatus {
  usedBytes: number;
  reservedBytes: number;
  quotaBytes: number;
  availableBytes: number;
}

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
  encryptedNoteKey: string | null;
  noteKeyNonce: string | null;
  contentCipher: string;
  contentNonce: string;
  contentLength: number;
  version: number;
  keyEpoch: number;
  isDeleted: boolean | 0 | 1;
  deletedAt?: string | null;
  updatedAt: string;
  ownerUserId: string;
  cryptoOwnerId: string;
  role: "owner" | "editor" | "viewer";
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

export interface RotateNoteKeyPayload {
  encryptedNoteKey: string;
  noteKeyNonce: string;
  contentCipher: string;
  contentNonce: string;
  contentLength: number;
  version: number;
  shares: {
    recipientUserId: string;
    sharingKeyVersion: number;
    encryptedNoteKey: string;
    formatVersion: number;
  }[];
  attachmentKeys: {
    attachmentId: string;
    encryptedAttachmentKey: string;
    attachmentKeyNonce: string;
  }[];
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

export interface NoteMembership {
  userId: string;
  username: string;
  role: "owner" | "editor" | "viewer";
  status: "active" | "invited" | "revoked";
  createdAt: string;
  updatedAt: string;
}

export interface InviteNoteMemberPayload {
  username: string;
  role: "editor" | "viewer";
  sharingKeyVersion: number;
  encryptedNoteKey: string;
  formatVersion: number;
}

export interface NoteKeyShare {
  noteId: string;
  recipientUserId: string;
  senderUserId: string;
  sharingKeyVersion: number;
  encryptedNoteKey: string;
  formatVersion: number;
  createdAt: string;
}

export interface CollaborationEvent {
  cursor: number;
  eventId: string;
  type: string;
  resourceType: string;
  resourceId: string;
  noteId: string | null;
  actorUserId: string;
  version: number | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export type PresenceState = "idle" | "editing";

export interface PresenceUser {
  userId: string;
  username: string;
  state: PresenceState;
  updatedAt: string;
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

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId: string | null = null
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

const clientInstanceId = crypto.randomUUID();

export function getClientInstanceId(): string {
  return clientInstanceId;
}

export function isApiRequestError(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError;
}

export async function apiRequest<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const requestId = crypto.randomUUID();
  const headers = requestHeaders(init, requestId, true);
  assertBoundedJsonControl(init.body, headers, requestId);

  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: "include",
    headers
  });

  if (!response.ok) {
    throw await toApiRequestError(response, requestId);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

async function apiBinaryRequest(path: string, init: RequestInit = {}): Promise<Uint8Array> {
  const requestId = crypto.randomUUID();
  const headers = requestHeaders(init, requestId, false);
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: "include",
    headers
  });
  if (!response.ok) {
    throw await toApiRequestError(response, requestId);
  }
  if (response.status === 204) {
    return new Uint8Array();
  }
  return new Uint8Array(await response.arrayBuffer());
}

function requestHeaders(init: RequestInit, requestId: string, defaultJson: boolean): Headers {
  const headers = new Headers(init.headers);
  if (defaultJson && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  headers.set("x-fortnote-client-id", clientInstanceId);
  headers.set("x-request-id", requestId);
  return headers;
}

function assertBoundedJsonControl(
  body: BodyInit | null | undefined,
  headers: Headers,
  requestId: string
): void {
  if (
    typeof body === "string" &&
    headers.get("content-type")?.toLowerCase().startsWith("application/json") &&
    new TextEncoder().encode(body).length > JSON_CONTROL_MAX_BYTES
  ) {
    throw new ApiRequestError(
      0,
      "control_payload_too_large",
      "Control payload exceeds 1 MiB; protected content must use binary chunks",
      requestId
    );
  }
}

async function toApiRequestError(
  response: Response,
  fallbackRequestId: string
): Promise<ApiRequestError> {
  const payload = (await response.json().catch(() => undefined)) as unknown;
  const parsed = parseApiErrorEnvelope(payload);
  return new ApiRequestError(
    response.status,
    parsed?.code ?? "request_failed",
    parsed?.message ?? `Request failed: ${String(response.status)}`,
    parsed?.requestId ?? response.headers.get("x-request-id") ?? fallbackRequestId
  );
}

function parseApiErrorEnvelope(value: unknown): {
  code: string;
  message: string;
  requestId: string | null;
} | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const outer = value as Record<string, unknown>;
  const candidate =
    outer.error && typeof outer.error === "object"
      ? (outer.error as Record<string, unknown>)
      : outer;
  if (typeof candidate.code !== "string" || typeof candidate.message !== "string") {
    return null;
  }
  return {
    code: candidate.code,
    message: candidate.message,
    requestId: typeof candidate.requestId === "string" ? candidate.requestId : null
  };
}

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
  cipherHash: string
): Promise<void> {
  await apiBinaryRequest(`/content/uploads/${uploadId}/chunks/${String(chunkIndex)}`, {
    method: "PUT",
    headers: {
      "content-type": "application/octet-stream",
      "x-fortnote-cipher-hash": cipherHash
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
): Promise<Uint8Array> {
  return apiBinaryRequest(`/content/manifests/${manifestId}/chunks/${String(chunkIndex)}`);
}

export function listNoteSections(noteId: string): Promise<{ sections: LogicalNoteSectionSummary[] }> {
  return apiRequest<{ sections: LogicalNoteSectionSummary[] }>(`/notes/${noteId}/sections`);
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
): Promise<{ id: string; version: number; updatedAt: string }> {
  return apiRequest<{ id: string; version: number; updatedAt: string }>(`/notes/${noteId}`, {
    method: "PUT",
    body: JSON.stringify(payload)
  });
}

export function rotateNoteKey(
  noteId: string,
  payload: RotateNoteKeyPayload
): Promise<{ id: string; version: number; keyEpoch: number }> {
  return apiRequest<{ id: string; version: number; keyEpoch: number }>(`/notes/${noteId}/key-rotation`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
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
