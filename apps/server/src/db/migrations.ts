import type Database from "better-sqlite3";

export function runMigrations(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      auth_verifier_hash TEXT NOT NULL,
      auth_kdf_salt TEXT NOT NULL,
      auth_kdf_ops_limit INTEGER NOT NULL,
      auth_kdf_mem_limit INTEGER NOT NULL,
      auth_kdf_version INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_hash TEXT NOT NULL UNIQUE,
      idle_expires_at TEXT NOT NULL,
      absolute_expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS user_key_material (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      encrypted_root_key TEXT NOT NULL,
      root_key_nonce TEXT NOT NULL,
      kdf_salt TEXT NOT NULL,
      kdf_ops_limit INTEGER NOT NULL,
      kdf_mem_limit INTEGER NOT NULL,
      kdf_version INTEGER NOT NULL,
      recovery_encrypted_root_key TEXT NOT NULL,
      recovery_root_key_nonce TEXT NOT NULL,
      recovery_auth_verifier_hash TEXT NOT NULL,
      recovery_kdf_salt TEXT NOT NULL,
      recovery_kdf_ops_limit INTEGER NOT NULL,
      recovery_kdf_mem_limit INTEGER NOT NULL,
      recovery_kdf_version INTEGER NOT NULL,
      key_material_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      parent_folder_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      folder_id TEXT,
      title TEXT NOT NULL,
      encrypted_note_key TEXT NOT NULL,
      note_key_nonce TEXT NOT NULL,
      content_cipher TEXT NOT NULL,
      content_nonce TEXT NOT NULL,
      content_length INTEGER NOT NULL,
      content_updated_at TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      encrypted_attachment_key TEXT NOT NULL,
      attachment_key_nonce TEXT NOT NULL,
      file_cipher_path TEXT NOT NULL,
      file_nonce TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
