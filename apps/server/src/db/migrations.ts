import type Database from "better-sqlite3";
import { canonicalizeHandle } from "../auth/identity.js";

export function runMigrations(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT,
      canonical_handle TEXT,
      handle_state TEXT NOT NULL DEFAULT 'legacy',
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
      name_cipher TEXT,
      name_nonce TEXT,
      name_format_version INTEGER,
      parent_folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

	    CREATE TABLE IF NOT EXISTS notes (
	      id TEXT PRIMARY KEY,
	      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	      crypto_owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	      folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
	      title TEXT NOT NULL,
	      title_cipher TEXT,
	      title_nonce TEXT,
	      title_format_version INTEGER,
      encrypted_note_key TEXT NOT NULL,
      note_key_nonce TEXT NOT NULL,
      content_cipher TEXT NOT NULL,
      content_nonce TEXT NOT NULL,
      content_length INTEGER NOT NULL,
      content_updated_at TEXT NOT NULL,
	      version INTEGER NOT NULL DEFAULT 1,
	      root_version INTEGER NOT NULL DEFAULT 1,
	      root_section_id TEXT,
	      key_epoch INTEGER NOT NULL DEFAULT 1,
	      rotation_fenced INTEGER NOT NULL DEFAULT 0,
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
	      metadata_cipher TEXT,
	      metadata_nonce TEXT,
	      metadata_format_version INTEGER,
	      key_epoch INTEGER NOT NULL DEFAULT 1,
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

	    CREATE TABLE IF NOT EXISTS note_updates (
	      update_id TEXT PRIMARY KEY,
	      note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
	      crypto_owner_id TEXT NOT NULL,
	      key_epoch INTEGER NOT NULL,
	      format_version INTEGER NOT NULL,
	      cipher TEXT NOT NULL,
	      nonce TEXT NOT NULL,
	      kind TEXT NOT NULL DEFAULT 'update',
	      compacted_update_ids TEXT,
	      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
	    );

        CREATE TABLE IF NOT EXISTS note_sections (
          id TEXT PRIMARY KEY,
          note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
          created_epoch INTEGER NOT NULL,
          current_sequence INTEGER NOT NULL DEFAULT 0,
          initialization_manifest_id TEXT,
          is_deleted INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS section_updates (
          update_id TEXT PRIMARY KEY,
          note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
          section_id TEXT NOT NULL REFERENCES note_sections(id) ON DELETE CASCADE,
          server_sequence INTEGER NOT NULL,
          crypto_owner_id TEXT NOT NULL,
          key_epoch INTEGER NOT NULL,
          format_version INTEGER NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('update', 'checkpoint', 'root-update')),
          inline_cipher BLOB,
          nonce BLOB,
          manifest_id TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS content_uploads (
          id TEXT PRIMARY KEY,
          update_id TEXT NOT NULL UNIQUE,
          note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
          section_id TEXT NOT NULL REFERENCES note_sections(id) ON DELETE CASCADE,
          crypto_owner_id TEXT NOT NULL,
          key_epoch INTEGER NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('update', 'checkpoint', 'root-update')),
          format_version INTEGER NOT NULL,
          total_cipher_bytes INTEGER NOT NULL CHECK (total_cipher_bytes > 0),
          chunk_count INTEGER NOT NULL CHECK (chunk_count > 0),
          manifest_hash TEXT NOT NULL,
          checkpoint_sequence_cutoff INTEGER,
          status TEXT NOT NULL CHECK (
            status IN ('receiving', 'complete', 'committed', 'aborted', 'expired', 'invalid')
          ),
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS content_chunks (
          upload_id TEXT NOT NULL REFERENCES content_uploads(id) ON DELETE CASCADE,
          chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
          cipher_length INTEGER NOT NULL CHECK (cipher_length > 0),
          cipher_hash TEXT NOT NULL,
          file_cipher_path TEXT NOT NULL,
          nonce BLOB NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (upload_id, chunk_index)
        );

        CREATE TABLE IF NOT EXISTS content_manifests (
          id TEXT PRIMARY KEY,
          upload_id TEXT NOT NULL UNIQUE REFERENCES content_uploads(id) ON DELETE RESTRICT,
          update_id TEXT NOT NULL UNIQUE,
          note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
          section_id TEXT NOT NULL REFERENCES note_sections(id) ON DELETE CASCADE,
          key_epoch INTEGER NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('update', 'checkpoint', 'root-update')),
          format_version INTEGER NOT NULL,
          first_sequence INTEGER NOT NULL,
          last_sequence INTEGER NOT NULL,
          total_cipher_bytes INTEGER NOT NULL CHECK (total_cipher_bytes > 0),
          chunk_count INTEGER NOT NULL CHECK (chunk_count > 0),
          manifest_hash TEXT NOT NULL,
          checkpoint_sequence_cutoff INTEGER,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS crdt_initializations (
          note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
          section_id TEXT NOT NULL REFERENCES note_sections(id) ON DELETE CASCADE,
          key_epoch INTEGER NOT NULL,
          manifest_id TEXT NOT NULL REFERENCES content_manifests(id) ON DELETE RESTRICT,
          legacy_root_version INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (note_id, section_id, key_epoch)
        );

        CREATE TABLE IF NOT EXISTS storage_accounts (
          user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          used_bytes INTEGER NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
          reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS note_epoch_links (
          note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
          target_epoch INTEGER NOT NULL,
          source_epoch INTEGER NOT NULL,
          previous_key_cipher TEXT NOT NULL,
          nonce TEXT NOT NULL,
          format_version INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (note_id, target_epoch),
          CHECK (target_epoch = source_epoch + 1)
        );

	    CREATE TABLE IF NOT EXISTS event_acknowledgements (
	      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	      note_id TEXT NOT NULL,
	      cursor INTEGER NOT NULL,
	      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	      PRIMARY KEY (user_id, note_id)
	    );

	    CREATE TABLE IF NOT EXISTS event_cursors (
	      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
	      cursor INTEGER NOT NULL DEFAULT 0,
	      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
	    CREATE INDEX IF NOT EXISTS idx_note_updates_note_epoch_created
	      ON note_updates (note_id, key_epoch, created_at);
	    CREATE INDEX IF NOT EXISTS idx_note_sections_note_deleted
	      ON note_sections (note_id, is_deleted);
	    CREATE UNIQUE INDEX IF NOT EXISTS idx_section_updates_sequence
	      ON section_updates (note_id, section_id, key_epoch, server_sequence);
	    CREATE INDEX IF NOT EXISTS idx_section_updates_page
	      ON section_updates (note_id, section_id, key_epoch, server_sequence);
	    CREATE UNIQUE INDEX IF NOT EXISTS idx_content_uploads_update
	      ON content_uploads (update_id);
	    CREATE INDEX IF NOT EXISTS idx_content_uploads_note_status
	      ON content_uploads (note_id, status);
	    CREATE INDEX IF NOT EXISTS idx_content_uploads_expiry
	      ON content_uploads (status, expires_at);
	    CREATE UNIQUE INDEX IF NOT EXISTS idx_content_manifests_upload
	      ON content_manifests (upload_id);
	    CREATE UNIQUE INDEX IF NOT EXISTS idx_content_manifests_update
	      ON content_manifests (update_id);
	    CREATE INDEX IF NOT EXISTS idx_content_manifests_page
	      ON content_manifests (note_id, section_id, key_epoch, last_sequence);
	    CREATE INDEX IF NOT EXISTS idx_event_acknowledgements_user_cursor
	      ON event_acknowledgements (user_id, cursor);
	    CREATE INDEX IF NOT EXISTS idx_event_cursors_cursor
	      ON event_cursors (cursor);
	  `);

	addColumnIfMissing(sqlite, "users", "display_name", "TEXT");
	addColumnIfMissing(sqlite, "users", "canonical_handle", "TEXT");
	addColumnIfMissing(sqlite, "users", "handle_state", "TEXT NOT NULL DEFAULT 'legacy'");
	addColumnIfMissing(sqlite, "folders", "name_cipher", "TEXT");
	addColumnIfMissing(sqlite, "folders", "name_nonce", "TEXT");
	addColumnIfMissing(sqlite, "folders", "name_format_version", "INTEGER");
	addColumnIfMissing(sqlite, "notes", "crypto_owner_id", "TEXT");
	addColumnIfMissing(sqlite, "notes", "title_cipher", "TEXT");
	addColumnIfMissing(sqlite, "notes", "title_nonce", "TEXT");
	addColumnIfMissing(sqlite, "notes", "title_format_version", "INTEGER");
	addColumnIfMissing(sqlite, "notes", "root_version", "INTEGER NOT NULL DEFAULT 1");
	addColumnIfMissing(sqlite, "notes", "root_section_id", "TEXT");
	addColumnIfMissing(sqlite, "notes", "key_epoch", "INTEGER NOT NULL DEFAULT 1");
	addColumnIfMissing(sqlite, "notes", "rotation_fenced", "INTEGER NOT NULL DEFAULT 0");
	addColumnIfMissing(sqlite, "attachments", "metadata_cipher", "TEXT");
	addColumnIfMissing(sqlite, "attachments", "metadata_nonce", "TEXT");
	addColumnIfMissing(sqlite, "attachments", "metadata_format_version", "INTEGER");
	addColumnIfMissing(sqlite, "attachments", "key_epoch", "INTEGER NOT NULL DEFAULT 1");
		sqlite.exec(`
		  UPDATE users SET display_name = username WHERE display_name IS NULL;
		  UPDATE notes SET crypto_owner_id = user_id WHERE crypto_owner_id IS NULL;
	  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_canonical_handle
	    ON users (canonical_handle) WHERE canonical_handle IS NOT NULL;
		`);
  backfillCanonicalHandles(sqlite);
  removeNoteEventsNoteCascade(sqlite);
  backfillOwnerMemberships(sqlite);
  createFolderIntegrityTriggers(sqlite);
}

function backfillCanonicalHandles(sqlite: Database.Database): void {
  const rows = sqlite
    .prepare(
      "SELECT id, username, canonical_handle AS canonicalHandle FROM users"
    )
    .all() as { id: string; username: string; canonicalHandle: string | null }[];
  const claimed = new Map<string, string[]>();
  for (const row of rows) {
    const candidate = row.canonicalHandle ?? canonicalizeHandle(row.username);
    if (!candidate) {
      continue;
    }
    const ids = claimed.get(candidate) ?? [];
    ids.push(row.id);
    claimed.set(candidate, ids);
  }

  const activate = sqlite.prepare(
    "UPDATE users SET canonical_handle = ?, handle_state = 'active' WHERE id = ?"
  );
  const requireRepair = sqlite.prepare(
    "UPDATE users SET canonical_handle = NULL, handle_state = 'repair-required' WHERE id = ?"
  );
  sqlite.transaction(() => {
    for (const row of rows) {
      if (row.canonicalHandle) {
        continue;
      }
      const candidate = canonicalizeHandle(row.username);
      if (candidate && claimed.get(candidate)?.length === 1) {
        activate.run(candidate, row.id);
      } else {
        requireRepair.run(row.id);
      }
    }
  })();
}

function createFolderIntegrityTriggers(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TRIGGER IF NOT EXISTS folders_parent_owner_insert
    BEFORE INSERT ON folders
    WHEN NEW.parent_folder_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM folders AS parent
        WHERE parent.id = NEW.parent_folder_id AND parent.user_id = NEW.user_id
      )
    BEGIN
      SELECT RAISE(ABORT, 'invalid folder parent');
    END;

    CREATE TRIGGER IF NOT EXISTS folders_parent_owner_update
    BEFORE UPDATE OF parent_folder_id, user_id ON folders
    WHEN NEW.parent_folder_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM folders AS parent
        WHERE parent.id = NEW.parent_folder_id AND parent.user_id = NEW.user_id
      )
    BEGIN
      SELECT RAISE(ABORT, 'invalid folder parent');
    END;

    CREATE TRIGGER IF NOT EXISTS notes_folder_owner_insert
    BEFORE INSERT ON notes
    WHEN NEW.folder_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM folders
        WHERE folders.id = NEW.folder_id AND folders.user_id = NEW.user_id
      )
    BEGIN
      SELECT RAISE(ABORT, 'invalid note folder');
    END;

    CREATE TRIGGER IF NOT EXISTS notes_folder_owner_update
    BEFORE UPDATE OF folder_id, user_id ON notes
    WHEN NEW.folder_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM folders
        WHERE folders.id = NEW.folder_id AND folders.user_id = NEW.user_id
      )
    BEGIN
      SELECT RAISE(ABORT, 'invalid note folder');
    END;

    DROP TRIGGER IF EXISTS folders_reparent_after_delete;
    CREATE TRIGGER folders_reparent_after_delete
    BEFORE DELETE ON folders
    BEGIN
      UPDATE notes
      SET folder_id = OLD.parent_folder_id, updated_at = CURRENT_TIMESTAMP
      WHERE folder_id = OLD.id AND user_id = OLD.user_id;
      UPDATE folders
      SET parent_folder_id = OLD.parent_folder_id, updated_at = CURRENT_TIMESTAMP
      WHERE parent_folder_id = OLD.id AND user_id = OLD.user_id;
    END;
  `);
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
