import { createTestApp } from "../support/http.js";
import {
  failNoteEventWrites as failDatabaseEventWrites,
  testSql
} from "../support/database.js";

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

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

export async function seedCheckpointManifest(
  app: TestApp,
  input: { noteId: string; sectionId: string; cryptoOwnerId: string }
): Promise<string> {
  const sql = testSql(app.locals.db);
  const uploadId = crypto.randomUUID();
  const updateId = crypto.randomUUID();
  const manifestId = crypto.randomUUID();
  await sql.run(
    `
    INSERT INTO content_uploads (
      id, update_id, note_id, section_id, crypto_owner_id, key_epoch,
      kind, format_version, total_cipher_bytes, chunk_count, manifest_hash,
      status, expires_at
    ) VALUES (?, ?, ?, ?, ?, 1, 'checkpoint', 2, 6, 1, ?, 'committed', ?)
  `,
    uploadId,
    updateId,
    input.noteId,
    input.sectionId,
    input.cryptoOwnerId,
    `hash-${manifestId}`,
    "2099-01-01T00:00:00.000Z"
  );
  await sql.run(
    `
    INSERT INTO content_manifests (
      id, upload_id, update_id, note_id, section_id, key_epoch, kind,
      format_version, first_sequence, last_sequence, total_cipher_bytes,
      chunk_count, manifest_hash
    ) VALUES (?, ?, ?, ?, ?, 1, 'checkpoint', 2, 1, 1, 6, 1, ?)
  `,
    manifestId,
    uploadId,
    updateId,
    input.noteId,
    input.sectionId,
    `hash-${manifestId}`
  );
  return manifestId;
}

export function failNoteEventWrites(app: TestApp): Promise<void> {
  return failDatabaseEventWrites(app.locals.db);
}
