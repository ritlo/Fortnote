import type { Dir } from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import type { AppContext } from "../http/app.js";
import { reconcileStorageAccount, releaseStorageBytes } from "./quota.js";
import { deleteUncommittedContentUpload } from "./storage.js";

const STORAGE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

interface ExpiredUpload {
  uploadId: string;
  ownerUserId: string;
  totalCipherBytes: number;
}

export interface MaintenancePage {
  processed: number;
  hasMore: boolean;
}

export interface StorageCleanupPage {
  scanned: number;
  removed: number;
  done: boolean;
}

export interface ReconciliationPage extends MaintenancePage {
  nextUserId: string | null;
}

export interface ContentMaintenanceHandle {
  stop(): Promise<void>;
}

export async function expireContentUploadsPage(
  context: AppContext,
  now = new Date()
): Promise<MaintenancePage> {
  const cutoff = now.toISOString();
  const expired = context.db.sqlite.transaction(() => {
    const candidates = context.db.sqlite
      .prepare(`
        SELECT
          u.id AS uploadId,
          u.total_cipher_bytes AS totalCipherBytes,
          n.user_id AS ownerUserId
        FROM content_uploads u
        JOIN notes n ON n.id = u.note_id
        WHERE u.status IN ('receiving', 'complete', 'invalid')
          AND u.expires_at <= ?
        ORDER BY u.expires_at, u.id
        LIMIT ?
      `)
      .all(cutoff, context.config.maintenanceBatchSize) as ExpiredUpload[];
    const claimed: ExpiredUpload[] = [];
    for (const candidate of candidates) {
      const updated = context.db.sqlite
        .prepare(`
          UPDATE content_uploads
          SET status = 'expired', updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
            AND status IN ('receiving', 'complete', 'invalid')
            AND expires_at <= ?
        `)
        .run(candidate.uploadId, cutoff);
      if (updated.changes === 1) {
        context.db.sqlite
          .prepare("DELETE FROM content_chunks WHERE upload_id = ?")
          .run(candidate.uploadId);
        releaseStorageBytes(
          context.db,
          candidate.ownerUserId,
          candidate.totalCipherBytes
        );
        claimed.push(candidate);
      }
    }
    return claimed;
  })();

  for (const upload of expired) {
    await deleteUncommittedContentUpload(context.config, upload.uploadId);
  }
  const remaining = context.db.sqlite
    .prepare(`
      SELECT 1 FROM content_uploads
      WHERE status IN ('receiving', 'complete', 'invalid') AND expires_at <= ?
      LIMIT 1
    `)
    .get(cutoff);
  return { processed: expired.length, hasMore: Boolean(remaining) };
}

export class ContentStorageScanner {
  #directory: Dir | null = null;
  #done = false;

  constructor(private readonly context: AppContext) {}

  async nextPage(): Promise<StorageCleanupPage> {
    if (this.#done) {
      return { scanned: 0, removed: 0, done: true };
    }
    if (!this.#directory) {
      const root = path.join(this.context.config.dataDir, "content");
      await fsPromises.mkdir(root, { recursive: true, mode: 0o700 });
      this.#directory = await fsPromises.opendir(root);
    }

    let scanned = 0;
    let removed = 0;
    while (scanned < this.context.config.maintenanceBatchSize) {
      const entry = await this.#directory.read();
      if (!entry) {
        await this.close();
        break;
      }
      scanned += 1;
      if (
        entry.isDirectory() &&
        STORAGE_ID_PATTERN.test(entry.name) &&
        canRemoveUploadDirectory(this.context, entry.name)
      ) {
        await deleteUncommittedContentUpload(this.context.config, entry.name);
        removed += 1;
      }
    }
    return { scanned, removed, done: this.#done };
  }

  async close(): Promise<void> {
    const directory = this.#directory;
    this.#directory = null;
    this.#done = true;
    if (directory) {
      await directory.close().catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ERR_DIR_CLOSED") {
          throw error;
        }
      });
    }
  }
}

export function reconcileStorageAccountsPage(
  context: AppContext,
  afterUserId: string | null = null
): ReconciliationPage {
  const rows = context.db.sqlite
    .prepare(`
      SELECT user_id AS userId
      FROM (
        SELECT user_id FROM storage_accounts
        UNION
        SELECT user_id FROM notes
      )
      WHERE (? IS NULL OR user_id > ?)
      ORDER BY user_id
      LIMIT ?
    `)
    .all(afterUserId, afterUserId, context.config.maintenanceBatchSize) as {
      userId: string;
    }[];
  for (const { userId } of rows) {
    context.db.sqlite.transaction(() => reconcileStorageAccount(context.db, userId))();
  }
  const nextUserId = rows.at(-1)?.userId ?? null;
  const hasMore = nextUserId
    ? Boolean(
        context.db.sqlite
          .prepare(`
            SELECT 1
            FROM (
              SELECT user_id FROM storage_accounts
              UNION
              SELECT user_id FROM notes
            )
            WHERE user_id > ? LIMIT 1
          `)
          .get(nextUserId)
      )
    : false;
  return { processed: rows.length, hasMore, nextUserId };
}

export async function runContentStartupMaintenance(context: AppContext): Promise<void> {
  let expiryPage: MaintenancePage;
  do {
    expiryPage = await expireContentUploadsPage(context);
    if (expiryPage.hasMore) {
      await yieldToEventLoop();
    }
  } while (expiryPage.hasMore);

  const scanner = new ContentStorageScanner(context);
  for (;;) {
    const page = await scanner.nextPage();
    if (page.done) {
      break;
    }
    await yieldToEventLoop();
  }

  let afterUserId: string | null = null;
  for (;;) {
    const page = reconcileStorageAccountsPage(context, afterUserId);
    if (!page.hasMore) {
      break;
    }
    afterUserId = page.nextUserId;
    await yieldToEventLoop();
  }
}

export function startContentMaintenance(context: AppContext): ContentMaintenanceHandle {
  let scanner = new ContentStorageScanner(context);
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const intervalMs = Math.min(60_000, Math.max(1_000, context.config.contentUploadExpiryMs));

  const schedule = () => {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      void runPage();
    }, intervalMs);
    timer.unref();
  };
  const runPage = async () => {
    try {
      await expireContentUploadsPage(context);
      const page = await scanner.nextPage();
      if (page.done) {
        scanner = new ContentStorageScanner(context);
      }
    } catch (error) {
      console.error("Fortnote content maintenance failed", error);
    } finally {
      schedule();
    }
  };
  schedule();

  return {
    async stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
      await scanner.close();
    }
  };
}

function canRemoveUploadDirectory(context: AppContext, uploadId: string): boolean {
  const row = context.db.sqlite
    .prepare(`
      SELECT
        u.status,
        EXISTS(
          SELECT 1 FROM content_manifests m WHERE m.upload_id = u.id
        ) AS hasManifest
      FROM content_uploads u WHERE u.id = ?
    `)
    .get(uploadId) as { status: string; hasManifest: number } | undefined;
  if (!row) {
    return true;
  }
  if (row.hasManifest || row.status === "committed") {
    return false;
  }
  return row.status === "aborted" || row.status === "expired" || row.status === "invalid";
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
