import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  blob,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  displayName: text("display_name"),
  canonicalHandle: text("canonical_handle"),
  handleState: text("handle_state").notNull().default("legacy"),
  authVerifierHash: text("auth_verifier_hash").notNull(),
  authKdfSalt: text("auth_kdf_salt").notNull(),
  authKdfOpsLimit: integer("auth_kdf_ops_limit").notNull(),
  authKdfMemLimit: integer("auth_kdf_mem_limit").notNull(),
  authKdfVersion: integer("auth_kdf_version").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`)
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  sessionHash: text("session_hash").notNull().unique(),
  idleExpiresAt: text("idle_expires_at").notNull(),
  absoluteExpiresAt: text("absolute_expires_at").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  lastSeenAt: text("last_seen_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`)
});

export const userKeyMaterial = sqliteTable("user_key_material", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  encryptedRootKey: text("encrypted_root_key").notNull(),
  rootKeyNonce: text("root_key_nonce").notNull(),
  rootKeyFormatVersion: integer("root_key_format_version").notNull().default(1),
  rootKeyContextVersion: integer("root_key_context_version").notNull().default(1),
  kdfSalt: text("kdf_salt").notNull(),
  kdfOpsLimit: integer("kdf_ops_limit").notNull(),
  kdfMemLimit: integer("kdf_mem_limit").notNull(),
  kdfVersion: integer("kdf_version").notNull(),
  recoveryEncryptedRootKey: text("recovery_encrypted_root_key").notNull(),
  recoveryRootKeyNonce: text("recovery_root_key_nonce").notNull(),
  recoveryRootKeyFormatVersion: integer("recovery_root_key_format_version")
    .notNull()
    .default(1),
  recoveryRootKeyContextVersion: integer("recovery_root_key_context_version")
    .notNull()
    .default(1),
  recoveryAuthVerifierHash: text("recovery_auth_verifier_hash").notNull(),
  recoveryKdfSalt: text("recovery_kdf_salt").notNull(),
  recoveryKdfOpsLimit: integer("recovery_kdf_ops_limit").notNull(),
  recoveryKdfMemLimit: integer("recovery_kdf_mem_limit").notNull(),
  recoveryKdfVersion: integer("recovery_kdf_version").notNull(),
  keyMaterialVersion: integer("key_material_version").notNull().default(1),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`)
});

export const folders = sqliteTable("folders", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  nameCipher: text("name_cipher"),
  nameNonce: text("name_nonce"),
  nameFormatVersion: integer("name_format_version"),
  parentFolderId: text("parent_folder_id").references((): AnySQLiteColumn => folders.id, {
    onDelete: "set null"
  }),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`)
});

export const notes = sqliteTable("notes", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  cryptoOwnerId: text("crypto_owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  folderId: text("folder_id").references(() => folders.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  titleCipher: text("title_cipher"),
  titleNonce: text("title_nonce"),
  titleFormatVersion: integer("title_format_version"),
  encryptedNoteKey: text("encrypted_note_key").notNull(),
  noteKeyNonce: text("note_key_nonce").notNull(),
  noteKeyFormatVersion: integer("note_key_format_version").notNull().default(1),
  contentCipher: text("content_cipher").notNull(),
  contentNonce: text("content_nonce").notNull(),
  contentLength: integer("content_length").notNull(),
  contentUpdatedAt: text("content_updated_at").notNull(),
  version: integer("version").notNull().default(1),
  rootVersion: integer("root_version").notNull().default(1),
  rootSectionId: text("root_section_id"),
  keyEpoch: integer("key_epoch").notNull().default(1),
  rotationFenced: integer("rotation_fenced", { mode: "boolean" })
    .notNull()
    .default(false),
  isDeleted: integer("is_deleted", { mode: "boolean" }).notNull().default(false),
  deletedAt: text("deleted_at"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`)
});

export const noteUpdates = sqliteTable("note_updates", {
  updateId: text("update_id").primaryKey(),
  noteId: text("note_id")
    .notNull()
    .references(() => notes.id, { onDelete: "cascade" }),
  cryptoOwnerId: text("crypto_owner_id").notNull(),
  keyEpoch: integer("key_epoch").notNull(),
  formatVersion: integer("format_version").notNull(),
  cipher: text("cipher").notNull(),
  nonce: text("nonce").notNull(),
  kind: text("kind").notNull().default("update"),
  compactedUpdateIds: text("compacted_update_ids"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`)
});

export const noteSections = sqliteTable(
  "note_sections",
  {
    id: text("id").primaryKey(),
    noteId: text("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    createdEpoch: integer("created_epoch").notNull(),
    currentSequence: integer("current_sequence").notNull().default(0),
    initializationManifestId: text("initialization_manifest_id"),
    isDeleted: integer("is_deleted", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`)
  },
  (table) => [index("idx_note_sections_note_deleted").on(table.noteId, table.isDeleted)]
);

export const sectionUpdates = sqliteTable(
  "section_updates",
  {
    updateId: text("update_id").primaryKey(),
    noteId: text("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    sectionId: text("section_id")
      .notNull()
      .references(() => noteSections.id, { onDelete: "cascade" }),
    serverSequence: integer("server_sequence").notNull(),
    cryptoOwnerId: text("crypto_owner_id").notNull(),
    keyEpoch: integer("key_epoch").notNull(),
    formatVersion: integer("format_version").notNull(),
    kind: text("kind").notNull(),
    inlineCipher: blob("inline_cipher", { mode: "buffer" }),
    nonce: blob("nonce", { mode: "buffer" }),
    checkpointSequenceCutoff: integer("checkpoint_sequence_cutoff"),
    manifestId: text("manifest_id"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`)
  },
  (table) => [
    uniqueIndex("idx_section_updates_sequence").on(
      table.noteId,
      table.sectionId,
      table.keyEpoch,
      table.serverSequence
    ),
    index("idx_section_updates_page").on(
      table.noteId,
      table.sectionId,
      table.keyEpoch,
      table.serverSequence
    )
  ]
);

export const contentUploads = sqliteTable(
  "content_uploads",
  {
    id: text("id").primaryKey(),
    updateId: text("update_id").notNull(),
    noteId: text("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    sectionId: text("section_id")
      .notNull()
      .references(() => noteSections.id, { onDelete: "cascade" }),
    cryptoOwnerId: text("crypto_owner_id").notNull(),
    keyEpoch: integer("key_epoch").notNull(),
    kind: text("kind").notNull(),
    formatVersion: integer("format_version").notNull(),
    totalCipherBytes: integer("total_cipher_bytes").notNull(),
    chunkCount: integer("chunk_count").notNull(),
    manifestHash: text("manifest_hash").notNull(),
    checkpointSequenceCutoff: integer("checkpoint_sequence_cutoff"),
    status: text("status").notNull(),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`)
  },
  (table) => [
    uniqueIndex("idx_content_uploads_update").on(table.updateId),
    index("idx_content_uploads_note_status").on(table.noteId, table.status),
    index("idx_content_uploads_expiry").on(table.status, table.expiresAt),
    check("content_uploads_positive_bytes", sql`${table.totalCipherBytes} > 0`),
    check("content_uploads_positive_chunks", sql`${table.chunkCount} > 0`)
  ]
);

export const contentChunks = sqliteTable(
  "content_chunks",
  {
    uploadId: text("upload_id")
      .notNull()
      .references(() => contentUploads.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    cipherLength: integer("cipher_length").notNull(),
    cipherHash: text("cipher_hash").notNull(),
    fileCipherPath: text("file_cipher_path").notNull(),
    nonce: blob("nonce", { mode: "buffer" }).notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`)
  },
  (table) => [
    primaryKey({ columns: [table.uploadId, table.chunkIndex] }),
    check("content_chunks_nonnegative_index", sql`${table.chunkIndex} >= 0`),
    check("content_chunks_positive_length", sql`${table.cipherLength} > 0`)
  ]
);

export const contentManifests = sqliteTable(
  "content_manifests",
  {
    id: text("id").primaryKey(),
    uploadId: text("upload_id")
      .notNull()
      .references(() => contentUploads.id, { onDelete: "restrict" }),
    updateId: text("update_id").notNull(),
    noteId: text("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    sectionId: text("section_id")
      .notNull()
      .references(() => noteSections.id, { onDelete: "cascade" }),
    keyEpoch: integer("key_epoch").notNull(),
    kind: text("kind").notNull(),
    formatVersion: integer("format_version").notNull(),
    firstSequence: integer("first_sequence").notNull(),
    lastSequence: integer("last_sequence").notNull(),
    totalCipherBytes: integer("total_cipher_bytes").notNull(),
    chunkCount: integer("chunk_count").notNull(),
    manifestHash: text("manifest_hash").notNull(),
    checkpointSequenceCutoff: integer("checkpoint_sequence_cutoff"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`)
  },
  (table) => [
    uniqueIndex("idx_content_manifests_upload").on(table.uploadId),
    uniqueIndex("idx_content_manifests_update").on(table.updateId),
    index("idx_content_manifests_page").on(
      table.noteId,
      table.sectionId,
      table.keyEpoch,
      table.lastSequence
    )
  ]
);

export const crdtInitializations = sqliteTable(
  "crdt_initializations",
  {
    noteId: text("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    sectionId: text("section_id")
      .notNull()
      .references(() => noteSections.id, { onDelete: "cascade" }),
    keyEpoch: integer("key_epoch").notNull(),
    manifestId: text("manifest_id")
      .notNull()
      .references(() => contentManifests.id, { onDelete: "restrict" }),
    legacyRootVersion: integer("legacy_root_version").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`)
  },
  (table) => [primaryKey({ columns: [table.noteId, table.sectionId, table.keyEpoch] })]
);

export const storageAccounts = sqliteTable(
  "storage_accounts",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    usedBytes: integer("used_bytes").notNull().default(0),
    reservedBytes: integer("reserved_bytes").notNull().default(0),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`)
  },
  (table) => [
    check("storage_accounts_used_nonnegative", sql`${table.usedBytes} >= 0`),
    check("storage_accounts_reserved_nonnegative", sql`${table.reservedBytes} >= 0`)
  ]
);

export const noteEpochLinks = sqliteTable(
  "note_epoch_links",
  {
    noteId: text("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    targetEpoch: integer("target_epoch").notNull(),
    sourceEpoch: integer("source_epoch").notNull(),
    previousKeyCipher: text("previous_key_cipher").notNull(),
    nonce: text("nonce").notNull(),
    formatVersion: integer("format_version").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`)
  },
  (table) => [
    primaryKey({ columns: [table.noteId, table.targetEpoch] }),
    check(
      "note_epoch_links_adjacent",
      sql`${table.targetEpoch} = ${table.sourceEpoch} + 1`
    )
  ]
);

export const attachments = sqliteTable("attachments", {
  id: text("id").primaryKey(),
  noteId: text("note_id")
    .notNull()
    .references(() => notes.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  metadataCipher: text("metadata_cipher"),
  metadataNonce: text("metadata_nonce"),
  metadataFormatVersion: integer("metadata_format_version"),
  keyEpoch: integer("key_epoch").notNull().default(1),
  size: integer("size").notNull(),
  encryptedAttachmentKey: text("encrypted_attachment_key").notNull(),
  attachmentKeyNonce: text("attachment_key_nonce").notNull(),
  storageKey: text("file_cipher_path").notNull(),
  fileNonce: text("file_nonce").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`)
});

export const userSharingKeys = sqliteTable(
  "user_sharing_keys",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sharingKeyVersion: integer("sharing_key_version").notNull(),
    publicKey: text("public_key").notNull(),
    encryptedPrivateKey: text("encrypted_private_key").notNull(),
    privateKeyNonce: text("private_key_nonce").notNull(),
    formatVersion: integer("format_version").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`)
  },
  (table) => [primaryKey({ columns: [table.userId, table.sharingKeyVersion] })]
);

export const noteMemberships = sqliteTable(
  "note_memberships",
  {
    noteId: text("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    status: text("status").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`)
  },
  (table) => [primaryKey({ columns: [table.noteId, table.userId] })]
);

export const noteKeyShares = sqliteTable(
  "note_key_shares",
  {
    noteId: text("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    recipientUserId: text("recipient_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    senderUserId: text("sender_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sharingKeyVersion: integer("sharing_key_version").notNull(),
    encryptedNoteKey: text("encrypted_note_key").notNull(),
    formatVersion: integer("format_version").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`)
  },
  (table) => [primaryKey({ columns: [table.noteId, table.recipientUserId] })]
);

export const noteEvents = sqliteTable("note_events", {
  cursor: integer("cursor").primaryKey({ autoIncrement: true }),
  eventId: text("event_id").notNull().unique(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id").notNull(),
  noteId: text("note_id"),
  actorUserId: text("actor_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  noteVersion: integer("note_version"),
  payloadMetadata: text("payload_metadata"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`)
});

export const eventAcknowledgements = sqliteTable(
  "event_acknowledgements",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    noteId: text("note_id").notNull(),
    cursor: integer("cursor").notNull(),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`)
  },
  (table) => [primaryKey({ columns: [table.userId, table.noteId] })]
);

export const eventCursors = sqliteTable("event_cursors", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  cursor: integer("cursor").notNull().default(0),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`)
});
