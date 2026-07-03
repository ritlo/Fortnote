import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "./migrations.js";

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
    expect(indexes.some((index) => index.name === "idx_event_acknowledgements_user_cursor")).toBe(
      true
    );
  });
});
