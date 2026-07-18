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
  entries: (
    | { kind: "inline"; updateId: string; serverSequence: number; cipher: Uint8Array }
    | { kind: "manifest"; updateId: string; serverSequence: number; manifestId: string }
  )[];
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
  displayName?: string;
  canonicalHandle?: string | null;
  handleState?: "active" | "repair-required";
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
  userId?: string;
  recoveryEncryptedRootKey: string;
  recoveryRootKeyNonce: string;
  recoveryRootKeyFormatVersion?: number;
  recoveryRootKeyContextVersion?: number;
  recoveryKdfSalt: string;
  recoveryKdfOpsLimit: number;
  recoveryKdfMemLimit: number;
  recoveryKdfVersion: number;
  keyMaterialVersion: number;
}

export interface KeyMaterialResponse {
  encryptedRootKey: string;
  rootKeyNonce: string;
  rootKeyFormatVersion?: number;
  rootKeyContextVersion?: number;
  kdfSalt: string;
  kdfOpsLimit: number;
  kdfMemLimit: number;
  kdfVersion: number;
  recoveryEncryptedRootKey: string;
  recoveryRootKeyNonce: string;
  recoveryRootKeyFormatVersion?: number;
  recoveryRootKeyContextVersion?: number;
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
  titleCipher?: string | null;
  titleNonce?: string | null;
  titleFormatVersion?: number | null;
  encryptedNoteKey: string | null;
  noteKeyNonce: string | null;
  noteKeyFormatVersion?: number | null;
  contentCipher?: string;
  contentNonce?: string;
  contentLength: number;
  version: number;
  rootVersion?: number;
  rootSectionId?: string | null;
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
  metadataMigration?: "current" | "write-v2-pending" | "retry-required";
  parentFolderId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EncryptedFolderSummary {
  id: string;
  name: string;
  nameCipher: string | null;
  nameNonce: string | null;
  nameFormatVersion: number | null;
  parentFolderId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface LegacyCreateNotePayload {
  id: string;
  folderId?: string | null;
  title: string;
  encryptedNoteKey: string;
  noteKeyNonce: string;
  contentCipher: string;
  contentNonce: string;
  contentLength: number;
}

export interface ProtectedCreateNotePayload {
  id: string;
  folderId?: string | null;
  rootSectionId: string;
  titleCipher: string;
  titleNonce: string;
  titleFormatVersion: 2;
  encryptedNoteKey: string;
  noteKeyNonce: string;
  noteKeyFormatVersion: 2;
}

export type CreateNotePayload = LegacyCreateNotePayload | ProtectedCreateNotePayload;

interface LegacyUpdateNotePayload {
  title?: string;
  folderId?: string | null;
  contentCipher: string;
  contentNonce: string;
  contentLength: number;
  version: number;
}

export interface ProtectedUpdateNotePayload {
  folderId?: string | null;
  titleCipher?: string;
  titleNonce?: string;
  titleFormatVersion?: 2;
  encryptedNoteKey?: string;
  noteKeyNonce?: string;
  noteKeyFormatVersion?: 2;
  rootSectionId?: string;
  rootVersion: number;
  keyEpoch: number;
}

export type UpdateNotePayload = LegacyUpdateNotePayload | ProtectedUpdateNotePayload;

export interface LegacyRotateNoteKeyPayload {
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

export interface LinkedRotateNoteKeyPayload {
  mode: "linked";
  revokedUserId: string;
  rootVersion: number;
  sourceEpoch: number;
  targetEpoch: number;
  encryptedNoteKey: string;
  noteKeyNonce: string;
  noteKeyFormatVersion: 2;
  titleCipher: string;
  titleNonce: string;
  titleFormatVersion: 2;
  previousKeyCipher: string;
  previousKeyNonce: string;
  linkFormatVersion: 2;
  shares: {
    recipientUserId: string;
    sharingKeyVersion: number;
    encryptedNoteKey: string;
    formatVersion: 2;
  }[];
}

export type RotateNoteKeyPayload =
  | LegacyRotateNoteKeyPayload
  | LinkedRotateNoteKeyPayload;

export interface NoteEpochLink {
  sourceEpoch: number;
  targetEpoch: number;
  previousKeyCipher: string;
  nonce: string;
  formatVersion: number;
  createdAt: string;
}

export interface AttachmentSummary {
  id: string;
  filename: string;
  mimeType: string;
  keyEpoch: number;
  size: number;
  encryptedAttachmentKey: string;
  attachmentKeyNonce: string;
  fileNonce: string;
  createdAt: string;
}

export interface EncryptedAttachmentSummary {
  id: string;
  filename?: string;
  mimeType?: string;
  metadataCipher: string | null;
  metadataNonce: string | null;
  metadataFormatVersion: number | null;
  keyEpoch: number;
  size: number;
  encryptedAttachmentKey: string;
  attachmentKeyNonce: string;
  fileNonce: string;
  createdAt: string;
}

export interface AttachmentDownload {
  id: string;
  noteId: string;
  keyEpoch: number;
  encryptedBytes: Uint8Array;
}

export interface UploadAttachmentPayload {
  id: string;
  expectedKeyEpoch: number;
  metadataCipher: string;
  metadataNonce: string;
  metadataFormatVersion: 2;
  size: number;
  encryptedAttachmentKey: string;
  attachmentKeyNonce: string;
  fileNonce: string;
  encryptedBytes: Uint8Array;
}

export interface BinaryTransferProgress {
  loadedBytes: number;
  totalBytes: number | null;
}

export interface UpdateKeyMaterialPayload {
  newAuthVerifier?: string;
  authKdf?: KdfParams;
  encryptedRootKey: string;
  rootKeyNonce: string;
  rootKeyFormatVersion?: number;
  rootKeyContextVersion?: number;
  vaultKdf: KdfParams;
  recoveryAuthVerifier?: string;
  recoveryKdf?: KdfParams;
  recoveryEncryptedRootKey?: string;
  recoveryRootKeyNonce?: string;
  recoveryRootKeyFormatVersion?: number;
  recoveryRootKeyContextVersion?: number;
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
  rootKeyFormatVersion?: number;
  rootKeyContextVersion?: number;
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

function applyXhrHeaders(xhr: XMLHttpRequest, headers: Headers): void {
  headers.forEach((value, name) => {
    xhr.setRequestHeader(name, value);
  });
}

function xhrRequestError(xhr: XMLHttpRequest, requestId: string): ApiRequestError {
  const payload = parseXhrPayload(xhr.response as unknown);
  const parsed = parseApiErrorEnvelope(payload);
  return new ApiRequestError(
    xhr.status,
    parsed?.code ?? "request_failed",
    parsed?.message ?? `Request failed: ${String(xhr.status)}`,
    parsed?.requestId ?? xhr.getResponseHeader("x-request-id") ?? requestId
  );
}

function parseXhrPayload(value: unknown): unknown {
  if (value instanceof ArrayBuffer) {
    const text = new TextDecoder().decode(value);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  }
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }
  return value;
}

function transferProgress(
  event: ProgressEvent,
  fallbackTotalBytes: number,
  onProgress: ((progress: BinaryTransferProgress) => void) | undefined
): void {
  onProgress?.({
    loadedBytes: event.loaded,
    totalBytes: event.lengthComputable ? event.total : fallbackTotalBytes
  });
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

export function listAttachments(
  noteId: string
): Promise<{ attachments: EncryptedAttachmentSummary[] }> {
  return apiRequest<{ attachments: EncryptedAttachmentSummary[] }>(
    `/notes/${noteId}/attachments`
  );
}

export function uploadAttachment(
  noteId: string,
  payload: UploadAttachmentPayload,
  onProgress?: (progress: BinaryTransferProgress) => void
): Promise<{ id: string; keyEpoch: number }> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/notes/${noteId}/attachments`);
    xhr.withCredentials = true;
    xhr.responseType = "json";
    applyXhrHeaders(
      xhr,
      requestHeaders(
        {
          headers: {
            "content-type": "application/octet-stream",
            "x-fortnote-attachment-id": payload.id,
            "x-fortnote-size": String(payload.size),
            "x-fortnote-expected-key-epoch": String(payload.expectedKeyEpoch),
            "x-fortnote-metadata-cipher": payload.metadataCipher,
            "x-fortnote-metadata-nonce": payload.metadataNonce,
            "x-fortnote-metadata-format-version": String(
              payload.metadataFormatVersion
            ),
            "x-fortnote-encrypted-attachment-key": payload.encryptedAttachmentKey,
            "x-fortnote-attachment-key-nonce": payload.attachmentKeyNonce,
            "x-fortnote-file-nonce": payload.fileNonce
          }
        },
        requestId,
        false
      )
    );
    xhr.upload.addEventListener("progress", (event) => {
      transferProgress(event, payload.size, onProgress);
    });
    xhr.addEventListener("load", () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(xhrRequestError(xhr, requestId));
        return;
      }
      const result = xhr.response as unknown;
      if (
        !result ||
        typeof result !== "object" ||
        typeof (result as Record<string, unknown>).id !== "string" ||
        typeof (result as Record<string, unknown>).keyEpoch !== "number"
      ) {
        reject(
          new ApiRequestError(
            xhr.status,
            "invalid_response",
            "Invalid attachment upload response",
            requestId
          )
        );
        return;
      }
      resolve(result as { id: string; keyEpoch: number });
    });
    xhr.addEventListener("error", () => {
      reject(new ApiRequestError(0, "network_error", "Attachment upload failed", requestId));
    });
    xhr.addEventListener("abort", () => {
      reject(new ApiRequestError(0, "request_aborted", "Attachment upload canceled", requestId));
    });
    xhr.send(payload.encryptedBytes.slice().buffer);
  });
}

export function downloadAttachment(
  attachmentId: string,
  onProgress?: (progress: BinaryTransferProgress) => void
): Promise<AttachmentDownload> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", `/api/attachments/${attachmentId}`);
    xhr.withCredentials = true;
    xhr.responseType = "arraybuffer";
    applyXhrHeaders(xhr, requestHeaders({}, requestId, false));
    xhr.addEventListener("progress", (event) => {
      transferProgress(event, 0, onProgress);
    });
    xhr.addEventListener("load", () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(xhrRequestError(xhr, requestId));
        return;
      }
      const id = xhr.getResponseHeader("x-fortnote-attachment-id");
      const noteId = xhr.getResponseHeader("x-fortnote-note-id");
      const keyEpoch = Number(xhr.getResponseHeader("x-fortnote-key-epoch"));
      const bytes = xhr.response as unknown;
      if (
        id !== attachmentId ||
        !noteId ||
        !Number.isSafeInteger(keyEpoch) ||
        keyEpoch <= 0 ||
        !(bytes instanceof ArrayBuffer)
      ) {
        reject(
          new ApiRequestError(
            xhr.status,
            "invalid_response",
            "Invalid attachment download response",
            requestId
          )
        );
        return;
      }
      resolve({
        id,
        noteId,
        keyEpoch,
        encryptedBytes: new Uint8Array(bytes)
      });
    });
    xhr.addEventListener("error", () => {
      reject(new ApiRequestError(0, "network_error", "Attachment download failed", requestId));
    });
    xhr.addEventListener("abort", () => {
      reject(
        new ApiRequestError(0, "request_aborted", "Attachment download canceled", requestId)
      );
    });
    xhr.send();
  });
}

export function deleteAttachment(attachmentId: string): Promise<undefined> {
  return apiRequest<undefined>(`/attachments/${attachmentId}`, { method: "DELETE" });
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
