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
	      crypto_owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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

	    CREATE TABLE IF NOT EXISTS user_sharing_keys (
	      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	      sharing_key_version INTEGER NOT NULL,
	      public_key TEXT NOT NULL,
	      encrypted_private_key TEXT NOT NULL,
	      private_key_nonce TEXT NOT NULL,
	      format_version INTEGER NOT NULL,
	      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	      PRIMARY KEY (user_id, sharing_key_version)
	    );

	    CREATE TABLE IF NOT EXISTS note_memberships (
	      note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
	      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	      role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
	      status TEXT NOT NULL CHECK (status IN ('active', 'invited', 'revoked')),
	      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	      PRIMARY KEY (note_id, user_id)
	    );

	    CREATE TABLE IF NOT EXISTS note_key_shares (
	      note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
	      recipient_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	      sender_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	      sharing_key_version INTEGER NOT NULL,
	      encrypted_note_key TEXT NOT NULL,
	      format_version INTEGER NOT NULL,
	      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	      PRIMARY KEY (note_id, recipient_user_id)
	    );

	    CREATE TABLE IF NOT EXISTS note_events (
	      cursor INTEGER PRIMARY KEY AUTOINCREMENT,
	      event_id TEXT NOT NULL UNIQUE,
	      resource_type TEXT NOT NULL,
	      resource_id TEXT NOT NULL,
	      note_id TEXT,
	      actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	      event_type TEXT NOT NULL,
	      note_version INTEGER,
	      payload_metadata TEXT,
	      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
	    );

	    CREATE TABLE IF NOT EXISTS event_acknowledgements (
	      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	      note_id TEXT NOT NULL,
	      cursor INTEGER NOT NULL,
	      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	      PRIMARY KEY (user_id, note_id)
	    );

	    CREATE INDEX IF NOT EXISTS idx_note_memberships_user_status
	      ON note_memberships (user_id, status);
	    CREATE INDEX IF NOT EXISTS idx_note_memberships_note
	      ON note_memberships (note_id);
	    CREATE INDEX IF NOT EXISTS idx_note_key_shares_recipient
	      ON note_key_shares (recipient_user_id);
	    CREATE INDEX IF NOT EXISTS idx_note_events_note_cursor
	      ON note_events (note_id, cursor);
	    CREATE INDEX IF NOT EXISTS idx_note_events_resource_cursor
	      ON note_events (resource_type, resource_id, cursor);
	    CREATE INDEX IF NOT EXISTS idx_event_acknowledgements_user_cursor
	      ON event_acknowledgements (user_id, cursor);
	  `);

  addColumnIfMissing(sqlite, "notes", "crypto_owner_id", "TEXT");
  sqlite.exec("UPDATE notes SET crypto_owner_id = user_id WHERE crypto_owner_id IS NULL");
  removeNoteEventsNoteCascade(sqlite);
  backfillOwnerMemberships(sqlite);
}

function addColumnIfMissing(
  sqlite: Database.Database,
  table: string,
  column: string,
  definition: string
): void {
  const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  if (columns.some((existingColumn) => existingColumn.name === column)) {
    return;
  }

  sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function backfillOwnerMemberships(sqlite: Database.Database): void {
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO note_memberships (
        note_id,
        user_id,
        role,
        status,
        created_at,
        updated_at
      )
      SELECT id, user_id, 'owner', 'active', created_at, updated_at
      FROM notes`
	    )
	    .run();
}

function removeNoteEventsNoteCascade(sqlite: Database.Database): void {
  const foreignKeys = sqlite.prepare("PRAGMA foreign_key_list(note_events)").all() as {
    table: string;
    from: string;
  }[];
  const hasNoteCascade = foreignKeys.some(
    (foreignKey) => foreignKey.table === "notes" && foreignKey.from === "note_id"
  );
  if (!hasNoteCascade) {
    return;
  }

  sqlite.pragma("foreign_keys = OFF");
  try {
    sqlite.exec(`
      ALTER TABLE note_events RENAME TO note_events_old;

      CREATE TABLE note_events (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        note_id TEXT,
        actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        note_version INTEGER,
        payload_metadata TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      INSERT INTO note_events (
        cursor,
        event_id,
        resource_type,
        resource_id,
        note_id,
        actor_user_id,
        event_type,
        note_version,
        payload_metadata,
        created_at
      )
      SELECT cursor,
             event_id,
             resource_type,
             resource_id,
             note_id,
             actor_user_id,
             event_type,
             note_version,
             payload_metadata,
             created_at
      FROM note_events_old;

      DROP TABLE note_events_old;

      CREATE INDEX IF NOT EXISTS idx_note_events_note_cursor
        ON note_events (note_id, cursor);
      CREATE INDEX IF NOT EXISTS idx_note_events_resource_cursor
        ON note_events (resource_type, resource_id, cursor);
    `);
  } finally {
    sqlite.pragma("foreign_keys = ON");
  }
}
