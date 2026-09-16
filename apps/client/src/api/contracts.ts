import type { KdfParams } from "@fortnote/shared";

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
  cryptoOwnerId: string;
  keyEpoch: number;
  kind: ContentUploadKind;
  firstSequence: number;
  lastSequence: number;
  totalCipherBytes: number;
  chunkCount: number;
  manifestHash: string;
  checkpointSequenceCutoff?: number;
}

export interface DownloadedContentChunk {
  bytes: Uint8Array;
  cipherHash: string;
  cipherLength: number;
  nonce: string;
}

export interface LogicalNoteSectionSummary {
  id: string;
  noteId: string;
  createdEpoch: number;
  currentSequence: number;
  initialized: boolean;
  isDeleted: boolean;
}

export interface SectionInitializationResult {
  status: "installed" | "already-initialized";
  manifestId: string;
  rootVersion: number;
  version: number;
}

export interface SectionCreationResult {
  status: "created" | "already-created";
  section: LogicalNoteSectionSummary;
  rootVersion: number;
  version: number;
}

export interface SectionDeletionResult {
  status: "deleted" | "already-deleted";
  rootVersion: number;
  version: number;
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
  titleCipher: string;
  titleNonce: string;
  titleFormatVersion: number;
  encryptedNoteKey: string | null;
  noteKeyNonce: string | null;
  noteKeyFormatVersion?: number | null;
  version: number;
  rootVersion?: number;
  rootSectionId: string;
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

export interface EncryptedFolderSummary {
  id: string;
  nameCipher: string;
  nameNonce: string;
  nameFormatVersion: number;
  parentFolderId: string | null;
  createdAt: string;
  updatedAt: string;
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

export type CreateNotePayload = ProtectedCreateNotePayload;

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

export type UpdateNotePayload = ProtectedUpdateNotePayload;

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

export type RotateNoteKeyPayload = LinkedRotateNoteKeyPayload;

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
  metadataCipher: string;
  metadataNonce: string;
  metadataFormatVersion: number;
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
