import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";
import { decodeCrdtBinaryFrame } from "../packages/shared/src/index.js";
import {
  closeAssuranceContexts,
  newAssurancePage,
  uniqueAssuranceAccount,
  type AssuranceAccount
} from "./support/assurance.js";
import { waitForCrdtDurability } from "./support/durability.js";

test("retains offline work through reconnect and ignores a delayed old-note save", async ({ page }) => {
  const account = uniqueAssuranceAccount("failure-offline");
  await register(page, account);
  const first = `Delayed note ${account.suffix}`;
  const second = `Current note ${account.suffix}`;
  await createNote(page, first);
  await page.reload();
  await signIn(page, account);
  await openNote(page, first);
  await waitForCrdtDurability(page);
  await createNote(page, second);
  await openNote(page, first);

  await page.context().setOffline(true);
  await appendEditorText(page, ` offline-${account.suffix}`);
  await expect(page.locator(".collaboration-status")).toContainText(
    "Offline — changes kept on this device"
  );
  await page.context().setOffline(false);
  await expect(page.locator(".collaboration-status")).toContainText("Saved and synchronized", {
    timeout: 30_000
  });

  let delayed: Route | null = null;
  await page.route("**/api/notes/*", async (route) => {
    if (route.request().method() === "PUT" && !delayed) {
      delayed = route;
      return;
    }
    await route.continue();
  });
  await page.getByLabel("Title").fill(`${first} delayed`);
  await expect.poll(() => delayed !== null).toBe(true);
  await openNote(page, second);
  await delayed!.continue();
  await expect(page.locator(".collaboration-status")).toContainText(
    "Saved and synchronized",
    { timeout: 30_000 }
  );
  await expect(page.getByLabel("Title")).toHaveValue(second);
});

test("distinguishes local and server quota while retaining the visible draft", async ({ page }) => {
  await installOutboxQuotaFault(page);
  const account = uniqueAssuranceAccount("failure-quota");
  await register(page, account);
  await createNote(page, `Quota note ${account.suffix}`);

  await page.evaluate(() => {
    (window as Window & { __fortnoteFailOutbox?: boolean }).__fortnoteFailOutbox = true;
  });
  const localText = `local-quota-${account.suffix}`;
  await appendEditorText(page, ` ${localText}`);
  await expect(page.getByRole("alert")).toContainText(
    "Local storage full — changes need attention"
  );
  await expect(page.getByRole("alert")).toHaveCount(1);
  await expect(blockEditor(page)).toContainText(localText);
  await expectRecoveryActions(page, ["Retry", "Encrypted export", "Split section", "Clean up"]);
  const localLatency = await page.evaluate(() => {
    const failureAt = (window as Window & { __fortnoteOutboxFailureAt?: number })
      .__fortnoteOutboxFailureAt;
    return failureAt === undefined ? null : performance.now() - failureAt;
  });
  expect(localLatency).not.toBeNull();
  await expectNoSeriousAxeViolations(page);

  await page.reload();
  await signIn(page, account);
  const serverTiming = { failureAt: 0 };
  await page.route("**/api/content/uploads", async (route) => {
    serverTiming.failureAt = Date.now();
    await safeError(route, 507, "storage_limit", "Encrypted storage quota reached");
  });
  const serverText = `server-quota-${account.suffix}`;
  await appendGeneratedText(page, 300 * 1024, ` ${serverText} `);
  await expect(page.getByRole("alert")).toContainText(
    "Server storage full — changes kept on this device"
  );
  await expect(page.getByRole("alert")).toHaveCount(1);
  await expectRecoveryActions(page, ["Retry", "Encrypted export"]);
  await expect(blockEditor(page)).toContainText(serverText);
  expect(serverTiming.failureAt).toBeGreaterThan(0);
  await expectNoSeriousAxeViolations(page);
  test.info().annotations.push({
    type: "capacity-latency",
    description: `local=${String(Math.round(localLatency ?? 0))}ms server=${String(
      Date.now() - serverTiming.failureAt
    )}ms`
  });
});

test("preserves conflict, undecryptable, stale-epoch, and terminally rejected work", async ({ page }) => {
  const account = uniqueAssuranceAccount("failure-repair");
  await register(page, account);
  const title = `Repair note ${account.suffix}`;
  await createNote(page, title);

  await page.route("**/api/notes/*", async (route) => {
    if (route.request().method() === "PUT") {
      await safeError(route, 409, "version_conflict", "Encrypted note version changed");
      return;
    }
    await route.continue();
  });
  await page.getByLabel("Title").fill(`${title} conflict`);
  await expect(page.getByRole("alert")).toContainText("Changes need review");
  await expect(page.getByLabel("Title")).toHaveValue(`${title} conflict`);
  await expectRecoveryActions(page, ["Review draft", "Encrypted export", "Reapply"]);
  await page.unroute("**/api/notes/*");

  let corruptedHistoryFrame = false;
  await page.routeWebSocket(/\/api\/realtime/, (pageSocket) => {
    const serverSocket = pageSocket.connectToServer();
    pageSocket.onMessage((message) => {
      serverSocket.send(message);
    });
    serverSocket.onMessage((message) => {
      if (!corruptedHistoryFrame && typeof message !== "string") {
        try {
          decodeCrdtBinaryFrame(Uint8Array.from(message), 256 * 1024);
          const corrupted = Uint8Array.from(message);
          corrupted[corrupted.length - 1] ^= 0xff;
          corruptedHistoryFrame = true;
          pageSocket.send(corrupted);
          return;
        } catch {
          // Forward non-CRDT binary traffic unchanged.
        }
      }
      pageSocket.send(message);
    });
  });
  await page.reload();
  await signIn(page, account);
  await openNote(page, title);
  await expect(page.getByRole("alert")).toContainText("This note cannot be decrypted");
  await expectRecoveryActions(page, ["Retry", "Repair access"]);

  for (const failure of [
    ["stale_epoch", "Access changed — refreshing protection"],
    ["forbidden", "Changes need review"]
  ] as const) {
    await page.route("**/api/content/uploads", async (route) => {
      await safeError(route, 409, failure[0], "Encrypted update rejected");
    });
    await appendGeneratedText(page, 300 * 1024, ` ${failure[0]}-${account.suffix} `);
    const target =
      failure[0] === "forbidden"
        ? page.getByRole("alert")
        : page.locator(".collaboration-status");
    await expect(target).toContainText(failure[1]);
    await expect(blockEditor(page)).toContainText(`${failure[0]}-${account.suffix}`);
    await page.unroute("**/api/content/uploads");
  }
});

test("keeps viewer and trash read-only, reports rotation abort, then removes revoked access", async ({
  baseURL,
  browser
}) => {
  const contexts: BrowserContext[] = [];
  const owner = uniqueAssuranceAccount("failure-owner");
  const viewer = uniqueAssuranceAccount("failure-viewer");
  const title = `Role note ${owner.suffix}`;
  try {
    const viewerPage = await newAssurancePage(browser, baseURL, contexts);
    await register(viewerPage, viewer);
    await waitForSharingKey(viewerPage);

    const ownerPage = await newAssurancePage(browser, baseURL, contexts);
    await register(ownerPage, owner);
    await createNote(ownerPage, title);
    await shareNote(ownerPage, viewer.username, "viewer");
    await openNote(viewerPage, title);
    await expect(viewerPage.locator(".collaboration-status")).toContainText("View only");
    await expect(blockEditor(viewerPage)).toHaveAttribute("contenteditable", "false");

    await ownerPage.getByRole("button", { name: "Delete", exact: true }).click();
    await ownerPage.getByRole("button", { name: "Trash", exact: true }).click();
    await openNote(ownerPage, title);
    await expect(ownerPage.locator(".collaboration-status")).toContainText("In trash — view only");
    await expect(ownerPage.getByLabel("Title")).toBeDisabled();
    await ownerPage.getByRole("button", { name: "Restore" }).click();
    await ownerPage.getByRole("button", { name: "All notes", exact: true }).click();
    await openNote(ownerPage, title);

    let abortRotation = true;
    await ownerPage.route("**/api/notes/*/key-rotation", async (route) => {
      if (abortRotation) {
        abortRotation = false;
        await safeError(route, 409, "rotation_aborted", "Access change expired");
        return;
      }
      await route.continue();
    });
    await revokeMember(ownerPage, viewer.username, false);
    await expect(ownerPage.getByRole("alert")).toContainText("Access change not completed");
    await expectRecoveryActions(ownerPage, ["Try again", "Review access"]);

    await revokeMember(ownerPage, viewer.username, true);
    await expect(viewerPage.getByRole("alert")).toContainText("You no longer have access");
    await expect(blockEditor(viewerPage)).toHaveCount(0);
  } finally {
    await closeAssuranceContexts(contexts);
  }
});

async function register(page: Page, account: AssuranceAccount): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Register" }).click();
  await page.getByLabel("Account handle").fill(account.username);
  await page.getByLabel("Account password").fill(account.password);
  await page.getByRole("button", { name: "Create encrypted vault" }).click();
  await expect(page.getByText("Signed in and decrypted")).toBeVisible();
}

async function signIn(page: Page, account: AssuranceAccount): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Account handle").fill(account.username);
  await page.getByLabel("Account password").fill(account.password);
  await page.getByRole("button", { name: "Sign in and decrypt" }).click();
  await expect(page.getByText("Signed in and decrypted")).toBeVisible();
}

async function createNote(page: Page, title: string): Promise<void> {
  await page.getByLabel("New note").click();
  const saved = page.waitForResponse((response) =>
    response.request().method() === "PUT" && response.url().includes("/api/notes/") && response.ok()
  );
  await page.getByLabel("Title").fill(title);
  await saved;
  await waitForCrdtDurability(page);
  await expect(page.getByRole("button", { name: titlePattern(title) })).toBeVisible();
}

async function openNote(page: Page, title: string): Promise<void> {
  const note = page.getByRole("button", { name: titlePattern(title) });
  await expect(note).toBeVisible({ timeout: 15_000 });
  await note.click();
  await expect(page.getByLabel("Title")).toHaveValue(title);
}

async function shareNote(page: Page, username: string, role: "editor" | "viewer"): Promise<void> {
  await page.getByLabel("Collaborator username").fill(username);
  await page.getByLabel("Collaborator role").selectOption(role);
  await page.getByRole("button", { name: "Share note" }).click();
  const trust = page.getByRole("button", { name: "Trust key" });
  await expect(trust).toBeVisible();
  await page.getByLabel("I independently verified this exact key").check();
  await trust.click();
  await expect(page.locator(".membership-list li", { hasText: username })).toContainText(role);
}

async function revokeMember(page: Page, username: string, success: boolean): Promise<void> {
  const response = page.waitForResponse((candidate) =>
    candidate.request().method() === "POST" && candidate.url().includes("/key-rotation")
  );
  await page.locator(".membership-list li", { hasText: username })
    .getByRole("button", { name: "Revoke" }).click();
  expect((await response).ok()).toBe(success);
}

async function waitForSharingKey(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(async () =>
    (await fetch("/api/sharing-keys/current", { credentials: "include" })).ok
  )).toBe(true);
}

async function appendEditorText(page: Page, text: string): Promise<void> {
  const editor = blockEditor(page);
  await editor.focus();
  await editor.press("ControlOrMeta+End");
  await editor.pressSequentially(text);
}

async function appendGeneratedText(page: Page, bytes: number, prefix: string): Promise<void> {
  await blockEditor(page).focus();
  expect(await page.evaluate(({ byteLength, value }) => {
    const editor = document.querySelector<HTMLElement>(".block-editor .bn-editor");
    const selection = getSelection();
    if (!editor || !selection) return false;
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    return document.execCommand("insertText", false, value + "x".repeat(byteLength - value.length));
  }, { byteLength: bytes, value: prefix })).toBe(true);
}

async function installOutboxQuotaFault(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore["put"]>) {
      if (
        this.name === "encryptedOutbox" &&
        (window as Window & { __fortnoteFailOutbox?: boolean }).__fortnoteFailOutbox
      ) {
        (window as Window & { __fortnoteOutboxFailureAt?: number })
          .__fortnoteOutboxFailureAt = performance.now();
        throw new DOMException("Browser quota exhausted", "QuotaExceededError");
      }
      return original.apply(this, args);
    };
  });
}

async function safeError(route: Route, status: number, code: string, message: string): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify({ error: { code, message, requestId: crypto.randomUUID() } })
  });
}

async function expectRecoveryActions(page: Page, labels: string[]): Promise<void> {
  const recovery = page.getByRole("region", { name: "Recovery actions" });
  await expect(recovery).toBeVisible();
  await expect(recovery.getByRole("button")).toHaveText(labels);
}

async function expectNoSeriousAxeViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter(({ impact }) => impact === "serious" || impact === "critical")
  ).toEqual([]);
}

function blockEditor(page: Page) {
  return page.locator(".block-editor .bn-editor");
}

function titlePattern(title: string): RegExp {
  return new RegExp(title.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u");
}
