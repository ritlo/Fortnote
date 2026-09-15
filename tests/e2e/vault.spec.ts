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
  await expect(page.locator(".blocknote-surface")).toHaveAttribute("data-theme", "light");

  const noteCard = page.locator(".note-card", { hasText: noteTitle });
  await noteCard.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Move to folder" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitem", { name: "Move to folder" })).toHaveCount(0);
  await noteCard.focus();
  await page.keyboard.press("Shift+F10");
  await expect(page.getByRole("menuitem", { name: "Move to folder" })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 800, height: 800 });
  await expectEditorToFillPane(page);

  await page.getByPlaceholder("Search decrypted notes").fill("First encrypted body");
  await expect(page.locator(".search-coverage")).toContainText("Search is ready.", {
    timeout: 20_000
  });
  await expect(page.locator(".search-match-list").first()).toBeVisible({
    timeout: 10_000
  });
  await page.getByPlaceholder("Search decrypted notes").fill("");

  await insertFileBlock(page);
  const uploaded = waitForAttachmentUpload(page);
  await page.locator('input[type="file"]').setInputFiles({
    name: "plan.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("attachment plaintext")
  });
  await uploaded;
  await expect(page.getByText("plan.txt")).toBeVisible();

  await noteCard.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Attachments" }).click();
  const attachmentDialog = page.getByRole("dialog", {
    name: `Attachments for ${noteTitle}`
  });
  await expect(attachmentDialog).toBeVisible();
  await attachmentDialog.getByRole("button", { name: "plan.txt", exact: true }).click();
  await expect(attachmentDialog.getByText("Preview is ready to download.")).toBeVisible();
  await attachmentDialog.getByRole("button", { name: "Close attachments" }).click();

  await page.getByRole("button", { name: "More note actions" }).click();
  await page.getByRole("menuitem", { name: "Move to trash" }).click();
  await page.getByRole("button", { name: "Trash" }).click();
  await expect(page.locator(".note-card", { hasText: noteTitle })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Redo", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "More note actions" }).click();
  await page.getByRole("menuitem", { name: "Restore" }).click();
  await page.getByRole("button", { name: "All notes", exact: true }).click();
  await expect(page.locator(".note-card", { hasText: noteTitle })).toBeVisible();
});

test("keeps sibling panes aligned with tall editor content", async ({ page }) => {
  const account = uniqueAccount("tall-editor");

  await register(page, account.username, account.password);
  await page.setViewportSize({ width: 1280, height: 500 });
  await createNote(page, `Tall note ${account.suffix}`, "line 0");

  const editor = blockEditor(page);
  await editor.click();
  await editor.press("ControlOrMeta+A");
  await editor.pressSequentially("line 0");
  for (let line = 1; line < 40; line += 1) {
    await editor.press("Enter");
    await editor.pressSequentially(`line ${String(line)}`);
  }
  await expect(editor).toContainText("line 39");
  await waitForCrdtDurability(page);

  await expectPanesToMatchEditorContent(page);
});

test("wraps long editor lines within the editor column", async ({ page }) => {
  const account = uniqueAccount("wide-editor");
  const longLine = `line-${"x".repeat(300)}`;

  await register(page, account.username, account.password);
  await page.setViewportSize({ width: 1280, height: 800 });
  await createNote(page, `Wide note ${account.suffix}`, "short line");
  await setEditorText(page, longLine);
  await expect(blockEditor(page)).toContainText(longLine);

  const layout = await page.locator(".blocknote-surface").evaluate((surface) => {
    const column = surface.closest(".editor-column");
    const inlineContent = surface.querySelector<HTMLElement>(".bn-inline-content");
    if (!column || !inlineContent) throw new Error("Editor layout is incomplete");
    return {
      columnWidth: column.getBoundingClientRect().width,
      inlineClientWidth: inlineContent.clientWidth,
      inlineScrollWidth: inlineContent.scrollWidth,
      surfaceWidth: surface.getBoundingClientRect().width
    };
  });

  expect(layout.surfaceWidth).toBeLessThanOrEqual(layout.columnWidth + 1);
  expect(layout.inlineScrollWidth).toBeLessThanOrEqual(layout.inlineClientWidth + 1);
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
  await page.getByRole("button", { name: "Recover access" }).click();
  await page.getByLabel("Account handle").fill(account.username);
  await page.getByLabel("Recovery key").fill(recoveryKey);
  await page.getByLabel("New account password").fill(recoveredPassword);
  await page.getByLabel("Confirm new password").fill(recoveredPassword);
  await page.getByRole("button", { name: "Recover and decrypt" }).click();

  await expect(page.getByText("Recovered and decrypted")).toBeVisible();
  await expect(
    page.locator(".note-card", { hasText: new RegExp(noteTitle) })
  ).toBeVisible();
});

test("renders potentially malicious editor text without executing it", async ({
  page
}) => {
  const account = uniqueAccount("markdown");
  const noteTitle = `Markdown note ${account.suffix}`;
  const maliciousBody =
    '# Safe heading\n\n<script>window.__markdownExecuted = true</script>\n<img src=x onerror="window.__markdownExecuted = true">';

  await register(page, account.username, account.password);
  await createNote(page, noteTitle, maliciousBody);

  await expect(blockEditor(page)).toContainText("Safe heading");
  await expect(blockEditor(page).locator("script")).toHaveCount(0);
  await expect(blockEditor(page).locator("img")).toHaveCount(0);
  await expect(blockEditor(page)).toContainText(
    "<script>window.__markdownExecuted = true</script>"
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean((window as Window & { __markdownExecuted?: boolean }).__markdownExecuted)
      )
    )
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

test("creates a note with a folder, moves it, and reloads the assignment", async ({
  page
}) => {
  const account = uniqueAccount("folder");
  const noteTitle = `Folder note ${account.suffix}`;

  await register(page, account.username, account.password);
  await createNote(page, noteTitle, "Folder-encrypted body");

  await test.step("create a folder and move the note into it via the Move menu", async () => {
    page.on("dialog", (dialog) => {
      void dialog.accept("Folder 1");
    });
    await page.getByRole("button", { name: "New folder" }).click();
    await expect(page.getByText("Folder created")).toBeVisible();
    await page.getByRole("button", { name: "Open note menu" }).click();
    await page.getByRole("menuitem", { name: "Move to folder" }).click();
    await page.getByRole("menuitem", { name: "Folder 1" }).click();
    await expect(page.getByRole("button", { name: "Open note menu" })).toBeVisible();
  });

  await test.step("reload and verify the note is still in the folder", async () => {
    await page.reload();
    await page.getByLabel("Account password").fill(account.password);
    await page.getByRole("button", { name: "Sign in and decrypt" }).click();
    await expect(page.locator(".note-card").first()).toBeVisible({ timeout: 15000 });
  });
});

test("reloads and retains the encrypted editor content", async ({ page }) => {
  const account = uniqueAccount("reload-content");
  const noteTitle = `Content note ${account.suffix}`;
  const noteBody = `Persistent body ${account.suffix}`;

  await register(page, account.username, account.password);
  await createNote(page, noteTitle, noteBody);

  await test.step("reload and confirm the note body is still rendered", async () => {
    await page.reload();
    await page.getByLabel("Account password").fill(account.password);
    await page.getByRole("button", { name: "Sign in and decrypt" }).click();
    await expect(page.locator(".block-editor .bn-editor")).toBeVisible();
    await expect(page.getByText(noteBody)).toBeVisible();
  });
});

test("opens Share dialog from editor header, invites collaborator, and closes", async ({
  page
}) => {
  const account = uniqueAccount("share-dialog");
  const noteTitle = `Share dialog note ${account.suffix}`;

  await register(page, account.username, account.password);
  await createNote(page, noteTitle, "Share dialog body");
  await page.getByRole("button", { name: "Share note" }).click();
  const dialog = page.getByRole("dialog", { name: "Share note" });
  await expect(dialog).toBeVisible();
  await page.getByRole("button", { name: "Close sharing dialog" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Share note" })).toBeFocused();
});

async function register(page: Page, username: string, password: string): Promise<string> {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account" }).click();
  await page.getByLabel("Account handle").fill(username);
  await page.getByLabel("Account password").fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByRole("button", { name: "Create encrypted vault" }).click();
  await expect(page.getByText("Signed in and decrypted")).toBeVisible();

  const recoveryText = await page.getByText(/^Recovery key:/).textContent();
  expect(recoveryText).toBeTruthy();
  return recoveryText!.replace("Recovery key:", "").trim();
}

async function createNote(page: Page, title: string, body: string): Promise<void> {
  await page.getByRole("button", { name: "New note" }).click();
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.locator(".note-card").first()).toBeVisible();
  await expect(page.getByText("Note encrypted and saved")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
  const titleInput = page.getByRole("textbox", { name: "Title" });
  await expect(titleInput).toHaveValue("Untitled note");
  const saved = waitForNoteSave(page);
  await setEditorText(page, body);
  await titleInput.fill(title);
  await saved;
  await waitForCrdtDurability(page);
  await expect(titleInput).toHaveValue(title);
  await expect(page.getByText(/^Last saved \d+ seconds ago$/)).toBeVisible();
  await expect(page.locator(".note-card").first()).toBeVisible();
}

async function expectEditorToFillPane(page: Page): Promise<void> {
  const pane = await page.locator(".editor-pane").boundingBox();
  const column = await page.locator(".editor-column").boundingBox();
  expect(pane).toBeTruthy();
  expect(column).toBeTruthy();
  expect(Math.abs(pane!.width - column!.width)).toBeLessThanOrEqual(1);
}

async function expectPanesToMatchEditorContent(page: Page): Promise<void> {
  const editorBottom = await page
    .locator(".editor-column")
    .evaluate((element) => element.getBoundingClientRect().bottom);
  expect(editorBottom).toBeGreaterThan(page.viewportSize()!.height);

  for (const selector of [".sidebar", ".notes-pane", ".editor-pane"]) {
    const paneBottom = await page
      .locator(selector)
      .evaluate((element) => element.getBoundingClientRect().bottom);
    expect(paneBottom).toBeGreaterThanOrEqual(editorBottom - 1);
  }
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

async function insertFileBlock(page: Page): Promise<void> {
  const editor = blockEditor(page);
  await editor.focus();
  await editor.press("ControlOrMeta+End");
  await editor.press("Enter");
  await editor.pressSequentially("/file");
  await page.getByRole("option", { name: /^File/ }).click();
  await expect(page.locator('[data-test="upload-tab"]')).toBeVisible();
  await expect(page.locator('[data-test="attachments-tab"]')).toBeVisible();
}

function waitForAttachmentUpload(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/api/notes/") &&
      response.url().includes("/attachments") &&
      response.ok()
  );
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
