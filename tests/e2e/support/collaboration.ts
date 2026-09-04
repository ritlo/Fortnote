import { Buffer } from "node:buffer";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { decodeCrdtBinaryFrame } from "../../../packages/shared/src/index.js";
import {
  expect,
  type Browser,
  type BrowserContext,
  type Page,
  type Response
} from "@playwright/test";
import { waitForCrdtDurability } from "./durability.js";

export interface Account {
  password: string;
  suffix: string;
  username: string;
}

export async function newUserPage(
  browser: Browser,
  baseURL: string | undefined,
  contexts: BrowserContext[]
): Promise<Page> {
  const context = await browser.newContext({ baseURL });
  contexts.push(context);
  return context.newPage();
}

export async function closePageContext(page: Page, contexts: BrowserContext[]): Promise<void> {
  const context = page.context();
  await context.close();
  const index = contexts.indexOf(context);
  if (index >= 0) {
    contexts.splice(index, 1);
  }
}

export async function closeContexts(contexts: BrowserContext[]): Promise<void> {
  await Promise.all(
    contexts.splice(0).map((context) => context.close().catch(() => undefined))
  );
}

export async function dropFirstDurableAck(
  page: Page,
  state: {
    alreadyPresent: number;
    armed: boolean;
    dropped: number;
    targetSends: number;
    targetUpdateId: string | null;
  }
): Promise<void> {
  await page.routeWebSocket(/\/api\/realtime/, (pageSocket) => {
    const serverSocket = pageSocket.connectToServer();
    pageSocket.onMessage((message) => {
      if (state.armed && !state.targetUpdateId && typeof message !== "string") {
        try {
          state.targetUpdateId = decodeCrdtBinaryFrame(
            Uint8Array.from(message),
            256 * 1024
          ).header.updateId;
        } catch {
          // Non-CRDT binary messages remain transparent to the proxy.
        }
      }
      if (state.targetUpdateId && typeof message !== "string") {
        try {
          const updateId = decodeCrdtBinaryFrame(
            Uint8Array.from(message),
            256 * 1024
          ).header.updateId;
          if (updateId === state.targetUpdateId) {
            state.targetSends += 1;
          }
        } catch {
          // Non-CRDT binary messages remain transparent to the proxy.
        }
      }
      serverSocket.send(message);
    });
    serverSocket.onMessage((message) => {
      const controlMessage = typeof message === "string"
        ? message
        : message[0] === 0x7b
          ? message.toString("utf8")
          : null;
      if (controlMessage) {
        try {
          const controlText: string = controlMessage;
          const parsed = JSON.parse(controlText) as {
            result?: string;
            serverSequence?: number;
            type?: string;
            updateId?: string;
          };
          if (
            parsed.type === "crdt-ack" &&
            typeof parsed.serverSequence === "number" &&
            parsed.updateId === state.targetUpdateId
          ) {
            if (state.dropped === 0) {
              state.dropped += 1;
              return;
            }
            if (parsed.result === "already-present") {
              state.alreadyPresent += 1;
            }
          }
        } catch {
          // Non-control text frames are forwarded unchanged.
        }
      }
      pageSocket.send(message);
    });
  });
}

export async function restartManagedE2eServer(): Promise<boolean> {
  const statePath = resolve("data/e2e-server.state");
  const restartPath = resolve("data/e2e-server.restart");
  let supervisorPid: number;
  try {
    const state = (await readFile(statePath, "utf8")).trim();
    supervisorPid = Number(state.split(":").at(-1));
    process.kill(supervisorPid, 0);
  } catch {
    return false;
  }
  const token = crypto.randomUUID();
  await writeFile(restartPath, token, "utf8");
  await expect.poll(async () => {
    try {
      const state: string = await readFile(statePath, "utf8");
      return state.trim();
    } catch {
      return "";
    }
  }, { timeout: 45_000 }).toBe(`ready:${token}:${String(supervisorPid)}`);
  return true;
}

export async function register(page: Page, username: string, password: string): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account" }).click();
  await page.getByLabel("Account handle").fill(username);
  await page.getByLabel("Account password").fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByRole("button", { name: "Create encrypted vault" }).click();
  await expect(page.getByText("Signed in and decrypted")).toBeVisible();
}

export async function signIn(page: Page, username: string, password: string): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Account handle").fill(username);
  await page.getByLabel("Account password").fill(password);
  await page.getByRole("button", { name: "Sign in and decrypt" }).click();
  await expect(page.getByText("Signed in and decrypted")).toBeVisible();
}

export async function waitForSharingKey(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const response = await fetch("/api/sharing-keys/current", {
            credentials: "include"
          });
          return response.ok;
        }),
      { timeout: 10_000 }
    )
    .toBe(true);
}

export async function readOwnSharingFingerprint(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const fingerprint = page.locator(".sharing-fingerprint code");
  await expect(fingerprint).toBeVisible();
  const value = (await fingerprint.innerText()).trim();
  expect(value).toMatch(/^(?:[0-9A-F]{4} ){7}[0-9A-F]{4}$/);
  await page.getByRole("button", { name: "All notes", exact: true }).click();
  return value;
}

export async function createNote(page: Page, title: string, body: string): Promise<void> {
  await page.getByRole("button", { name: "New note" }).click();
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.locator(".note-card").first()).toBeVisible();
  await expect(page.getByText("Note encrypted and saved")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
  const titleInput = page.getByRole("textbox", { name: "Title" });
  await expect(titleInput).toHaveValue("Untitled note");
  const titleSaved = waitForNoteSave(page);
  await setEditorText(page, body);
  await titleInput.fill(title);
  await titleSaved;
  await waitForCrdtDurability(page);
  await expect(titleInput).toHaveValue(title);
  await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
  await expect(page.getByText(/^Last saved \d+ seconds ago$/)).toBeVisible();
  await expect(page.getByRole("button", { name: noteTitlePattern(title) }).first()).toBeVisible();
}

export async function shareNote(
  page: Page,
  username: string,
  role: "editor" | "viewer",
  expectedFingerprint?: string
): Promise<void> {
  await pageAttemptShare(page, username, role);
  const trustButton = page.getByRole("button", { name: "Trust key" });
  await trustButton
    .waitFor({ state: "visible", timeout: 5_000 })
    .then(async () => {
      if (expectedFingerprint) {
        await expect(page.locator(".trust-confirmation code")).toHaveText(
          expectedFingerprint
        );
      }
      await page.getByLabel("I independently verified this exact key").check();
      await trustButton.click();
    })
    .catch(() => undefined);
  await expect(page.getByText("Note shared")).toBeVisible();
  await expect(page.locator(".membership-list li", { hasText: username })).toBeVisible();
  await closeShareDialog(page);
}

export async function openShareDialog(page: Page): Promise<import("@playwright/test").Locator> {
  const dialog = page.getByRole("dialog", { name: "Share note" });
  if (!(await dialog.isVisible())) {
    await page.getByRole("button", { name: "Share note" }).click();
    await expect(dialog).toBeVisible();
  }
  return dialog;
}

export async function closeShareDialog(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Share note" });
  if (await dialog.isVisible()) {
    await page.getByRole("button", { name: "Close sharing dialog" }).click();
    await expect(dialog).not.toBeVisible();
  }
}

export async function pageAttemptShare(
  page: Page,
  username: string,
  role: "editor" | "viewer"
): Promise<void> {
  const dialog = await openShareDialog(page);
  await dialog.getByLabel("Collaborator username").fill(username);
  await dialog.getByLabel("Collaborator role").selectOption(role);
  const shared = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/memberships") &&
      response.ok()
  );
  await dialog.getByRole("button", { name: "Share note" }).click();
  await Promise.race([
    shared.catch(() => undefined),
    page.getByRole("button", { name: "Trust key" }).waitFor({ state: "visible" }),
    page.getByText("Share blocked").waitFor({ state: "visible" })
  ]);
}

export async function revokeMember(
  page: Page,
  username: string,
  expectSuccess = true
): Promise<void> {
  await openShareDialog(page);
  const revoked = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/key-rotation")
  );
  page.once("dialog", (dialog) => {
    void dialog.accept();
  });
  await page
    .locator(".membership-list li", { hasText: username })
    .getByRole("button", { name: "Revoke" })
    .click();
  const response = await revoked;
  expect(response.ok()).toBe(expectSuccess);
  if (expectSuccess) {
    await expect(page.getByText("Collaborator revoked and keys rotated")).toBeVisible();
  }
}

export async function changeMemberRole(
  page: Page,
  username: string,
  role: "editor" | "viewer"
): Promise<void> {
  await openShareDialog(page);
  const updated = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      response.url().includes("/memberships/") &&
      response.ok()
  );
  await page.getByLabel(`Role for ${username}`).selectOption(role);
  await updated;
  await expect(page.getByText("Collaborator role updated")).toBeVisible();
  await expect(page.getByLabel(`Role for ${username}`)).toHaveValue(role);
}

export async function openNote(page: Page, title: string): Promise<void> {
  const pattern = new RegExp(`^${escapeRegExp(title)}`);
  await expect(page.getByRole("button", { name: pattern })).toBeVisible({
    timeout: 10_000
  });
  await page.getByRole("button", { name: pattern }).click();
}

export async function editSelectedNote(page: Page, body: string): Promise<void> {
  await setEditorText(page, body);
  await waitForCrdtDurability(page);
}

export function blockEditor(page: Page) {
  return page.locator(".block-editor .bn-editor");
}

export async function editorText(page: Page): Promise<string> {
  return (await blockEditor(page).innerText()).trim();
}

export async function setEditorText(page: Page, body: string): Promise<void> {
  const editor = blockEditor(page);
  await expect(editor).toBeVisible();
  await editor.click();
  await editor.press("ControlOrMeta+A");
  await editor.pressSequentially(body);
}

export function captureRealtimeFrames(
  page: Page,
  frames: string[],
  state?: { closes: number }
): void {
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => frames.push(String(payload)));
    socket.on("framereceived", ({ payload }) => frames.push(String(payload)));
    socket.on("close", () => {
      if (state) {
        state.closes += 1;
      }
    });
  });
}

export interface ApiTraffic {
  attachmentUploads: number;
  requestBodies: Buffer[];
  responseBodies: Promise<Buffer>[];
}

export function captureApiTraffic(page: Page, existing?: ApiTraffic): ApiTraffic {
  const traffic: ApiTraffic = existing ?? {
      attachmentUploads: 0,
      requestBodies: [],
      responseBodies: []
    };
  page.on("request", (request) => {
    if (!isMediaApiUrl(request.url())) {
      return;
    }
    const body = request.postDataBuffer();
    if (body) {
      traffic.requestBodies.push(body);
    }
    if (
      request.method() === "POST" &&
      request.url().includes("/api/notes/") &&
      request.url().includes("/attachments")
    ) {
      traffic.attachmentUploads += 1;
    }
  });
  page.on("response", (response) => {
    if (isMediaApiUrl(response.url())) {
      traffic.responseBodies.push(readResponseBody(response));
    }
  });
  return traffic;
}

export async function readResponseBody(response: Response): Promise<Buffer> {
  try {
    return Buffer.from(await response.body());
  } catch {
    return Buffer.alloc(0);
  }
}

export function isMediaApiUrl(url: string): boolean {
  return url.includes("/api/notes/") || url.includes("/api/attachments/");
}

export async function insertImageBlock(page: Page): Promise<void> {
  const editor = blockEditor(page);
  await editor.focus();
  await editor.press("ControlOrMeta+End");
  await editor.press("Enter");
  await editor.pressSequentially("/image");
  await page.getByRole("option", { name: /^Image/ }).click();
  await expect(page.locator('[data-test="upload-tab"]')).toBeVisible();
  await expect(page.locator('[data-test="attachments-tab"]')).toBeVisible();
}

export async function reloadAndUnlock(page: Page, password: string): Promise<void> {
  await page.reload();
  await page.getByLabel("Account password").fill(password);
  await page.getByRole("button", { name: "Sign in and decrypt" }).click();
  await expect(page.getByText("Signed in and decrypted")).toBeVisible();
}

export function waitForAttachmentUpload(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/api/notes/") &&
      response.url().includes("/attachments") &&
      response.ok()
  );
}

export function readStoredMedia(ownerUsername: string): {
  attachmentId: string;
  databasePayload: string;
  filePath: string;
} {
  const database = new DatabaseSync(resolve("apps/server/data/e2e.sqlite"), {
    readOnly: true,
    timeout: 5_000
  });
  try {
    const row = database
      .prepare(
	        `SELECT a.id AS id,
	                a.note_id AS noteId,
	                a.file_cipher_path AS fileCipherPath,
	                a.filename,
	                a.mime_type AS mimeType,
	                a.metadata_cipher AS metadataCipher,
	                n.title,
	                n.title_cipher AS titleCipher,
	                n.content_cipher AS contentCipher
	         FROM attachments a
	         JOIN notes n ON n.id = a.note_id
	         JOIN users u ON u.id = n.user_id
	         WHERE u.username = ?
	         ORDER BY a.created_at DESC
	         LIMIT 1`
	      )
	      .get(ownerUsername) as
	      | {
	          contentCipher: string;
	          fileCipherPath: string;
	          filename: string;
	          id: string;
	          metadataCipher: string | null;
	          mimeType: string;
	          noteId: string;
	          title: string;
	          titleCipher: string | null;
	        }
	      | undefined;
	    if (!row) {
	      throw new Error(`Stored media not found for: ${ownerUsername}`);
	    }
    const updates = database
      .prepare("SELECT cipher FROM note_updates WHERE note_id = ?")
      .all(row.noteId) as { cipher: string }[];
	    return {
	      attachmentId: row.id,
	      databasePayload: JSON.stringify([
	        row,
	        ...updates.map((update) => update.cipher)
	      ]),
      filePath: resolve("apps/server/data/e2e-attachments", row.fileCipherPath)
    };
  } finally {
    database.close();
  }
}

export function readStoredCollaboration(ownerUsername: string): {
  attachmentPath: string | null;
  databasePayload: string;
} {
  const database = new DatabaseSync(resolve("apps/server/data/e2e.sqlite"), {
    readOnly: true,
    timeout: 5_000
  });
  try {
    const note = database
      .prepare(
        `SELECT n.id, n.title, n.title_cipher AS titleCipher,
                n.content_cipher AS contentCipher, n.encrypted_note_key AS encryptedNoteKey,
                n.key_epoch AS keyEpoch
         FROM notes n
         JOIN users u ON u.id = n.user_id
         WHERE u.username = ?
         ORDER BY n.created_at DESC
         LIMIT 1`
      )
      .get(ownerUsername) as Record<string, unknown> | undefined;
    if (!note || typeof note.id !== "string") {
      throw new Error(`Stored collaboration note not found for: ${ownerUsername}`);
    }
    const attachment = database
      .prepare(
        `SELECT filename, mime_type AS mimeType, metadata_cipher AS metadataCipher,
                encrypted_attachment_key AS encryptedAttachmentKey,
                file_cipher_path AS fileCipherPath
         FROM attachments
         WHERE note_id = ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(note.id) as
      | {
          fileCipherPath: string;
          [key: string]: unknown;
        }
      | undefined;
    const updates = database
      .prepare(
        `SELECT cipher, nonce, key_epoch AS keyEpoch, kind
         FROM note_updates
         WHERE note_id = ?`
      )
      .all(note.id);
    const shares = database
      .prepare(
        `SELECT encrypted_note_key AS encryptedNoteKey, format_version AS formatVersion
         FROM note_key_shares
         WHERE note_id = ?`
      )
      .all(note.id);
    return {
      attachmentPath: attachment
        ? resolve("apps/server/data/e2e-attachments", attachment.fileCipherPath)
        : null,
      databasePayload: JSON.stringify({ attachment, note, shares, updates })
    };
  } finally {
    database.close();
  }
}

export async function waitForNoteSave(page: Page) {
  const response = await page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().includes("/api/notes/") &&
      response.ok()
  );
  await expect(page.locator(".status-pill")).toHaveText("Ready");
  return response;
}

export async function lookupPublicSharingKey(page: Page, username: string): Promise<PublicSharingKey> {
  return page.evaluate(async (targetUsername) => {
    const response = await fetch(
      `/api/sharing-keys/lookup?username=${encodeURIComponent(targetUsername)}`,
      { credentials: "include" }
    );
    if (!response.ok) {
      throw new Error(`Unable to look up sharing key for ${targetUsername}`);
    }
    return (await response.json()) as PublicSharingKey;
  }, username);
}

export interface PublicSharingKey {
  userId: string;
  username: string;
  sharingKeyVersion: number;
  publicKey: string;
  formatVersion: number;
  createdAt: string;
}

export function noteTitlePattern(title: string): RegExp {
  return new RegExp(escapeRegExp(title));
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function uniqueAccount(prefix: string): Account {
  const suffix = `${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
  return {
    suffix,
    username: `${prefix}-${suffix}`,
    password: `password-${suffix}`
  };
}
