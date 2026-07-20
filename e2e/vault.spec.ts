import { expect, test, type Page } from "@playwright/test";
import { Buffer } from "node:buffer";
import { waitForCrdtDurability } from "./support/durability.js";

test("creates, edits, searches, trashes, restores, and attaches encrypted content", async ({
  page
}) => {
  const account = uniqueAccount("flow");
  const noteTitle = `Launch plan ${account.suffix}`;

  await register(page, account.username, account.password);
  await createNote(page, noteTitle, "First encrypted body");
  await expect(page.locator(".editor-grid")).toHaveCount(0);
  await expectEditorToFillPane(page);

  await page.setViewportSize({ width: 800, height: 800 });
  await expectEditorToFillPane(page);

  await page.getByPlaceholder("Search decrypted notes").fill("First encrypted body");
  await expect(page.locator(".search-coverage")).toContainText(
    /Search covers all [1-9]\d* sections\./,
    { timeout: 20_000 }
  );
  await expect(page.getByRole("button", { name: /Launch plan/ })).toBeVisible();

  await page.getByLabel("Attach encrypted file").setInputFiles({
    name: "plan.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("attachment plaintext")
  });
  await expect(page.getByText("plan.txt")).toBeVisible();

  await page
    .locator(".editor-pane > .pane-header")
    .getByRole("button", { name: "Delete" })
    .click();
  await page.getByRole("button", { name: "Trash" }).click();
  await expect(page.getByRole("button", { name: /Launch plan/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Redo", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Restore" }).click();
  await page.getByRole("button", { name: "All notes" }).click();
  await expect(page.getByRole("button", { name: /Launch plan/ })).toBeVisible();
});

test("autosaves undo and redo and retains the result after relogin", async ({ page }) => {
  const account = uniqueAccount("undo-redo");
  const suffix = ` undo-redo-${account.suffix}`;

  await test.step("create the note", async () => {
    await register(page, account.username, account.password);
    await createNote(page, `History note ${account.suffix}`, "Initial body");
  });

  await test.step("undo and redo the local edit", async () => {
    const editor = blockEditor(page);
    await editor.press("ControlOrMeta+End");
    await editor.pressSequentially(suffix);
    await waitForCrdtDurability(page);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(editor).not.toContainText(suffix);
    await waitForCrdtDurability(page);
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await expect(editor).toContainText(suffix);
    await waitForCrdtDurability(page);
  });

  await test.step("reload the persisted result", async () => {
    await page.reload();
    await page.getByLabel("Account password").fill(account.password);
    await page.getByRole("button", { name: "Sign in and decrypt" }).click();
    await expect(blockEditor(page)).toContainText(suffix);
  });
});

test("recovers a vault with the saved recovery key", async ({ page }) => {
  const account = uniqueAccount("recover");
  const recoveredPassword = `${account.password} recovered`;
  const noteTitle = `Recovery note ${account.suffix}`;

  const recoveryKey = await register(page, account.username, account.password);
  await createNote(page, noteTitle, "Recoverable encrypted body");

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Lock vault" }).click();
  await page.getByRole("button", { name: "Recover" }).click();
  await page.getByLabel("Account handle").fill(account.username);
  await page.getByLabel("Recovery key").fill(recoveryKey);
  await page.getByLabel("New account password").fill(recoveredPassword);
  await page.getByRole("button", { name: "Recover and decrypt" }).click();

  await expect(page.getByText("Recovered and decrypted")).toBeVisible();
  await expect(page.getByRole("button", { name: new RegExp(noteTitle) })).toBeVisible();
});

test("renders potentially malicious editor text without executing it", async ({ page }) => {
  const account = uniqueAccount("markdown");
  const noteTitle = `Markdown note ${account.suffix}`;
  const maliciousBody =
    "# Safe heading\n\n<script>window.__markdownExecuted = true</script>\n<img src=x onerror=\"window.__markdownExecuted = true\">";

  await register(page, account.username, account.password);
  await createNote(page, noteTitle, maliciousBody);

  await expect(blockEditor(page)).toContainText("Safe heading");
  await expect(blockEditor(page).locator("script")).toHaveCount(0);
  await expect(blockEditor(page).locator("img")).toHaveCount(0);
  await expect(blockEditor(page)).toContainText(
    "<script>window.__markdownExecuted = true</script>"
  );
  await expect
    .poll(() => page.evaluate(() =>
      Boolean((window as Window & { __markdownExecuted?: boolean }).__markdownExecuted)
    ))
    .toBe(false);
});

test("lock and logout clear decrypted note content from the UI", async ({ page }) => {
  const account = uniqueAccount("lock");
  const noteTitle = `Lock note ${account.suffix}`;
  const noteBody = `Sensitive note body ${account.suffix}`;

  await register(page, account.username, account.password);
  await createNote(page, noteTitle, noteBody);

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Lock vault" }).click();

  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByText(noteBody)).toHaveCount(0);
  await expect(page.getByRole("button", { name: new RegExp(noteTitle) })).toHaveCount(0);

  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Account handle").fill(account.username);
  await page.getByLabel("Account password").fill(account.password);
  await page.getByRole("button", { name: "Sign in and decrypt" }).click();

  await expect(blockEditor(page)).toContainText(noteBody);

  await page.getByRole("button", { name: "Logout" }).click();

  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByText(noteBody)).toHaveCount(0);
  await expect(page.getByRole("button", { name: new RegExp(noteTitle) })).toHaveCount(0);
});

async function register(
  page: Page,
  username: string,
  password: string
): Promise<string> {
  await page.goto("/");
  await page.getByRole("button", { name: "Register" }).click();
  await page.getByLabel("Account handle").fill(username);
  await page.getByLabel("Account password").fill(password);
  await page.getByRole("button", { name: "Create encrypted vault" }).click();
  await expect(page.getByText("Signed in and decrypted")).toBeVisible();

  const recoveryText = await page.getByText(/^Recovery key:/).textContent();
  expect(recoveryText).toBeTruthy();
  return recoveryText!.replace("Recovery key:", "").trim();
}

async function createNote(page: Page, title: string, body: string): Promise<void> {
  await page.getByLabel("New note").click();
  await expect(page.getByRole("button", { name: /Untitled note/ })).toBeVisible();
  await expect(page.getByText("Note encrypted and saved")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
  const titleInput = page.getByLabel("Title");
  await expect(titleInput).toHaveValue("Untitled note");
  const saved = waitForNoteSave(page);
  await setEditorText(page, body);
  await titleInput.fill(title);
  await saved;
  await waitForCrdtDurability(page);
  await expect(titleInput).toHaveValue(title);
  await expect(page.getByText(/^Last saved \d+ seconds ago$/)).toBeVisible();
  await expect(page.getByRole("button", { name: new RegExp(title) })).toBeVisible();
}

async function expectEditorToFillPane(page: Page): Promise<void> {
  const pane = await page.locator(".editor-pane").boundingBox();
  const column = await page.locator(".editor-column").boundingBox();
  expect(pane).toBeTruthy();
  expect(column).toBeTruthy();
  expect(Math.abs(pane!.width - column!.width)).toBeLessThanOrEqual(1);
}

async function waitForNoteSave(page: Page) {
  const response = await page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().includes("/api/notes/") &&
      response.ok()
  );
  await expect(page.locator(".status-pill")).toHaveText("Ready");
  return response;
}

function blockEditor(page: Page) {
  return page.locator(".block-editor .bn-editor");
}

async function setEditorText(page: Page, body: string): Promise<void> {
  const editor = blockEditor(page);
  await expect(editor).toBeVisible();
  await editor.click();
  await editor.press("ControlOrMeta+A");
  await editor.pressSequentially(body);
}

function uniqueAccount(prefix: string) {
  const suffix = `${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
  return {
    suffix,
    username: `${prefix}-${suffix}`,
    password: `password-${suffix}`
  };
}
