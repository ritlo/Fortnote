import type { Dir } from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import type { AppContext } from "../http/app.js";
import { logError } from "../observability/log.js";

const STORAGE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ORPHAN_GRACE_MS = 60 * 60 * 1000;

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
  const page = await context.db.contentMaintenance.expireUploads(
    now.toISOString(),
    context.config.maintenanceBatchSize
  );
  for (const upload of page.uploads) {
    await context.db.contentStorage.deleteUpload(upload.uploadId, upload.storageKeys);
  }
  return { processed: page.uploads.length, hasMore: page.hasMore };
}

export class ContentStorageScanner {
  #directory: Dir | null = null;
  #done = false;

  constructor(private readonly context: AppContext) {}

  async nextPage(): Promise<StorageCleanupPage> {
    if (this.#done) {
      return { scanned: 0, removed: 0, done: true };
    }
    if (!this.context.db.contentStorage.usesLocalUploadDirectories) {
      this.#done = true;
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
        await this.context.db.contentMaintenance.canRemoveUpload(entry.name)
      ) {
        await this.context.db.contentStorage.deleteUpload(entry.name);
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
): Promise<ReconciliationPage> {
  return context.db.contentMaintenance.reconcileStorageAccounts(
    afterUserId,
    context.config.maintenanceBatchSize
  );
}

export function removeOrphanContentObjectsPage(
  context: AppContext,
  now = new Date()
): Promise<StorageCleanupPage> {
  return context.db.contentMaintenance.removeOrphanObjects(
    new Date(now.getTime() - ORPHAN_GRACE_MS).toISOString(),
    context.config.maintenanceBatchSize
  );
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

  let objectPage: StorageCleanupPage;
  do {
    objectPage = await removeOrphanContentObjectsPage(context);
    if (!objectPage.done) {
      await yieldToEventLoop();
    }
  } while (!objectPage.done);

  let afterUserId: string | null = null;
  for (;;) {
    const page = await reconcileStorageAccountsPage(context, afterUserId);
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
  let activePage: Promise<void> | null = null;
  let stopped = false;
  const intervalMs = Math.min(60_000, Math.max(1_000, context.config.contentUploadExpiryMs));

  const schedule = () => {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      const page = runPage();
      activePage = page;
      void page.finally(() => {
        if (activePage === page) {
          activePage = null;
        }
      });
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
      await removeOrphanContentObjectsPage(context);
    } catch (error) {
      logError("maintenance.content.failed", {
        provider: context.db.provider
      }, error);
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
        timer = null;
      }
      if (activePage) {
        await activePage;
      }
      await scanner.close();
    }
  };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
