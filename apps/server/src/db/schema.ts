import { sql } from "drizzle-orm";
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  authVerifierHash: text("auth_verifier_hash").notNull(),
  authKdfSalt: text("auth_kdf_salt").notNull(),
  authKdfOpsLimit: integer("auth_kdf_ops_limit").notNull(),
  authKdfMemLimit: integer("auth_kdf_mem_limit").notNull(),
  authKdfVersion: integer("auth_kdf_version").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`)
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  sessionHash: text("session_hash").notNull().unique(),
  idleExpiresAt: text("idle_expires_at").notNull(),
  absoluteExpiresAt: text("absolute_expires_at").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  lastSeenAt: text("last_seen_at").notNull().default(sql`CURRENT_TIMESTAMP`)
});

export const userKeyMaterial = sqliteTable("user_key_material", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  encryptedRootKey: text("encrypted_root_key").notNull(),
  rootKeyNonce: text("root_key_nonce").notNull(),
  kdfSalt: text("kdf_salt").notNull(),
  kdfOpsLimit: integer("kdf_ops_limit").notNull(),
  kdfMemLimit: integer("kdf_mem_limit").notNull(),
  kdfVersion: integer("kdf_version").notNull(),
  recoveryEncryptedRootKey: text("recovery_encrypted_root_key").notNull(),
  recoveryRootKeyNonce: text("recovery_root_key_nonce").notNull(),
  recoveryAuthVerifierHash: text("recovery_auth_verifier_hash").notNull(),
  recoveryKdfSalt: text("recovery_kdf_salt").notNull(),
  recoveryKdfOpsLimit: integer("recovery_kdf_ops_limit").notNull(),
  recoveryKdfMemLimit: integer("recovery_kdf_mem_limit").notNull(),
  recoveryKdfVersion: integer("recovery_kdf_version").notNull(),
  keyMaterialVersion: integer("key_material_version").notNull().default(1),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`)
});

export const folders = sqliteTable("folders", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  parentFolderId: text("parent_folder_id"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`)
});

export const notes = sqliteTable("notes", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  cryptoOwnerId: text("crypto_owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  folderId: text("folder_id"),
  title: text("title").notNull(),
  encryptedNoteKey: text("encrypted_note_key").notNull(),
  noteKeyNonce: text("note_key_nonce").notNull(),
  contentCipher: text("content_cipher").notNull(),
  contentNonce: text("content_nonce").notNull(),
  contentLength: integer("content_length").notNull(),
  contentUpdatedAt: text("content_updated_at").notNull(),
  version: integer("version").notNull().default(1),
  isDeleted: integer("is_deleted", { mode: "boolean" }).notNull().default(false),
  deletedAt: text("deleted_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`)
});

export const attachments = sqliteTable("attachments", {
  id: text("id").primaryKey(),
  noteId: text("note_id").notNull().references(() => notes.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  size: integer("size").notNull(),
  encryptedAttachmentKey: text("encrypted_attachment_key").notNull(),
  attachmentKeyNonce: text("attachment_key_nonce").notNull(),
  fileCipherPath: text("file_cipher_path").notNull(),
  fileNonce: text("file_nonce").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`)
});

export const userSharingKeys = sqliteTable(
  "user_sharing_keys",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    sharingKeyVersion: integer("sharing_key_version").notNull(),
    publicKey: text("public_key").notNull(),
    encryptedPrivateKey: text("encrypted_private_key").notNull(),
    privateKeyNonce: text("private_key_nonce").notNull(),
    formatVersion: integer("format_version").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`)
  },
  (table) => [primaryKey({ columns: [table.userId, table.sharingKeyVersion] })]
);

export const noteMemberships = sqliteTable(
  "note_memberships",
  {
    noteId: text("note_id").notNull().references(() => notes.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`)
  },
  (table) => [primaryKey({ columns: [table.noteId, table.userId] })]
);

export const noteKeyShares = sqliteTable(
  "note_key_shares",
  {
    noteId: text("note_id").notNull().references(() => notes.id, { onDelete: "cascade" }),
    recipientUserId: text("recipient_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    senderUserId: text("sender_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sharingKeyVersion: integer("sharing_key_version").notNull(),
    encryptedNoteKey: text("encrypted_note_key").notNull(),
    formatVersion: integer("format_version").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`)
  },
  (table) => [primaryKey({ columns: [table.noteId, table.recipientUserId] })]
);

export const noteEvents = sqliteTable("note_events", {
  cursor: integer("cursor").primaryKey({ autoIncrement: true }),
  eventId: text("event_id").notNull().unique(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id").notNull(),
  noteId: text("note_id").references(() => notes.id, { onDelete: "cascade" }),
  actorUserId: text("actor_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  noteVersion: integer("note_version"),
  payloadMetadata: text("payload_metadata"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`)
});
