import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";
import {
  closeAssuranceContexts,
  newAssurancePage,
  uniqueAssuranceAccount
} from "./support/assurance.js";

test("auth and empty vault expose names, keyboard focus, and clean axe results", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create an account" })).toBeVisible();
  await expect(page.getByLabel("Account handle")).toBeVisible();
  await expect(page.getByLabel("Account password")).toBeVisible();
  await expectAxeClean(page);

  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toBeVisible();
  await expectVisibleFocus(page);

  const account = uniqueAssuranceAccount("a11y-empty");
  await register(page, account.username, account.password);
  await expect(page.getByRole("button", { name: "New note" })).toBeVisible();
  await expect(page.getByText("No notes yet", { exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toHaveCount(0);
  await expectAxeClean(page);
});

test("editor remains accessible at 375 by 812", async ({ page }) => {
  const account = uniqueAssuranceAccount("a11y-editor");
  await register(page, account.username, account.password);
  await page.getByRole("button", { name: "New note" }).click();
  await page.getByRole("dialog", { name: "New note" }).getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("textbox", { name: "Title" })).toBeEnabled();
  await expect(page.locator(".block-editor .bn-editor")).toBeVisible();

  await page.getByRole("textbox", { name: "Title" }).focus();
  await page.keyboard.press("Tab");

  await expectNoHorizontalScroll(page);
  await expectAxeClean(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  await expect(page.getByRole("button", { name: "Logout" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Title" })).toBeVisible();
  await expect(page.locator(".collaboration-status")).toBeVisible();
  await expectAxeClean(page);
});

test("trust confirmation restores focus to its invoker", async ({ baseURL, browser }) => {
  const contexts: BrowserContext[] = [];
  const owner = uniqueAssuranceAccount("a11y-owner");
  const collaborator = uniqueAssuranceAccount("a11y-collaborator");
  try {
    const collaboratorPage = await newAssurancePage(browser, baseURL, contexts);
    await register(collaboratorPage, collaborator.username, collaborator.password);
    await collaboratorPage.context().close();
    contexts.splice(contexts.indexOf(collaboratorPage.context()), 1);

    const ownerPage = await newAssurancePage(browser, baseURL, contexts);
    await register(ownerPage, owner.username, owner.password);
    await ownerPage.getByRole("button", { name: "New note" }).click();
    const saved = ownerPage.waitForResponse((r) =>
      r.request().method() === "PUT" && r.url().includes("/api/notes/") && r.ok()
    );
    await ownerPage.getByRole("dialog", { name: "New note" }).getByRole("button", { name: "Create" }).click();
    await ownerPage.getByRole("textbox", { name: "Title" }).fill(`Note ${owner.suffix}`);
    await saved;
    await ownerPage.getByRole("button", { name: "Share note" }).click();
    const dialog = ownerPage.getByRole("dialog", { name: "Share note" });
    await expect(dialog).toBeVisible();
    const submit = dialog.getByRole("button", { name: "Share note" });
    await dialog.getByLabel("Collaborator username").fill(collaborator.username);
    await submit.focus();
    await ownerPage.keyboard.press("Enter");
    const confirmation = ownerPage.locator(".trust-confirmation");
    await expect(confirmation).toBeVisible();
    await expect(confirmation.getByRole("checkbox", {
      name: "I independently verified this exact key"
    })).toBeFocused();
    await expectAxeClean(ownerPage);
    await confirmation.getByRole("button", { name: "Cancel" }).click();
    await expect(submit).toBeFocused();
  } finally {
    await closeAssuranceContexts(contexts);
  }
});

test("viewer, offline, and recoverable error states remain accessible", async ({ baseURL, browser }) => {
  test.slow();
  const contexts: BrowserContext[] = [];
  const owner = uniqueAssuranceAccount("a11y-state-owner");
  const viewer = uniqueAssuranceAccount("a11y-state-viewer");
  const title = `Accessible state note ${owner.suffix}`;
  try {
    const viewerPage = await newAssurancePage(browser, baseURL, contexts);
    await register(viewerPage, viewer.username, viewer.password);
    await waitForSharingKey(viewerPage);

    const ownerPage = await newAssurancePage(browser, baseURL, contexts);
    await register(ownerPage, owner.username, owner.password);
    await createNote(ownerPage, title);
    await shareNote(ownerPage, viewer.username, "viewer");
    await openNote(viewerPage, title);
    await expect(viewerPage.locator(".collaboration-status")).toContainText("View only");
    await expect(viewerPage.locator(".block-editor .bn-editor"))
      .toHaveAttribute("contenteditable", "false");
    await expectAxeClean(viewerPage);

    await ownerPage.context().setOffline(true);
    await appendEditorText(ownerPage, ` offline-${owner.suffix}`);
    await expect(ownerPage.locator(".collaboration-status")).toContainText(
      "Offline — changes kept on this device"
    );
    await expectAxeClean(ownerPage);
    await ownerPage.context().setOffline(false);
    await expect(ownerPage.locator(".collaboration-status")).toContainText("Saved and synchronized", {
      timeout: 30_000
    });

    await expectAxeClean(ownerPage);
  } finally {
    await closeAssuranceContexts(contexts);
  }
});
test("rotation progress, repair, and revoked states remain accessible", async ({ baseURL, browser }) => {
  const contexts: BrowserContext[] = [];
  const owner = uniqueAssuranceAccount("a11y-rotation-owner");
  const viewer = uniqueAssuranceAccount("a11y-rotation-viewer");
  const title = `Accessible rotation note ${owner.suffix}`;
  try {
    const viewerPage = await newAssurancePage(browser, baseURL, contexts);
    await register(viewerPage, viewer.username, viewer.password);
    await waitForSharingKey(viewerPage);

    const ownerPage = await newAssurancePage(browser, baseURL, contexts);
    await register(ownerPage, owner.username, owner.password);
    await createNote(ownerPage, title);
    await shareNote(ownerPage, viewer.username, "viewer");
    await openNote(viewerPage, title);

    let pendingRotation: Route | null = null;
    await ownerPage.route("**/api/notes/*/key-rotation", (route) => {
      pendingRotation = route;
    });
    const response = ownerPage.waitForResponse((candidate) =>
      candidate.request().method() === "POST" && candidate.url().includes("/key-rotation")
    );
    await ownerPage.locator(".membership-list li", { hasText: viewer.username })
      .getByRole("button", { name: "Revoke" }).click();
    await expect.poll(() => pendingRotation !== null).toBe(true);
    await expect(ownerPage.locator(".collaboration-status"))
      .toContainText("Securing access — editing paused");
    await expectAxeClean(ownerPage);
    await safeError(pendingRotation!, 409, "rotation_aborted", "Access change expired");
    expect((await response).ok()).toBe(false);
    await expect(ownerPage.locator(".collaboration-status")).toContainText("Access change not completed", { timeout: 10_000 });
    await expectAxeClean(ownerPage);

    await ownerPage.unroute("**/api/notes/*/key-rotation");
    await revokeMember(ownerPage, viewer.username);
    await expect(viewerPage.locator(".collaboration-status")).toContainText("You no longer have access");
    await expect(viewerPage.locator(".block-editor .bn-editor")).toHaveCount(0);
    await expectAxeClean(viewerPage);
  } finally {
    await closeAssuranceContexts(contexts);
  }
});

async function register(page: Page, username: string, password: string): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account" }).click();
  await page.getByLabel("Account handle").fill(username);
  await page.getByLabel("Account password").fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByRole("button", { name: "Create encrypted vault" }).click();
  await expect(page.getByText("Signed in and decrypted")).toBeVisible();
}

async function createNote(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: "New note" }).click();
  const saved = page.waitForResponse((response) =>
    response.request().method() === "PUT" && response.url().includes("/api/notes/") && response.ok()
  );
  await page.getByRole("dialog", { name: "New note" }).getByRole("button", { name: "Create" }).click();
  await page.getByRole("textbox", { name: "Title" }).fill(title);
  await saved;
  await expect(page.getByRole("button", { name: noteCardPattern(title) })).toBeVisible();
}

async function openNote(page: Page, title: string): Promise<void> {
  const note = page.getByRole("button", { name: noteCardPattern(title) });
  await expect(note).toBeVisible({ timeout: 15_000 });
  await note.click();
  await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue(title);
}

async function shareNote(page: Page, username: string, role: "editor" | "viewer"): Promise<void> {
  await page.getByRole("button", { name: "Share note" }).click();
  await expect(page.getByRole("dialog", { name: "Share note" })).toBeVisible();
  await page.getByLabel("Collaborator username").fill(username);
  await page.getByLabel("Collaborator role").selectOption(role);
  await page.getByRole("dialog", { name: "Share note" }).getByRole("button", { name: "Share note" }).click();
  await page.getByLabel("I independently verified this exact key").check();
  await page.getByRole("button", { name: "Trust key" }).click();
  await expect(page.locator(".membership-list li", { hasText: username })).toContainText(role);
}

async function revokeMember(page: Page, username: string): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Share note" });
  if (!(await dialog.isVisible())) {
    await page.getByRole("button", { name: "Share note" }).click();
    await expect(dialog).toBeVisible();
  }
  const response = page.waitForResponse((candidate) =>
    candidate.request().method() === "POST" && candidate.url().includes("/key-rotation")
  );
  await page.locator(".membership-list li", { hasText: username })
    .getByRole("button", { name: "Revoke" }).click();
  expect((await response).ok()).toBe(true);
}

async function waitForSharingKey(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(async () =>
    (await fetch("/api/sharing-keys/current", { credentials: "include" })).ok
  )).toBe(true);
}

async function appendEditorText(page: Page, text: string): Promise<void> {
  const editor = page.locator(".block-editor .bn-editor");
  await editor.focus();
  await editor.press("ControlOrMeta+End");
  await editor.pressSequentially(text);
}

async function safeError(route: Route, status: number, code: string, message: string): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify({ error: { code, message, requestId: crypto.randomUUID() } })
  });
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
}

async function expectAxeClean(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
}

async function expectVisibleFocus(page: Page): Promise<void> {
  const focus = page.locator(":focus");
  await expect(focus).toBeVisible();
  expect(await focus.evaluate((element) => {
    const style = getComputedStyle(element);
    return style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0;
  })).toBe(true);
}

function noteCardPattern(title: string): RegExp {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp("^" + escaped + "(?:\\s+(Viewer|Editor))?\\s+\\d", "u");
}
