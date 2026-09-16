import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer }>({
  dataType: () => "bytea"
});
const dateTime = (name: string) =>
  timestamp(name, { mode: "string", withTimezone: true });
const byteCount = (name: string) => bigint(name, { mode: "number" });

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    username: text("username").notNull().unique(),
    displayName: text("display_name"),
    canonicalHandle: text("canonical_handle"),
    authVerifierHash: text("auth_verifier_hash").notNull(),
    authKdfSalt: text("auth_kdf_salt").notNull(),
    authKdfOpsLimit: integer("auth_kdf_ops_limit").notNull(),
    authKdfMemLimit: integer("auth_kdf_mem_limit").notNull(),
    authKdfVersion: integer("auth_kdf_version").notNull(),
    createdAt: dateTime("created_at").notNull().defaultNow(),
    updatedAt: dateTime("updated_at").notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("idx_users_canonical_handle")
      .on(table.canonicalHandle)
      .where(sql`${table.canonicalHandle} IS NOT NULL`)
  ]
);

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  sessionHash: text("session_hash").notNull().unique(),
  idleExpiresAt: dateTime("idle_expires_at").notNull(),
  absoluteExpiresAt: dateTime("absolute_expires_at").notNull(),
  createdAt: dateTime("created_at").notNull().defaultNow(),
  lastSeenAt: dateTime("last_seen_at").notNull().defaultNow()
});

export const userKeyMaterial = pgTable("user_key_material", {
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
  createdAt: dateTime("created_at").notNull().defaultNow(),
  updatedAt: dateTime("updated_at").notNull().defaultNow()
});

export const folders = pgTable("folders", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  nameCipher: text("name_cipher").notNull(),
  nameNonce: text("name_nonce").notNull(),
  nameFormatVersion: integer("name_format_version").notNull().default(2),
  parentFolderId: text("parent_folder_id").references((): AnyPgColumn => folders.id, {
    onDelete: "set null"
  }),
  createdAt: dateTime("created_at").notNull().defaultNow(),
  updatedAt: dateTime("updated_at").notNull().defaultNow()
});

export const notes = pgTable("notes", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  cryptoOwnerId: text("crypto_owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  folderId: text("folder_id").references(() => folders.id, { onDelete: "set null" }),
  titleCipher: text("title_cipher").notNull(),
  titleNonce: text("title_nonce").notNull(),
  titleFormatVersion: integer("title_format_version").notNull().default(2),
  encryptedNoteKey: text("encrypted_note_key").notNull(),
  noteKeyNonce: text("note_key_nonce").notNull(),
  noteKeyFormatVersion: integer("note_key_format_version").notNull().default(2),
  version: integer("version").notNull().default(1),
  rootVersion: integer("root_version").notNull().default(1),
  rootSectionId: text("root_section_id").notNull(),
  keyEpoch: integer("key_epoch").notNull().default(1),
  rotationFenced: boolean("rotation_fenced").notNull().default(false),
  isDeleted: boolean("is_deleted").notNull().default(false),
  deletedAt: dateTime("deleted_at"),
  createdAt: dateTime("created_at").notNull().defaultNow(),
  updatedAt: dateTime("updated_at").notNull().defaultNow()
});

export const noteSections = pgTable(
  "note_sections",
  {
    id: text("id").primaryKey(),
    noteId: text("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    createdEpoch: integer("created_epoch").notNull(),
    currentSequence: integer("current_sequence").notNull().default(0),
    initializationManifestId: text("initialization_manifest_id"),
    isDeleted: boolean("is_deleted").notNull().default(false),
    createdAt: dateTime("created_at").notNull().defaultNow(),
    updatedAt: dateTime("updated_at").notNull().defaultNow()
  },
  (table) => [index("idx_note_sections_note_deleted").on(table.noteId, table.isDeleted)]
);

export const sectionUpdates = pgTable(
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
    inlineCipher: bytea("inline_cipher"),
    nonce: bytea("nonce"),
    checkpointSequenceCutoff: integer("checkpoint_sequence_cutoff"),
    manifestId: text("manifest_id"),
    createdAt: dateTime("created_at").notNull().defaultNow()
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
    ),
    check(
      "section_updates_kind",
      sql`${table.kind} IN ('update', 'checkpoint', 'root-update')`
    )
  ]
);

export const contentUploads = pgTable(
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
    totalCipherBytes: byteCount("total_cipher_bytes").notNull(),
    chunkCount: integer("chunk_count").notNull(),
    manifestHash: text("manifest_hash").notNull(),
    checkpointSequenceCutoff: integer("checkpoint_sequence_cutoff"),
    status: text("status").notNull(),
    expiresAt: dateTime("expires_at").notNull(),
    createdAt: dateTime("created_at").notNull().defaultNow(),
    updatedAt: dateTime("updated_at").notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("idx_content_uploads_update").on(table.updateId),
    index("idx_content_uploads_note_status").on(table.noteId, table.status),
    index("idx_content_uploads_expiry").on(table.status, table.expiresAt),
    check("content_uploads_positive_bytes", sql`${table.totalCipherBytes} > 0`),
    check("content_uploads_positive_chunks", sql`${table.chunkCount} > 0`),
    check(
      "content_uploads_kind",
      sql`${table.kind} IN ('update', 'checkpoint', 'root-update')`
    ),
    check(
      "content_uploads_status",
      sql`${table.status} IN ('receiving', 'complete', 'committed', 'aborted', 'expired', 'invalid')`
    )
  ]
);

export const contentChunks = pgTable(
  "content_chunks",
  {
    uploadId: text("upload_id")
      .notNull()
      .references(() => contentUploads.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    cipherLength: integer("cipher_length").notNull(),
    cipherHash: text("cipher_hash").notNull(),
    storageKey: text("file_cipher_path").notNull(),
    nonce: bytea("nonce").notNull(),
    createdAt: dateTime("created_at").notNull().defaultNow()
  },
  (table) => [
    primaryKey({ columns: [table.uploadId, table.chunkIndex] }),
    check("content_chunks_nonnegative_index", sql`${table.chunkIndex} >= 0`),
    check("content_chunks_positive_length", sql`${table.cipherLength} > 0`)
  ]
);

export const contentManifests = pgTable(
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
    totalCipherBytes: byteCount("total_cipher_bytes").notNull(),
    chunkCount: integer("chunk_count").notNull(),
    manifestHash: text("manifest_hash").notNull(),
    checkpointSequenceCutoff: integer("checkpoint_sequence_cutoff"),
    createdAt: dateTime("created_at").notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("idx_content_manifests_upload").on(table.uploadId),
    uniqueIndex("idx_content_manifests_update").on(table.updateId),
    index("idx_content_manifests_page").on(
      table.noteId,
      table.sectionId,
      table.keyEpoch,
      table.lastSequence
    ),
    check(
      "content_manifests_kind",
      sql`${table.kind} IN ('update', 'checkpoint', 'root-update')`
    ),
    check("content_manifests_positive_bytes", sql`${table.totalCipherBytes} > 0`),
    check("content_manifests_positive_chunks", sql`${table.chunkCount} > 0`)
  ]
);

export const crdtInitializations = pgTable(
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
    rootVersion: integer("root_version").notNull(),
    createdAt: dateTime("created_at").notNull().defaultNow()
  },
  (table) => [primaryKey({ columns: [table.noteId, table.sectionId, table.keyEpoch] })]
);

export const storageAccounts = pgTable(
  "storage_accounts",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    usedBytes: byteCount("used_bytes").notNull().default(0),
    reservedBytes: byteCount("reserved_bytes").notNull().default(0),
    updatedAt: dateTime("updated_at").notNull().defaultNow()
  },
  (table) => [
    check("storage_accounts_used_nonnegative", sql`${table.usedBytes} >= 0`),
    check("storage_accounts_reserved_nonnegative", sql`${table.reservedBytes} >= 0`)
  ]
);

export const noteEpochLinks = pgTable(
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
    createdAt: dateTime("created_at").notNull().defaultNow()
  },
  (table) => [
    primaryKey({ columns: [table.noteId, table.targetEpoch] }),
    check(
      "note_epoch_links_adjacent",
      sql`${table.targetEpoch} = ${table.sourceEpoch} + 1`
    )
  ]
);

export const attachmentObjects = pgTable(
  "attachment_objects",
  {
    storageKey: uuid("storage_key").primaryKey(),
    byteLength: byteCount("byte_length").notNull(),
    createdAt: dateTime("created_at").notNull().defaultNow()
  },
  (table) => [
    check("attachment_objects_nonnegative_length", sql`${table.byteLength} >= 0`)
  ]
);

export const attachmentObjectChunks = pgTable(
  "attachment_object_chunks",
  {
    storageKey: uuid("storage_key")
      .notNull()
      .references(() => attachmentObjects.storageKey, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    ciphertext: bytea("ciphertext").notNull()
  },
  (table) => [
    primaryKey({ columns: [table.storageKey, table.chunkIndex] }),
    check("attachment_object_chunks_nonnegative_index", sql`${table.chunkIndex} >= 0`),
    check(
      "attachment_object_chunks_nonempty_ciphertext",
      sql`octet_length(${table.ciphertext}) > 0`
    )
  ]
);

export const attachments = pgTable("attachments", {
  id: text("id").primaryKey(),
  noteId: text("note_id")
    .notNull()
    .references(() => notes.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  metadataCipher: text("metadata_cipher").notNull(),
  metadataNonce: text("metadata_nonce").notNull(),
  metadataFormatVersion: integer("metadata_format_version").notNull().default(2),
  keyEpoch: integer("key_epoch").notNull().default(1),
  size: byteCount("size").notNull(),
  encryptedAttachmentKey: text("encrypted_attachment_key").notNull(),
  attachmentKeyNonce: text("attachment_key_nonce").notNull(),
  storageKey: uuid("storage_key")
    .notNull()
    .references(() => attachmentObjects.storageKey, { onDelete: "restrict" }),
  fileNonce: text("file_nonce").notNull(),
  createdAt: dateTime("created_at").notNull().defaultNow()
});

export const userSharingKeys = pgTable(
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
    createdAt: dateTime("created_at").notNull().defaultNow(),
    updatedAt: dateTime("updated_at").notNull().defaultNow()
  },
  (table) => [primaryKey({ columns: [table.userId, table.sharingKeyVersion] })]
);

export const noteMemberships = pgTable(
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
    createdAt: dateTime("created_at").notNull().defaultNow(),
    updatedAt: dateTime("updated_at").notNull().defaultNow()
  },
  (table) => [
    primaryKey({ columns: [table.noteId, table.userId] }),
    index("idx_note_memberships_user_status").on(table.userId, table.status),
    index("idx_note_memberships_note").on(table.noteId),
    check("note_memberships_role", sql`${table.role} IN ('owner', 'editor', 'viewer')`),
    check(
      "note_memberships_status",
      sql`${table.status} IN ('active', 'invited', 'revoked')`
    )
  ]
);

export const noteKeyShares = pgTable(
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
    createdAt: dateTime("created_at").notNull().defaultNow()
  },
  (table) => [
    primaryKey({ columns: [table.noteId, table.recipientUserId] }),
    index("idx_note_key_shares_recipient").on(table.recipientUserId)
  ]
);

export const noteEvents = pgTable(
  "note_events",
  {
    cursor: bigserial("cursor", { mode: "number" }).primaryKey(),
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
    createdAt: dateTime("created_at").notNull().defaultNow()
  },
  (table) => [
    index("idx_note_events_note_cursor").on(table.noteId, table.cursor),
    index("idx_note_events_resource_cursor").on(
      table.resourceType,
      table.resourceId,
      table.cursor
    )
  ]
);

export const eventAcknowledgements = pgTable(
  "event_acknowledgements",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    noteId: text("note_id").notNull(),
    cursor: byteCount("cursor").notNull(),
    updatedAt: dateTime("updated_at").notNull().defaultNow()
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.noteId] }),
    index("idx_event_acknowledgements_user_cursor").on(table.userId, table.cursor)
  ]
);

export const eventCursors = pgTable(
  "event_cursors",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    cursor: byteCount("cursor").notNull().default(0),
    updatedAt: dateTime("updated_at").notNull().defaultNow()
  },
  (table) => [index("idx_event_cursors_cursor").on(table.cursor)]
);
