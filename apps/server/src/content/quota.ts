import type { AppDb } from "../db/client.js";

export interface StorageQuotaStatus {
  usedBytes: number;
  reservedBytes: number;
  quotaBytes: number;
  availableBytes: number;
}

interface StorageCounterRow {
  usedBytes: number;
  reservedBytes: number;
}

export function reserveStorageBytes(
  db: AppDb,
  userId: string,
  bytes: number,
  quotaBytes: number
): boolean {
  db.sqlite
    .prepare("INSERT OR IGNORE INTO storage_accounts (user_id) VALUES (?)")
    .run(userId);
  return db.sqlite
    .prepare(`
      UPDATE storage_accounts
      SET reserved_bytes = reserved_bytes + ?, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND used_bytes + reserved_bytes + ? <= ?
    `)
    .run(bytes, userId, bytes, quotaBytes).changes === 1;
}

export function releaseStorageBytes(db: AppDb, userId: string, bytes: number): void {
  db.sqlite
    .prepare(`
      UPDATE storage_accounts
      SET reserved_bytes = MAX(reserved_bytes - ?, 0), updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
    `)
    .run(bytes, userId);
}

export function commitStorageBytes(db: AppDb, userId: string, bytes: number): boolean {
  return db.sqlite
    .prepare(`
      UPDATE storage_accounts
      SET
        used_bytes = used_bytes + ?,
        reserved_bytes = reserved_bytes - ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND reserved_bytes >= ?
    `)
    .run(bytes, bytes, userId, bytes).changes === 1;
}

export function getStorageQuotaStatus(
  db: AppDb,
  userId: string,
  quotaBytes: number
): StorageQuotaStatus {
  const row = db.sqlite
    .prepare(`
      SELECT used_bytes AS usedBytes, reserved_bytes AS reservedBytes
      FROM storage_accounts
      WHERE user_id = ?
    `)
    .get(userId) as StorageCounterRow | undefined;
  const usedBytes = row?.usedBytes ?? 0;
  const reservedBytes = row?.reservedBytes ?? 0;
  return {
    usedBytes,
    reservedBytes,
    quotaBytes,
    availableBytes: Math.max(quotaBytes - usedBytes - reservedBytes, 0)
  };
}

export function reconcileStorageAccount(db: AppDb, userId: string): StorageCounterRow {
  const committed = db.sqlite
    .prepare(`
      SELECT
        COALESCE((
          SELECT SUM(m.total_cipher_bytes)
          FROM content_manifests m
          JOIN notes n ON n.id = m.note_id
          WHERE n.user_id = ?
        ), 0) +
        COALESCE((
          SELECT SUM(a.size)
          FROM attachments a
          JOIN notes n ON n.id = a.note_id
          WHERE n.user_id = ?
        ), 0) AS bytes
    `)
    .get(userId, userId) as { bytes: number };
  const reserved = db.sqlite
    .prepare(`
      SELECT COALESCE(SUM(u.total_cipher_bytes), 0) AS bytes
      FROM content_uploads u
      JOIN notes n ON n.id = u.note_id
      WHERE n.user_id = ? AND u.status IN ('receiving', 'complete', 'invalid')
    `)
    .get(userId) as { bytes: number };
  db.sqlite
    .prepare(`
      INSERT INTO storage_accounts (user_id, used_bytes, reserved_bytes, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET
        used_bytes = excluded.used_bytes,
        reserved_bytes = excluded.reserved_bytes,
        updated_at = CURRENT_TIMESTAMP
    `)
    .run(userId, committed.bytes, reserved.bytes);
  return { usedBytes: committed.bytes, reservedBytes: reserved.bytes };
}
