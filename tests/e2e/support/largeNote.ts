import { Buffer } from "node:buffer";
import {
  expect,
  type Browser,
  type BrowserContext,
  type Page,
  type Request,
  type Route
} from "@playwright/test";

export const MIB = 1024 * 1024;
export const REPRESENTATIVE_LARGE_NOTE = {
  activeSectionBytes: 4 * MIB,
  logicalBytes: 100 * MIB,
  sectionCount: 100
} as const;

const CONTENT_COMMIT = /\/api\/content\/uploads\/[^/]+\/commit$/u;
const CONTENT_DOWNLOAD = /\/api\/content\/manifests\/[^/]+\/chunks\/\d+$/u;
const GENERATED_EDIT_MAX_BYTES = MIB;

export interface LargeNoteAccount {
  password: string;
  suffix: string;
  username: string;
}

export interface LargeNoteProfile {
  activeSectionBytes: number;
  logicalBytes: number;
  sectionCount: number;
}

export interface LargeNoteDataset {
  activeMarker: string;
  distantMarker: string;
  noteId: string;
  sectionIds: string[];
}

export interface SectionTrafficCapture {
  chunkDownloads: string[];
  historySectionIds: string[];
  subscribedSectionIds: string[];
  stop(): void;
}

export function largeNoteProfileFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): LargeNoteProfile {
  const sectionCount = positiveInteger(
    environment.FORTNOTE_LARGE_NOTE_SECTIONS,
    REPRESENTATIVE_LARGE_NOTE.sectionCount
  );
  const logicalBytes = positiveInteger(
    environment.FORTNOTE_LARGE_NOTE_BYTES,
    REPRESENTATIVE_LARGE_NOTE.logicalBytes
  );
  const activeSectionBytes = positiveInteger(
    environment.FORTNOTE_LARGE_NOTE_ACTIVE_BYTES,
    Math.min(REPRESENTATIVE_LARGE_NOTE.activeSectionBytes, logicalBytes)
  );
  if (sectionCount < 4 || logicalBytes < activeSectionBytes + sectionCount - 1) {
    throw new Error("Large-note profile needs at least four non-empty sections");
  }
  return { activeSectionBytes, logicalBytes, sectionCount };
}

export function uniqueLargeNoteAccount(prefix: string): LargeNoteAccount {
  const suffix = crypto.randomUUID().slice(0, 8);
  return {
    password: `Fortnote-${suffix}-password`,
    suffix,
    username: `${prefix}-${suffix}`
  };
}

export async function newLargeNotePage(
  browser: Browser,
  baseURL: string | undefined,
  contexts: BrowserContext[]
): Promise<Page> {
  const context = await browser.newContext({ baseURL });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  contexts.push(context);
  return context.newPage();
}

export async function closeLargeNoteContexts(contexts: BrowserContext[]): Promise<void> {
  await Promise.all(contexts.splice(0).map(async (context) => context.close()));
}

export async function closeLargeNotePage(
  page: Page,
  contexts: BrowserContext[]
): Promise<void> {
  const context = page.context();
  await context.close();
  const position = contexts.indexOf(context);
  if (position >= 0) {
    contexts.splice(position, 1);
  }
}

export async function registerLargeNoteUser(
  page: Page,
  account: LargeNoteAccount
): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account" }).click();
  await page.getByLabel("Account handle").fill(account.username);
  await page.getByLabel("Account password").fill(account.password);
  await page.getByLabel("Confirm password").fill(account.password);
  await page.getByRole("button", { name: "Create encrypted vault" }).click();
  await expect(page.getByText("Signed in and decrypted")).toBeVisible();
  await expect(page.getByText("Sync connected")).toBeVisible({ timeout: 30_000 });
  await waitForSharingKey(page);
}

export async function signInLargeNoteUser(
  page: Page,
  account: LargeNoteAccount
): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Account handle").fill(account.username);
  await page.getByLabel("Account password").fill(account.password);
  await page.getByRole("button", { name: "Sign in and decrypt" }).click();
  await expect(page.getByText("Signed in and decrypted")).toBeVisible();
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

export async function createLargeNoteThroughEditor(
  page: Page,
  account: LargeNoteAccount,
  title: string,
  profile: LargeNoteProfile
): Promise<LargeNoteDataset> {
  const failedResponses: string[] = [];
  const captureFailure = (response: { ok(): boolean; status(): number; url(): string }) => {
    if (!response.ok()) {
      failedResponses.push(`${String(response.status())} ${response.url()}`);
    }
  };
  page.on("response", captureFailure);
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/notes" &&
      response.ok()
  );
  await page.getByLabel("New note").click();
  const note = await (await created).json() as { id: string };
  try {
    await expect(sectionPosition(page)).toHaveText("Section 1 of 1", { timeout: 30_000 });
  } catch (error) {
    throw new Error(
      `New note section initialization failed (${failedResponses.join(", ") || "no failed HTTP response"})`,
      { cause: error }
    );
  } finally {
    page.off("response", captureFailure);
  }
  await expect(blockEditor(page)).toBeVisible();

  const titleSaved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      new URL(response.url()).pathname === `/api/notes/${note.id}` &&
      response.ok(),
    { timeout: 30_000 }
  );
  await page.getByRole("textbox", { name: "Title" }).fill(title);
  await titleSaved;
  await expect(page.getByRole("button", { name: titlePattern(title) })).toBeVisible();
  await signInLargeNoteUser(page, account);
  await openLargeNote(page, title);

  const sizes = sectionPayloadSizes(profile);
  const activeMarker = `active-${crypto.randomUUID()}`;
  const distantMarker = `distant-${crypto.randomUUID()}`;
  await replaceEditorWithGeneratedText(page, sizes[0], sectionPrefix(0, activeMarker));

  for (let section = 1; section < profile.sectionCount; section += 1) {
    await page.getByRole("button", { name: "Add section" }).click();
    await expect(sectionPosition(page)).toHaveText(
      `Section ${String(section + 1)} of ${String(section + 1)}`,
      { timeout: 60_000 }
    );
    const marker = section === profile.sectionCount - 1
      ? distantMarker
      : `body-${String(section)}`;
    await replaceEditorWithGeneratedText(page, sizes[section], sectionPrefix(section, marker));
  }

  const sectionIds = await listSectionIds(page, note.id);
  expect(sectionIds).toHaveLength(profile.sectionCount);
  return { activeMarker, distantMarker, noteId: note.id, sectionIds };
}

export async function shareLargeNote(
  page: Page,
  username: string,
  role: "editor" | "viewer" = "editor"
): Promise<void> {
  await page.getByLabel("Collaborator username").fill(username);
  await page.getByLabel("Collaborator role").selectOption(role);
  await page.getByRole("button", { name: "Share note" }).click();
  const member = page.locator(".membership-list li", { hasText: username });
  const trust = page.getByRole("checkbox", {
    name: "I independently verified this exact key"
  });
  await expect(trust.or(member)).toBeVisible({ timeout: 30_000 });
  if (await trust.isVisible()) {
    await trust.check();
    await page.getByRole("button", { name: "Trust key" }).click();
  }
  await expect(member).toContainText(role, { timeout: 30_000 });
}

export async function openLargeNote(page: Page, title: string): Promise<void> {
  const card = page.getByRole("button", { name: titlePattern(title) });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.click();
  await expect(sectionPosition(page)).toContainText(/^Section 1 of /u, { timeout: 30_000 });
  await expect(blockEditor(page)).toBeVisible({ timeout: 30_000 });
}

export function captureSectionTraffic(page: Page, noteId: string): SectionTrafficCapture {
  const historySectionIds: string[] = [];
  const chunkDownloads: string[] = [];
  const subscribedSectionIds: string[] = [];
  const historyPattern = new RegExp(
    `/api/notes/${escapeRegExp(noteId)}/sections/([^/]+)/history$`,
    "u"
  );
  const listener = (request: Request) => {
    const url = new URL(request.url());
    const history = historyPattern.exec(url.pathname);
    if (history?.[1]) {
      historySectionIds.push(decodeURIComponent(history[1]));
    }
    if (
      request.method() === "GET" &&
      CONTENT_DOWNLOAD.exec(url.pathname)
    ) {
      chunkDownloads.push(url.pathname);
    }
  };
  page.on("request", listener);
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      if (typeof payload !== "string") {
        return;
      }
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
          subscribedSectionIds.push(message.sectionId);
        }
      } catch {
        // Binary and non-control frames are irrelevant to subscription residency.
      }
    });
  });
  return {
    chunkDownloads,
    historySectionIds,
    subscribedSectionIds,
    stop() {
      page.off("request", listener);
    }
  };
}

export async function expectColdOpenIsolation(
  page: Page,
  dataset: LargeNoteDataset,
  traffic: SectionTrafficCapture
): Promise<void> {
  const allowed = new Set(["root", dataset.sectionIds[0], dataset.sectionIds[1]]);
  await expect(page.locator('nav[aria-label="Note sections"] li').nth(1)).toContainText("Ready", {
    timeout: 30_000
  });
  expect([...new Set(traffic.historySectionIds)].every((sectionId) => allowed.has(sectionId))).toBe(true);
  expect([...new Set(traffic.subscribedSectionIds)].every((sectionId) => allowed.has(sectionId))).toBe(true);
  expect(new Set(traffic.subscribedSectionIds)).toEqual(allowed);
  const readyPositions = await page
    .locator('nav[aria-label="Note sections"] li')
    .evaluateAll((items) => items.flatMap((item, index) =>
      item.textContent.includes("Ready") ? [index] : []
    ));
  expect(readyPositions.every((position) => position <= 1)).toBe(true);
  await expect(blockEditor(page)).toContainText(dataset.activeMarker);
  await expect(page.getByText(dataset.distantMarker, { exact: false })).toHaveCount(0);

  const cachedSectionIds = await readCachedSectionIds(page, dataset.noteId);
  expect(cachedSectionIds.every((sectionId) => allowed.has(sectionId))).toBe(true);
}

export async function appendWithRecoverableChunkFault(
  page: Page,
  account: LargeNoteAccount,
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
  await signInLargeNoteUser(page, account);
  await openLargeNote(page, title);
  await committed;
  await expect(blockEditor(page)).toContainText(marker, { timeout: 60_000 });
  return marker;
}

export async function exerciseServerQuotaPressure(
  page: Page,
  account: LargeNoteAccount,
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
    "Server storage is full; encrypted work remains queued.",
    { timeout: 30_000 }
  );
  await page.unroute("**/api/content/uploads", handler);

  const committed = page.waitForResponse(isSuccessfulContentCommit, { timeout: 120_000 });
  await signInLargeNoteUser(page, account);
  await openLargeNote(page, title);
  await committed;
  await expect(blockEditor(page)).toContainText(marker, { timeout: 60_000 });
  return marker;
}

export async function searchAllSectionsWithoutRepeatTransfer(
  page: Page,
  marker: string,
  expectedSections: number,
  traffic: SectionTrafficCapture
): Promise<void> {
  const search = page.getByLabel("Search notes");
  await search.fill(marker);
  await expect(page.getByRole("status").filter({ hasText: "Search" })).toContainText(
    "Search is ready.",
    { timeout: 10 * 60_000 }
  );
  const match = page.getByRole("button", { name: "Open matching section" });
  await expect(match).toBeVisible();
  await match.click();
  await expect(blockEditor(page)).toContainText(marker, { timeout: 30_000 });

  const historyCount = traffic.historySectionIds.length;
  const chunkCount = traffic.chunkDownloads.length;
  const subscriptionCount = traffic.subscribedSectionIds.length;
  await search.fill("");
  await search.fill(marker);
  await expect(page.getByRole("status").filter({ hasText: "Search" })).toContainText(
    "Search is ready."
  );
  await expect(page.getByRole("button", { name: "Open matching section" })).toBeVisible();
  expect(traffic.historySectionIds).toHaveLength(historyCount);
  expect(traffic.chunkDownloads).toHaveLength(chunkCount);
  expect(traffic.subscribedSectionIds).toHaveLength(subscriptionCount);
}

export async function exerciseIndependentOfflineEdits(input: {
  ownerPage: Page;
  collaboratorPage: Page;
  distantPosition: number;
}): Promise<void> {
  const ownerMarker = `owner-independent-${crypto.randomUUID()}`;
  const collaboratorMarker = `offline-independent-${crypto.randomUUID()}`;
  await input.ownerPage
    .getByRole("button", { name: "Section 1", exact: true })
    .click();
  await expect(blockEditor(input.ownerPage)).toBeVisible();

  await input.collaboratorPage.context().setOffline(true);
  await appendSmallEditorText(input.collaboratorPage, collaboratorMarker);
  await expect(blockEditor(input.collaboratorPage)).toContainText(collaboratorMarker);
  await appendSmallEditorText(input.ownerPage, ownerMarker);
  await expect(blockEditor(input.ownerPage)).toContainText(ownerMarker);
  await expect(blockEditor(input.ownerPage)).not.toContainText(collaboratorMarker);

  await input.collaboratorPage.context().setOffline(false);
  await expect(input.collaboratorPage.locator(".sync-pill")).toContainText("Live", {
    timeout: 30_000
  });
  await input.ownerPage
    .getByRole("button", {
      name: `Section ${String(input.distantPosition)}`,
      exact: true
    })
    .click();
  await expect(blockEditor(input.ownerPage)).toContainText(collaboratorMarker, {
    timeout: 60_000
  });
  await input.collaboratorPage
    .getByRole("button", { name: "Section 1", exact: true })
    .click();
  await expect(blockEditor(input.collaboratorPage)).toContainText(ownerMarker, {
    timeout: 60_000
  });
}

export async function exerciseSectionOperations(
  page: Page,
  initialSectionCount: number
): Promise<void> {
  await page.getByRole("button", { name: "Add section" }).click();
  await expect(page.locator('nav[aria-label="Note sections"] li')).toHaveCount(
    initialSectionCount + 1,
    { timeout: 60_000 }
  );
  await replaceSmallEditorText(page, "Operations block one");
  await blockEditor(page).press("End");
  await blockEditor(page).press("Enter");
  await blockEditor(page).pressSequentially("Operations block two");

  await page.getByRole("button", { name: "Split section" }).click();
  await expect(page.locator('nav[aria-label="Note sections"] li')).toHaveCount(
    initialSectionCount + 2,
    { timeout: 60_000 }
  );
  const beforeMove = await sectionPosition(page).textContent();
  await page.getByRole("button", { name: "Move up" }).click();
  await expect(sectionPosition(page)).not.toHaveText(beforeMove ?? "", { timeout: 60_000 });

  await page.getByRole("button", { name: "Merge with next" }).click();
  await expect(page.locator('nav[aria-label="Note sections"] li')).toHaveCount(
    initialSectionCount + 1,
    { timeout: 60_000 }
  );
  await page.getByRole("button", { name: "Delete section" }).click();
  await expect(page.locator('nav[aria-label="Note sections"] li')).toHaveCount(
    initialSectionCount,
    { timeout: 60_000 }
  );
}

export async function expectStoredLogicalSize(page: Page, minimumBytes: number): Promise<void> {
  const quota = await page.evaluate(async () => {
    const response = await fetch("/api/content/quota", { credentials: "include" });
    if (!response.ok) {
      throw new Error("Storage quota could not be inspected");
    }
    return await response.json() as { usedBytes: number };
  });
  expect(quota.usedBytes).toBeGreaterThanOrEqual(minimumBytes);
}

function sectionPayloadSizes(profile: LargeNoteProfile): number[] {
  const remaining = profile.logicalBytes - profile.activeSectionBytes;
  const ordinaryCount = profile.sectionCount - 1;
  const quotient = Math.floor(remaining / ordinaryCount);
  const remainder = remaining % ordinaryCount;
  return [
    profile.activeSectionBytes,
    ...Array.from({ length: ordinaryCount }, (_, index) =>
      quotient + (index < remainder ? 1 : 0)
    )
  ];
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
    const committed = page.waitForResponse(isSuccessfulContentCommit, { timeout: 120_000 });
    await injectGeneratedEditorText(page, chunkBytes, chunkPrefix, first);
    await committed;
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
  await expect(blockEditor(page)).toBeVisible();
  await blockEditor(page).focus();
  const inserted = await page.evaluate(({ byteLength, textPrefix, replaceExisting }) => {
    const editor = document.querySelector<HTMLElement>(".block-editor .bn-editor");
    const selection = window.getSelection();
    if (!editor || !selection) {
      return false;
    }
    const range = document.createRange();
    range.selectNodeContents(editor);
    if (!replaceExisting) {
      range.collapse(false);
    }
    selection.removeAllRanges();
    selection.addRange(range);
    const text = textPrefix + "x".repeat(byteLength - textPrefix.length);
    // Chromium still exposes this editing command; using it here drives the real
    // contenteditable input path without embedding the generated text in traces.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    return document.execCommand("insertText", false, text);
  }, { byteLength: bytes, textPrefix: prefix, replaceExisting: replace });
  expect(inserted).toBe(true);
}

async function replaceSmallEditorText(page: Page, text: string): Promise<void> {
  const editor = blockEditor(page);
  await editor.click();
  await editor.press("ControlOrMeta+A");
  await editor.pressSequentially(text);
}

async function appendSmallEditorText(page: Page, text: string): Promise<void> {
  const editor = blockEditor(page);
  await editor.focus();
  await editor.press("ControlOrMeta+End");
  await editor.pressSequentially(` ${text}`);
}

async function listSectionIds(page: Page, noteId: string): Promise<string[]> {
  return page.evaluate(async (id) => {
    const response = await fetch(`/api/notes/${id}/sections`, { credentials: "include" });
    if (!response.ok) {
      throw new Error("Section metadata could not be read");
    }
    const payload = await response.json() as { sections: { id: string }[] };
    return payload.sections.map((section) => section.id);
  }, noteId);
}

async function readCachedSectionIds(page: Page, noteId: string): Promise<string[]> {
  return page.evaluate(async (id) => await new Promise<string[]>((resolve, reject) => {
    const request = indexedDB.open("fortnote-protected");
    request.onerror = () => {
      reject(request.error ?? new Error("Protected cache could not be opened"));
    };
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("sectionCache", "readonly");
      const records = transaction.objectStore("sectionCache").getAll();
      records.onerror = () => {
        database.close();
        reject(records.error ?? new Error("Protected cache could not be read"));
      };
      records.onsuccess = () => {
        const sectionIds = (records.result as { noteId: string; sectionId: string }[])
          .filter((record) => record.noteId === id)
          .map((record) => record.sectionId);
        database.close();
        resolve(sectionIds);
      };
    };
  }), noteId);
}

async function waitForSharingKey(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(async () => {
    const response = await fetch("/api/sharing-keys/current", { credentials: "include" });
    return response.ok;
  }), { timeout: 30_000 }).toBe(true);
}

function isSuccessfulContentCommit(response: { request(): Request; url(): string; ok(): boolean }) {
  return response.request().method() === "POST" &&
    CONTENT_COMMIT.test(new URL(response.url()).pathname) &&
    response.ok();
}

function blockEditor(page: Page) {
  return page.locator(".block-editor .bn-editor");
}

function sectionPosition(page: Page) {
  return page.locator(".section-position");
}

function sectionPrefix(section: number, marker: string): string {
  return `fortnote-large-section-${String(section + 1).padStart(3, "0")} ${marker} `;
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
    throw new Error("Large-note profile values must be positive integers");
  }
  return parsed;
}
