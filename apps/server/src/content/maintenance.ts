import type { AppContext } from "../http/app.js";
import { logError } from "../observability/log.js";

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
  let timer: NodeJS.Timeout | null = null;
  let activePage: Promise<void> | null = null;
  let stopped = false;
  const intervalMs = Math.min(
    60_000,
    Math.max(1_000, context.config.contentUploadExpiryMs)
  );

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
      await removeOrphanContentObjectsPage(context);
    } catch (error) {
      logError("maintenance.content.failed", {}, error);
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
    }
  };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
