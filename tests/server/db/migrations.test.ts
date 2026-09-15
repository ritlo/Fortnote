import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "@server/db/migrations.js";

describe("database migrations", () => {
  it("backfills owner memberships and crypto owner IDs for existing notes", () => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    sqlite.exec(`
      CREATE TABLE users (
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

      CREATE TABLE notes (
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
    `);
    sqlite
      .prepare(
        `INSERT INTO users (
          id,
          username,
          auth_verifier_hash,
          auth_kdf_salt,
          auth_kdf_ops_limit,
          auth_kdf_mem_limit,
          auth_kdf_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run("user-1", "existing", "hash", "salt", 1, 1, 1);
    sqlite
      .prepare(
        `INSERT INTO notes (
          id,
          user_id,
          title,
          encrypted_note_key,
          note_key_nonce,
          content_cipher,
          content_nonce,
          content_length,
          content_updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
      )
      .run(
        "note-1",
        "user-1",
        "Existing",
        "encrypted-note-key",
        "note-key-nonce",
        "cipher",
        "content-nonce",
        100
      );

    runMigrations(sqlite);

    const note = sqlite
      .prepare("SELECT crypto_owner_id AS cryptoOwnerId FROM notes WHERE id = ?")
      .get("note-1") as { cryptoOwnerId: string };
    expect(note.cryptoOwnerId).toBe("user-1");

    const membership = sqlite
      .prepare(
        `SELECT role, status
         FROM note_memberships
         WHERE note_id = ? AND user_id = ?`
      )
      .get("note-1", "user-1") as { role: string; status: string };
    expect(membership).toEqual({ role: "owner", status: "active" });
  });

  it("keeps note events after removing legacy note cascades", () => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    sqlite.exec(`
      CREATE TABLE users (
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

      CREATE TABLE notes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        crypto_owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
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

      CREATE TABLE note_events (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        note_id TEXT REFERENCES notes(id) ON DELETE CASCADE,
        actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        note_version INTEGER,
        payload_metadata TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    sqlite
      .prepare(
        `INSERT INTO users (
          id,
          username,
          auth_verifier_hash,
          auth_kdf_salt,
          auth_kdf_ops_limit,
          auth_kdf_mem_limit,
          auth_kdf_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run("user-1", "existing", "hash", "salt", 1, 1, 1);
    sqlite
      .prepare(
        `INSERT INTO notes (
          id,
          user_id,
          crypto_owner_id,
          title,
          encrypted_note_key,
          note_key_nonce,
          content_cipher,
          content_nonce,
          content_length,
          content_updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
      )
      .run(
        "note-1",
        "user-1",
        "user-1",
        "Existing",
        "encrypted-note-key",
        "note-key-nonce",
        "cipher",
        "content-nonce",
        100
      );
    sqlite
      .prepare(
        `INSERT INTO note_events (
          event_id,
          resource_type,
          resource_id,
          note_id,
          actor_user_id,
          event_type,
          note_version
        ) VALUES (?, 'note', ?, ?, ?, 'note.created', 1)`
      )
      .run("event-1", "note-1", "note-1", "user-1");

    runMigrations(sqlite);

    const noteEventForeignKeys = sqlite
      .prepare("PRAGMA foreign_key_list(note_events)")
      .all() as { table: string; from: string }[];
    expect(
      noteEventForeignKeys.some(
        (foreignKey) => foreignKey.table === "notes" && foreignKey.from === "note_id"
      )
    ).toBe(false);

    sqlite.prepare("DELETE FROM notes WHERE id = ?").run("note-1");
    const event = sqlite
      .prepare("SELECT event_type AS eventType FROM note_events WHERE event_id = ?")
      .get("event-1") as { eventType: string } | undefined;
    expect(event).toEqual({ eventType: "note.created" });
  });

  it("creates event acknowledgement storage idempotently", () => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");

    runMigrations(sqlite);
    runMigrations(sqlite);

    const columns = sqlite.prepare("PRAGMA table_info(event_acknowledgements)").all() as {
      name: string;
    }[];
    expect(columns.map((column) => column.name)).toEqual([
      "user_id",
      "note_id",
      "cursor",
      "updated_at"
    ]);

    const indexes = sqlite.prepare("PRAGMA index_list(event_acknowledgements)").all() as {
      name: string;
    }[];
    expect(
      indexes.some((index) => index.name === "idx_event_acknowledgements_user_cursor")
    ).toBe(true);

    const cursorColumns = sqlite.prepare("PRAGMA table_info(event_cursors)").all() as {
      name: string;
    }[];
    expect(cursorColumns.map((column) => column.name)).toEqual([
      "user_id",
      "cursor",
      "updated_at"
    ]);

    const cursorIndexes = sqlite.prepare("PRAGMA index_list(event_cursors)").all() as {
      name: string;
    }[];
    expect(cursorIndexes.some((index) => index.name === "idx_event_cursors_cursor")).toBe(
      true
    );
  });

  it("adds the protected section, content, quota, identity, and epoch model idempotently", () => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");

    runMigrations(sqlite);
    runMigrations(sqlite);

    const tables = new Set(
      (
        sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string;
        }[]
      ).map(({ name }) => name)
    );
    expect(tables).toEqual(
      expect.objectContaining({
        has: expect.any(Function)
      })
    );
    for (const table of [
      "note_sections",
      "section_updates",
      "crdt_initializations",
      "content_uploads",
      "content_chunks",
      "content_manifests",
      "storage_accounts",
      "note_epoch_links"
    ]) {
      expect(tables.has(table), table).toBe(true);
    }

    expect(columnNames(sqlite, "users")).toEqual(
      expect.arrayContaining(["display_name", "canonical_handle", "handle_state"])
    );
    expect(columnNames(sqlite, "notes")).toEqual(
      expect.arrayContaining([
        "title_cipher",
        "title_nonce",
        "title_format_version",
        "root_section_id",
        "root_version",
        "rotation_fenced"
      ])
    );
    expect(columnNames(sqlite, "folders")).toEqual(
      expect.arrayContaining(["name_cipher", "name_nonce", "name_format_version"])
    );
    expect(columnNames(sqlite, "attachments")).toEqual(
      expect.arrayContaining([
        "metadata_cipher",
        "metadata_nonce",
        "metadata_format_version",
        "key_epoch"
      ])
    );

    const sectionIndexes = sqlite.prepare("PRAGMA index_list(section_updates)").all() as {
      name: string;
      unique: number;
    }[];
    expect(
      sectionIndexes.some(
        ({ name, unique }) => name === "idx_section_updates_sequence" && unique === 1
      )
    ).toBe(true);
  });

  it("preserves legacy note data and rolls back an invalid content transaction", () => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    runMigrations(sqlite);
    sqlite
      .prepare(
        `INSERT INTO users (
          id, username, auth_verifier_hash, auth_kdf_salt,
          auth_kdf_ops_limit, auth_kdf_mem_limit, auth_kdf_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run("user-1", "Legacy User", "hash", "salt", 1, 1, 1);
    sqlite
      .prepare(
        `INSERT INTO notes (
          id, user_id, crypto_owner_id, title, encrypted_note_key, note_key_nonce,
          content_cipher, content_nonce, content_length, content_updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
      )
      .run(
        "note-1",
        "user-1",
        "user-1",
        "Legacy title",
        "wrapped-key",
        "key-nonce",
        "legacy-cipher",
        "content-nonce",
        42
      );

    runMigrations(sqlite);

    expect(
      sqlite
        .prepare("SELECT title, content_cipher AS contentCipher FROM notes WHERE id = ?")
        .get("note-1")
    ).toEqual({ title: "Legacy title", contentCipher: "legacy-cipher" });

    const writeInvalidUpload = sqlite.transaction(() => {
      sqlite
        .prepare(
          `INSERT INTO content_uploads (
            id, update_id, note_id, section_id, crypto_owner_id, key_epoch, kind,
            format_version, total_cipher_bytes, chunk_count, manifest_hash, status,
            expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          "upload-1",
          "update-1",
          "note-1",
          "missing-section",
          "user-1",
          1,
          "update",
          2,
          10,
          1,
          "digest",
          "receiving",
          new Date(Date.now() + 60_000).toISOString()
        );
    });
    expect(writeInvalidUpload).toThrow();
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM content_uploads").get()).toEqual(
      { count: 0 }
    );
  });
});

function columnNames(sqlite: Database.Database, table: string): string[] {
  return (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    ({ name }) => name
  );
}
