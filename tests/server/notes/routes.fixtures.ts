import type { AppDb } from "@server/db/client.js";
import { createTestApp } from "../support/http.js";

type TestApp = ReturnType<typeof createTestApp>;

function appDb(app: TestApp): AppDb {
  return (app.locals as { db: AppDb }).db;
}

export function sharingKeyPayload(version = 1) {
  return {
    sharingKeyVersion: version,
    publicKey: `public_sharing_key_${String(version)}_abcdefghijklmnopqrstuvwxyz`,
    encryptedPrivateKey: `encrypted_private_key_${String(version)}_abcdefghijklmnopqrstuvwxyz`,
    privateKeyNonce: `private_key_nonce_${String(version)}_abcdefghijklmnopqrstuvwxyz`,
    formatVersion: 1
  };
}

export function protectedNotePayload() {
  return {
    id: crypto.randomUUID(),
    rootSectionId: crypto.randomUUID(),
    titleCipher: "encrypted_title_cipher_abcdefghijklmnopqrstuvwxyz",
    titleNonce: "encrypted_title_nonce_abcdefghijklmnopqrstuvwxyz",
    titleFormatVersion: 2,
    encryptedNoteKey: "encrypted_note_key_v2_abcdefghijklmnopqrstuvwxyz",
    noteKeyNonce: "encrypted_note_key_nonce_v2_abcdefghijklmnopqrstuvwxyz",
    noteKeyFormatVersion: 2
  };
}

export function seedCheckpointManifest(
  app: TestApp,
  input: { noteId: string; sectionId: string; cryptoOwnerId: string }
): string {
  const sqlite = appDb(app).sqlite;
  const uploadId = crypto.randomUUID();
  const updateId = crypto.randomUUID();
  const manifestId = crypto.randomUUID();
  sqlite.prepare(`
    INSERT INTO content_uploads (
      id, update_id, note_id, section_id, crypto_owner_id, key_epoch,
      kind, format_version, total_cipher_bytes, chunk_count, manifest_hash,
      status, expires_at
    ) VALUES (?, ?, ?, ?, ?, 1, 'checkpoint', 2, 6, 1, ?, 'committed', ?)
  `).run(
    uploadId,
    updateId,
    input.noteId,
    input.sectionId,
    input.cryptoOwnerId,
    `hash-${manifestId}`,
    "2099-01-01T00:00:00.000Z"
  );
  sqlite.prepare(`
    INSERT INTO content_manifests (
      id, upload_id, update_id, note_id, section_id, key_epoch, kind,
      format_version, first_sequence, last_sequence, total_cipher_bytes,
      chunk_count, manifest_hash
    ) VALUES (?, ?, ?, ?, ?, 1, 'checkpoint', 2, 1, 1, 6, 1, ?)
  `).run(
    manifestId,
    uploadId,
    updateId,
    input.noteId,
    input.sectionId,
    `hash-${manifestId}`
  );
  return manifestId;
}

export function failNoteEventWrites(app: TestApp): void {
  appDb(app).sqlite.exec(`
    CREATE TRIGGER fail_note_events_insert
    BEFORE INSERT ON note_events
    BEGIN
      SELECT RAISE(ABORT, 'note event failure');
    END;
  `);
}
