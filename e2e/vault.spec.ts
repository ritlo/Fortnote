import { expect, test, type Page } from "@playwright/test";
import { Buffer } from "node:buffer";

test("creates, edits, searches, trashes, restores, and attaches encrypted content", async ({
  page
}) => {
  const account = uniqueAccount("flow");
  const noteTitle = `Launch plan ${account.suffix}`;

  await register(page, account.username, account.password);
  await createNote(page, noteTitle, "First encrypted body");

  await page.getByPlaceholder("Search decrypted notes").fill("Launch");
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

  await page.getByRole("button", { name: "Restore" }).click();
  await page.getByRole("button", { name: "All notes" }).click();
  await expect(page.getByRole("button", { name: /Launch plan/ })).toBeVisible();
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
  await page.getByLabel("Username").fill(account.username);
  await page.getByLabel("Recovery key").fill(recoveryKey);
  await page.getByLabel("New account password").fill(recoveredPassword);
  await page.getByRole("button", { name: "Recover and decrypt" }).click();

  await expect(page.getByText("Recovered and decrypted")).toBeVisible();
  await expect(page.getByRole("button", { name: new RegExp(noteTitle) })).toBeVisible();
});

test("sanitizes malicious markdown preview content", async ({ page }) => {
  const account = uniqueAccount("markdown");
  const noteTitle = `Markdown note ${account.suffix}`;
  const maliciousBody =
    "# Safe heading\n\n<script>window.__markdownExecuted = true</script>\n<img src=x onerror=\"window.__markdownExecuted = true\">";

  await register(page, account.username, account.password);
  await createNote(page, noteTitle, maliciousBody);

  await expect(page.locator(".preview-body h1", { hasText: "Safe heading" })).toBeVisible();
  await expect(page.locator(".preview-body script")).toHaveCount(0);
  await expect(page.locator(".preview-body img")).toHaveCount(0);
  await expect(
    page.locator(".preview-body", { hasText: "<script>window.__markdownExecuted = true</script>" })
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__markdownExecuted)))
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
  await page.getByLabel("Username").fill(account.username);
  await page.getByLabel("Account password").fill(account.password);
  await page.getByRole("button", { name: "Sign in and decrypt" }).click();

  await expect(page.locator(".preview-body", { hasText: noteBody })).toBeVisible();

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
  await page.getByLabel("Username").fill(username);
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
  await expect(page.getByLabel("Title")).toHaveValue("Untitled note");
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Markdown editor").fill(body);
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().includes("/api/notes/") &&
      response.ok()
  );
  await page.getByRole("button", { name: "Save" }).click();
  await saved;
  await expect(page.getByText("Note encrypted and saved")).toBeVisible();
  await expect(page.getByRole("button", { name: new RegExp(title) })).toBeVisible();
}

function uniqueAccount(prefix: string) {
  const suffix = `${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
  return {
    suffix,
    username: `${prefix}-${suffix}`,
    password: `password-${suffix}`
  };
}
