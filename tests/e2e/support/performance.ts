import { Buffer } from "node:buffer";
import {
  expect,
  type Browser,
  type BrowserContext,
  type Page,
  type Request,
  type Route
} from "@playwright/test";
import { requiresContentTransfer } from "../../../apps/client/src/realtime/crdt.js";
import { editableEditor } from "./editor.js";

export const MIB = 1024 * 1024;
export const REPRESENTATIVE_DOCUMENT = {
  documentBytes: 4 * MIB
} as const;

const CONTENT_COMMIT = /\/api\/content\/uploads\/[^/]+\/commit$/u;
const CONTENT_DOWNLOAD = /\/api\/content\/manifests\/[^/]+\/chunks\/\d+$/u;
const GENERATED_EDIT_MAX_BYTES = MIB;

export interface PerformanceAccount {
  password: string;
  suffix: string;
  username: string;
}

export interface RepresentativeDocumentProfile {
  documentBytes: number;
}

export interface RepresentativeDocumentDataset {
  contentScopeId: string;
  marker: string;
  noteId: string;
}

export interface DocumentTrafficCapture {
  chunkDownloads: string[];
  historyScopeIds: string[];
  subscribedScopeIds: string[];
  stop(): void;
}

export function representativeDocumentProfileFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): RepresentativeDocumentProfile {
  return {
    documentBytes: positiveInteger(
      environment.FORTNOTE_DOCUMENT_BYTES,
      REPRESENTATIVE_DOCUMENT.documentBytes
    )
  };
}

export function uniquePerformanceAccount(prefix: string): PerformanceAccount {
  const suffix = crypto.randomUUID().slice(0, 8);
  return {
    password: `Fortnote-${suffix}-password`,
    suffix,
    username: `${prefix}-${suffix}`
  };
}

export async function newPerformancePage(
  browser: Browser,
  baseURL: string | undefined,
  contexts: BrowserContext[]
): Promise<Page> {
  const context = await browser.newContext({ baseURL });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  contexts.push(context);
  return context.newPage();
}

export async function closePerformanceContexts(
  contexts: BrowserContext[]
): Promise<void> {
  await Promise.all(contexts.splice(0).map(async (context) => context.close()));
}

export async function registerPerformanceUser(
  page: Page,
  account: PerformanceAccount
): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account" }).click();
  await page.getByLabel("Account handle").fill(account.username);
  await page.getByLabel("Account password").fill(account.password);
  await page.getByLabel("Confirm password").fill(account.password);
  await page.getByRole("button", { name: "Create encrypted vault" }).click();
  // Vault unlock runs Argon2id and loads keys, folders, and notes.
  await expect(page.getByText("Signed in and decrypted")).toBeVisible({
    timeout: 30_000
  });
  await expect(page.getByText("Sync connected")).toBeVisible({ timeout: 30_000 });
  await waitForSharingKey(page);
}

export async function signInPerformanceUser(
  page: Page,
  account: PerformanceAccount
): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Account handle").fill(account.username);
  await page.getByLabel("Account password").fill(account.password);
  await page.getByRole("button", { name: "Sign in and decrypt" }).click();
  // Vault unlock runs Argon2id and loads keys, folders, and notes.
  await expect(page.getByText("Signed in and decrypted")).toBeVisible({
    timeout: 30_000
  });
  await expect(page.getByText("Sync connected")).toBeVisible({ timeout: 30_000 });
}

export function captureJsonControlRequests(page: Page) {
  const bodies: Buffer[] = [];
  const listener = (request: Request) => {
    const contentType = request.headers()["content-type"] ?? "";
    const body = request.postDataBuffer();
    if (body && contentType.includes("application/json")) {
      bodies.push(body);
    }
  };
  page.on("request", listener);
  return {
    bodies,
    stop() {
      page.off("request", listener);
    }
  };
}

export async function createRepresentativeDocument(
  page: Page,
  title: string,
  profile: RepresentativeDocumentProfile
): Promise<RepresentativeDocumentDataset> {
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/notes" &&
      response.ok()
  );
  await page.getByRole("button", { name: "New note" }).click();
  await page
    .getByRole("dialog", { name: "New note" })
    .getByRole("button", { name: "Create" })
    .click();
  const note = (await (await created).json()) as {
    id: string;
    rootSectionId: string | null;
  };
  if (!note.rootSectionId) {
    throw new Error("New focused document did not receive a content scope");
  }

  const titleInput = page.getByRole("textbox", { name: "Title" });
  await expect(titleInput).toHaveValue("Untitled note", { timeout: 30_000 });
  await expect(blockEditor(page)).toBeVisible({ timeout: 30_000 });
  const titleSaved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      new URL(response.url()).pathname === `/api/notes/${note.id}` &&
      response.ok(),
    { timeout: 30_000 }
  );
  await titleInput.fill(title);
  await titleSaved;
  await expect(page.getByRole("button", { name: titlePattern(title) })).toBeVisible();

  const marker = `focused-document-${crypto.randomUUID()}`;
  await replaceEditorWithGeneratedText(page, profile.documentBytes, `${marker} `);
  return { contentScopeId: note.rootSectionId, marker, noteId: note.id };
}

export async function shareDocument(
  page: Page,
  username: string,
  role: "editor" | "viewer" = "editor"
): Promise<void> {
  await page.getByRole("button", { name: "Share note" }).click();
  const dialog = page.getByRole("dialog", { name: "Share note" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Collaborator username").fill(username);
  await dialog.getByLabel("Collaborator role").selectOption(role);
  await dialog.getByRole("button", { name: "Share note" }).click();

  const member = dialog.locator(".membership-list li", { hasText: username });
  const trust = dialog.getByRole("checkbox", {
    name: "I independently verified this exact key"
  });
  await expect(trust.or(member)).toBeVisible({ timeout: 30_000 });
  if (await trust.isVisible()) {
    await trust.check();
    await dialog.getByRole("button", { name: "Trust key" }).click();
  }
  await expect(member).toContainText(role, { timeout: 30_000 });
  await dialog.getByRole("button", { name: "Close sharing dialog" }).click();
  await expect(dialog).not.toBeVisible();
}

export async function openDocument(
  page: Page,
  title: string,
  marker?: string
): Promise<void> {
  const card = page.getByRole("button", { name: titlePattern(title) });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.click();
  await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue(
    titlePattern(title)
  );
  await expect(blockEditor(page)).toBeVisible({ timeout: 30_000 });
  if (marker) {
    await expect(blockEditor(page)).toContainText(marker, { timeout: 30_000 });
  }
}

export function captureDocumentTraffic(
  page: Page,
  noteId: string
): DocumentTrafficCapture {
  const historyScopeIds: string[] = [];
  const chunkDownloads: string[] = [];
  const subscribedScopeIds: string[] = [];
  const historyPattern = new RegExp(
    `/api/notes/${escapeRegExp(noteId)}/sections/([^/]+)/history$`,
    "u"
  );
  const listener = (request: Request) => {
    const url = new URL(request.url());
    const history = historyPattern.exec(url.pathname);
    if (history?.[1]) {
      historyScopeIds.push(decodeURIComponent(history[1]));
    }
    if (request.method() === "GET" && CONTENT_DOWNLOAD.test(url.pathname)) {
      chunkDownloads.push(url.pathname);
    }
  };
  page.on("request", listener);
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      if (typeof payload !== "string") return;
      try {
        const message = JSON.parse(payload) as {
          noteId?: string;
          sectionId?: string;
          type?: string;
        };
        if (
          message.type === "crdt-subscribe" &&
          message.noteId === noteId &&
          typeof message.sectionId === "string"
        ) {
          subscribedScopeIds.push(message.sectionId);
        }
      } catch {
        // Binary and non-control frames are irrelevant to content residency.
      }
    });
  });
  return {
    chunkDownloads,
    historyScopeIds,
    subscribedScopeIds,
    stop() {
      page.off("request", listener);
    }
  };
}

export async function expectBoundedColdOpen(
  page: Page,
  dataset: RepresentativeDocumentDataset,
  traffic: DocumentTrafficCapture
): Promise<void> {
  await expect(blockEditor(page)).toContainText(dataset.marker, { timeout: 30_000 });
  const allowed = new Set(["root", dataset.contentScopeId]);
  expect(
    [...new Set(traffic.historyScopeIds)].every((scopeId) => allowed.has(scopeId))
  ).toBe(true);
  expect(
    [...new Set(traffic.subscribedScopeIds)].every((scopeId) => allowed.has(scopeId))
  ).toBe(true);
  expect(traffic.subscribedScopeIds).toContain(dataset.contentScopeId);
  const cachedScopeIds = await readCachedContentScopeIds(page, dataset.noteId);
  expect(cachedScopeIds.every((scopeId) => allowed.has(scopeId))).toBe(true);
}

export async function countCachedDocumentScopes(
  page: Page,
  noteId: string
): Promise<number> {
  return new Set(await readCachedContentScopeIds(page, noteId)).size;
}

export async function appendWithRecoverableChunkFault(
  page: Page,
  account: PerformanceAccount,
  title: string,
  mode: "interrupt" | "corrupt"
): Promise<string> {
  const marker = `${mode}-${crypto.randomUUID()}`;
  let resolveHit!: () => void;
  const hit = new Promise<void>((resolve) => {
    resolveHit = resolve;
  });
  let injected = false;
  const handler = async (route: Route) => {
    if (injected || route.request().method() !== "PUT") {
      await route.continue();
      return;
    }
    injected = true;
    resolveHit();
    if (mode === "interrupt") {
      await route.abort("connectionreset");
      return;
    }
    const body = route.request().postDataBuffer();
    if (!body || body.length === 0) {
      await route.abort("failed");
      return;
    }
    const corrupted = Buffer.from(body);
    corrupted[0] = corrupted[0] ^ 0xff;
    await route.continue({ postData: corrupted });
  };
  await page.route("**/api/content/uploads/*/chunks/*", handler);
  await appendGeneratedEditorText(page, MIB / 2, `${marker} `);
  await hit;
  await page.unroute("**/api/content/uploads/*/chunks/*", handler);

  const committed = page.waitForResponse(isSuccessfulContentCommit, { timeout: 120_000 });
  await signInPerformanceUser(page, account);
  await openDocument(page, title);
  await committed;
  await expect(blockEditor(page)).toContainText(marker, { timeout: 60_000 });
  return marker;
}

export async function exerciseServerQuotaPressure(
  page: Page,
  account: PerformanceAccount,
  title: string
): Promise<string> {
  const marker = `quota-${crypto.randomUUID()}`;
  let resolveHit!: () => void;
  const hit = new Promise<void>((resolve) => {
    resolveHit = resolve;
  });
  const handler = async (route: Route) => {
    resolveHit();
    await route.fulfill({
      status: 507,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "storage_limit",
          message: "Encrypted storage quota reached",
          requestId: crypto.randomUUID()
        }
      })
    });
  };
  await page.route("**/api/content/uploads", handler);
  await appendGeneratedEditorText(page, MIB / 2, `${marker} `);
  await hit;
  await expect(blockEditor(page)).toContainText(marker);
  await expect(page.locator(".pane-error")).toContainText(
    "Encrypted changes remain on this device until server storage is available.",
    { timeout: 30_000 }
  );
  await page.unroute("**/api/content/uploads", handler);

  const committed = page.waitForResponse(isSuccessfulContentCommit, { timeout: 120_000 });
  await signInPerformanceUser(page, account);
  await openDocument(page, title);
  await committed;
  await expect(blockEditor(page)).toContainText(marker, { timeout: 60_000 });
  return marker;
}

export async function exerciseIndependentOfflineEdits(input: {
  ownerPage: Page;
  collaboratorPage: Page;
}): Promise<void> {
  const ownerMarker = `owner-independent-${crypto.randomUUID()}`;
  const collaboratorMarker = `offline-independent-${crypto.randomUUID()}`;
  await input.collaboratorPage.context().setOffline(true);
  await appendSmallEditorText(input.collaboratorPage, collaboratorMarker);
  await appendSmallEditorText(input.ownerPage, ownerMarker);
  await expect(blockEditor(input.ownerPage)).not.toContainText(collaboratorMarker);

  await input.collaboratorPage.context().setOffline(false);
  await expect(input.collaboratorPage.locator(".sync-pill")).toContainText(
    "Sync connected",
    {
      timeout: 30_000
    }
  );
  await expect(blockEditor(input.ownerPage)).toContainText(collaboratorMarker, {
    timeout: 60_000
  });
  await expect(blockEditor(input.collaboratorPage)).toContainText(ownerMarker, {
    timeout: 60_000
  });
}

export async function expectStoredLogicalSize(
  page: Page,
  minimumBytes: number
): Promise<void> {
  const quota = await page.evaluate(async () => {
    const response = await fetch("/api/content/quota", { credentials: "include" });
    if (!response.ok) throw new Error("Storage quota could not be inspected");
    return (await response.json()) as { usedBytes: number };
  });
  expect(quota.usedBytes).toBeGreaterThanOrEqual(minimumBytes);
}

async function replaceEditorWithGeneratedText(
  page: Page,
  bytes: number,
  prefix: string
): Promise<void> {
  let remaining = bytes;
  let first = true;
  while (remaining > 0) {
    const chunkBytes = Math.min(remaining, GENERATED_EDIT_MAX_BYTES);
    const chunkPrefix = first ? prefix : "";
    const committed = requiresContentTransfer(chunkBytes)
      ? page.waitForResponse(isSuccessfulContentCommit, { timeout: 120_000 })
      : null;
    await injectGeneratedEditorText(page, chunkBytes, chunkPrefix, first);
    if (committed) {
      await committed;
    } else {
      await expect(page.locator(".collaboration-status")).toContainText(
        "Saved and synchronized",
        { timeout: 30_000 }
      );
    }
    remaining -= chunkBytes;
    first = false;
  }
  await expect(blockEditor(page)).toContainText(prefix.trim(), { timeout: 30_000 });
}

async function appendGeneratedEditorText(
  page: Page,
  bytes: number,
  prefix: string
): Promise<void> {
  await injectGeneratedEditorText(page, bytes, prefix, false);
}

async function injectGeneratedEditorText(
  page: Page,
  bytes: number,
  prefix: string,
  replace: boolean
): Promise<void> {
  if (!Number.isSafeInteger(bytes) || bytes < prefix.length) {
    throw new Error("Generated editor text size is invalid");
  }
  await (await editableEditor(page)).focus();
  const inserted = await page.evaluate(
    ({ byteLength, textPrefix, replaceExisting }) => {
      const editor = document.querySelector<HTMLElement>(".block-editor .bn-editor");
      const selection = window.getSelection();
      if (!editor || !selection) return false;
      const range = document.createRange();
      range.selectNodeContents(editor);
      if (!replaceExisting) range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      // Ordinary words keep line breaking linear; one long unbroken run makes
      // every keystroke re-wrap the whole paragraph.
      const words = "lorem ipsum dolor sit amet ".repeat(
        Math.ceil((byteLength - textPrefix.length) / 27)
      );
      const text = textPrefix + words.slice(0, byteLength - textPrefix.length);
      // Chromium still exposes this command; it drives the real contenteditable input path.
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      return document.execCommand("insertText", false, text);
    },
    { byteLength: bytes, textPrefix: prefix, replaceExisting: replace }
  );
  expect(inserted).toBe(true);
}

async function appendSmallEditorText(page: Page, text: string): Promise<void> {
  const editor = await editableEditor(page);
  await editor.focus();
  await editor.press("ControlOrMeta+End");
  await editor.pressSequentially(` ${text}`);
  await expect(editor).toContainText(text);
}

async function readCachedContentScopeIds(page: Page, noteId: string): Promise<string[]> {
  return page.evaluate(
    async (id) =>
      await new Promise<string[]>((resolve, reject) => {
        const request = indexedDB.open("fortnote-protected");
        request.onerror = () => {
          reject(request.error ?? new Error("Protected cache could not be opened"));
        };
        request.onsuccess = () => {
          const database = request.result;
          const records = database
            .transaction("sectionCache", "readonly")
            .objectStore("sectionCache")
            .getAll();
          records.onerror = () => {
            database.close();
            reject(records.error ?? new Error("Protected cache could not be read"));
          };
          records.onsuccess = () => {
            const scopeIds = (records.result as { noteId: string; sectionId: string }[])
              .filter((record) => record.noteId === id)
              .map((record) => record.sectionId);
            database.close();
            resolve(scopeIds);
          };
        };
      }),
    noteId
  );
}

async function waitForSharingKey(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const response = await fetch("/api/sharing-keys/current", {
            credentials: "include"
          });
          return response.ok;
        }),
      { timeout: 30_000 }
    )
    .toBe(true);
}

function isSuccessfulContentCommit(response: {
  request(): Request;
  url(): string;
  ok(): boolean;
}) {
  return (
    response.request().method() === "POST" &&
    CONTENT_COMMIT.test(new URL(response.url()).pathname) &&
    response.ok()
  );
}

function blockEditor(page: Page) {
  return page.locator(".block-editor .bn-editor");
}

function titlePattern(title: string): RegExp {
  return new RegExp(escapeRegExp(title), "u");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("Document profile values must be positive integers");
  }
  return parsed;
}
