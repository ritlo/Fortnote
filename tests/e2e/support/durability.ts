import { expect, type Page } from "@playwright/test";

export async function waitForCrdtDurability(page: Page): Promise<void> {
  await page.evaluate(
    async () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            resolve();
          })
        );
      })
  );
  await expect(page.locator(".collaboration-status")).toContainText(
    "Saved and synchronized",
    { timeout: 15_000 }
  );
  await expect.poll(() => pendingEncryptedUpdates(page), { timeout: 15_000 }).toBe(0);
}

async function pendingEncryptedUpdates(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const request = indexedDB.open("fortnote-protected");
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        reject(request.error ?? new Error("IndexedDB open failed"));
      };
    });
    try {
      if (!database.objectStoreNames.contains("encryptedOutbox")) return 0;
      const records = await new Promise<{ state: string }[]>((resolve, reject) => {
        const read = database
          .transaction("encryptedOutbox", "readonly")
          .objectStore("encryptedOutbox")
          .getAll();
        read.onsuccess = () => {
          resolve(read.result as { state: string }[]);
        };
        read.onerror = () => {
          reject(read.error ?? new Error("Encrypted outbox read failed"));
        };
      });
      return records.filter(({ state }) => state !== "terminal-rejected").length;
    } finally {
      database.close();
    }
  });
}
