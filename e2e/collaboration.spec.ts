import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

test("syncs a shared note for an online editor and offline viewer", async ({
  baseURL,
  browser
}) => {
  const contexts: BrowserContext[] = [];
  const alice = uniqueAccount("collab-alice");
  const bob = uniqueAccount("collab-bob");
  const carol = uniqueAccount("collab-carol");
  const noteTitle = `Collaboration note ${alice.suffix}`;
  const aliceBody = `Alice online update ${alice.suffix}`;
  const attachmentName = `shared-${alice.suffix}.txt`;
  const attachmentBody = `Shared attachment ${alice.suffix}`;
  const bobBody = `Bob editor update ${alice.suffix}`;

  try {
    const bobPage = await newUserPage(browser, baseURL, contexts);
    await register(bobPage, bob.username, bob.password);
    await waitForSharingKey(bobPage);

    let carolPage = await newUserPage(browser, baseURL, contexts);
    await register(carolPage, carol.username, carol.password);
    await waitForSharingKey(carolPage);
    await closePageContext(carolPage, contexts);

    const alicePage = await newUserPage(browser, baseURL, contexts);
    await register(alicePage, alice.username, alice.password);
    await createNote(alicePage, noteTitle, `Initial body ${alice.suffix}`);
    await shareNote(alicePage, bob.username, "editor");
    await shareNote(alicePage, carol.username, "viewer");

    await openNote(bobPage, noteTitle);
    await expect(bobPage.locator(".preview-body", { hasText: "Initial body" })).toBeVisible();
    await bobPage.getByLabel("Markdown editor").focus();
    await expect(
      alicePage.locator(".membership-list li", { hasText: bob.username })
    ).toContainText("editing");
    await expect(
      alicePage.locator(".membership-list li", { hasText: bob.username }).getByText(/active/)
    ).toBeVisible();

    await uploadAttachment(alicePage, attachmentName, attachmentBody);
    const bobAttachment = bobPage.locator(".attachment-list li", { hasText: attachmentName });
    await expect(bobAttachment).toBeVisible({ timeout: 10_000 });
    await expect(bobAttachment.getByRole("button", { name: "Delete" })).toBeVisible();
    await verifyAttachmentDownload(bobPage, attachmentName, attachmentBody);

    await editSelectedNote(alicePage, aliceBody);
    await expect(bobPage.locator(".preview-body", { hasText: aliceBody })).toBeVisible({
      timeout: 10_000
    });

    carolPage = await newUserPage(browser, baseURL, contexts);
    await signIn(carolPage, carol.username, carol.password);
    await openNote(carolPage, noteTitle);
    await expect(carolPage.locator(".preview-body", { hasText: aliceBody })).toBeVisible();
    const carolAttachment = carolPage.locator(".attachment-list li", { hasText: attachmentName });
    await expect(carolAttachment).toBeVisible();
    await verifyAttachmentDownload(carolPage, attachmentName, attachmentBody);
    await expect(carolAttachment.getByRole("button", { name: "Delete" })).toHaveCount(0);
    await expect(carolPage.getByLabel("Attach encrypted file")).toBeDisabled();
    await expect(carolPage.getByLabel("Markdown editor")).toBeDisabled();
    await expect(carolPage.getByRole("button", { name: "Save" })).toBeDisabled();
    await revokeMember(alicePage, carol.username);
    await expect(carolPage.getByRole("button", { name: noteTitlePattern(noteTitle) })).toHaveCount(
      0
    );
    await expect(carolPage.locator(".preview-body", { hasText: aliceBody })).toHaveCount(0);
    await closePageContext(carolPage, contexts);

    await editSelectedNote(bobPage, bobBody);
    await expect(alicePage.locator(".preview-body", { hasText: bobBody })).toBeVisible({
      timeout: 10_000
    });
    await changeMemberRole(alicePage, bob.username, "viewer");
    await expect(bobPage.getByLabel("Markdown editor")).toBeDisabled({ timeout: 10_000 });
    await expect(bobPage.getByRole("button", { name: "Save" })).toBeDisabled();

    carolPage = await newUserPage(browser, baseURL, contexts);
    await signIn(carolPage, carol.username, carol.password);
    await expect(carolPage.getByRole("button", { name: noteTitlePattern(noteTitle) })).toHaveCount(
      0
    );
    await expect(carolPage.locator(".preview-body", { hasText: bobBody })).toHaveCount(0);
  } finally {
    await Promise.all(contexts.splice(0).map((context) => context.close()));
  }
});

test("syncs edits between two tabs signed in to the same account", async ({
  baseURL,
  browser
}) => {
  const contexts: BrowserContext[] = [];
  const account = uniqueAccount("same-account");
  const noteTitle = `Two tab note ${account.suffix}`;
  const firstBody = `First tab update ${account.suffix}`;
  const secondBody = `Second tab update ${account.suffix}`;

  try {
    const context = await browser.newContext({ baseURL });
    contexts.push(context);
    const firstPage = await context.newPage();
    await register(firstPage, account.username, account.password);
    await createNote(firstPage, noteTitle, `Initial body ${account.suffix}`);

    const secondPage = await context.newPage();
    await signIn(secondPage, account.username, account.password);
    await openNote(secondPage, noteTitle);

    await editSelectedNote(firstPage, firstBody);
    await expect(secondPage.locator(".preview-body", { hasText: firstBody })).toBeVisible({
      timeout: 10_000
    });

    await editSelectedNote(secondPage, secondBody);
    await expect(firstPage.locator(".preview-body", { hasText: secondBody })).toBeVisible({
      timeout: 10_000
    });
  } finally {
    await Promise.all(contexts.splice(0).map((context) => context.close()));
  }
});

test("removes a permanently deleted shared note after an offline client reconnects", async ({
  baseURL,
  browser
}) => {
  const contexts: BrowserContext[] = [];
  const alice = uniqueAccount("delete-alice");
  const bob = uniqueAccount("delete-bob");
  const noteTitle = `Delete replay note ${alice.suffix}`;

  try {
    const bobPage = await newUserPage(browser, baseURL, contexts);
    await register(bobPage, bob.username, bob.password);
    await waitForSharingKey(bobPage);

    const alicePage = await newUserPage(browser, baseURL, contexts);
    await register(alicePage, alice.username, alice.password);
    await createNote(alicePage, noteTitle, `Delete replay body ${alice.suffix}`);
    await shareNote(alicePage, bob.username, "editor");
    await openNote(bobPage, noteTitle);

    await bobPage.context().setOffline(true);
    await alicePage.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(alicePage.getByText("Note moved to trash")).toBeVisible();
    await alicePage.getByRole("button", { name: "Trash", exact: true }).click();
    await openNote(alicePage, noteTitle);
    await alicePage.getByRole("button", { name: "Delete forever" }).click();
    await expect(alicePage.getByText("Note permanently deleted")).toBeVisible();

    await bobPage.context().setOffline(false);
    await expect(bobPage.getByRole("button", { name: noteTitlePattern(noteTitle) })).toHaveCount(0, {
      timeout: 15_000
    });
    await expect(bobPage.locator(".preview-body", { hasText: "Delete replay body" })).toHaveCount(0);
  } finally {
    await Promise.all(contexts.splice(0).map((context) => context.close()));
  }
});

test("cancels sharing-key confirmation when another note is selected", async ({
  baseURL,
  browser
}) => {
  const contexts: BrowserContext[] = [];
  const alice = uniqueAccount("switch-alice");
  const bob = uniqueAccount("switch-bob");
  const targetTitle = `Trust target ${alice.suffix}`;
  const otherTitle = `Other note ${alice.suffix}`;
  let membershipPosted = false;

  try {
    const bobPage = await newUserPage(browser, baseURL, contexts);
    await register(bobPage, bob.username, bob.password);
    await waitForSharingKey(bobPage);
    await closePageContext(bobPage, contexts);

    const alicePage = await newUserPage(browser, baseURL, contexts);
    await register(alicePage, alice.username, alice.password);
    await createNote(alicePage, targetTitle, `Target body ${alice.suffix}`);
    await createNote(alicePage, otherTitle, `Other body ${alice.suffix}`);
    await openNote(alicePage, targetTitle);
    alicePage.on("response", (response) => {
      if (response.request().method() === "POST" && response.url().includes("/memberships")) {
        membershipPosted = true;
      }
    });

    await pageAttemptShare(alicePage, bob.username, "editor");
    await expect(alicePage.getByRole("button", { name: "Trust key" })).toBeVisible();
    await openNote(alicePage, otherTitle);
    await expect(alicePage.getByRole("button", { name: "Trust key" })).toHaveCount(0);
    expect(membershipPosted).toBe(false);
  } finally {
    await Promise.all(contexts.splice(0).map((context) => context.close()));
  }
});

test("blocks sharing when a trusted sharing key changes", async ({ baseURL, browser }) => {
  const contexts: BrowserContext[] = [];
  const alice = uniqueAccount("trust-alice");
  const bob = uniqueAccount("trust-bob");
  const mallory = uniqueAccount("trust-mallory");
  const trustedNoteTitle = `Trusted note ${alice.suffix}`;
  const blockedNoteTitle = `Blocked note ${alice.suffix}`;
  let membershipPosted = false;

  try {
    const bobPage = await newUserPage(browser, baseURL, contexts);
    await register(bobPage, bob.username, bob.password);
    await waitForSharingKey(bobPage);

    const malloryPage = await newUserPage(browser, baseURL, contexts);
    await register(malloryPage, mallory.username, mallory.password);
    await waitForSharingKey(malloryPage);
    await closePageContext(malloryPage, contexts);

    const alicePage = await newUserPage(browser, baseURL, contexts);
    await register(alicePage, alice.username, alice.password);
    await createNote(alicePage, trustedNoteTitle, `Trusted body ${alice.suffix}`);
    await shareNote(alicePage, bob.username, "editor");

    const bobKey = await lookupPublicSharingKey(alicePage, bob.username);
    const malloryKey = await lookupPublicSharingKey(alicePage, mallory.username);
    await alicePage.route("**/api/sharing-keys/lookup**", async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("username") !== bob.username) {
        await route.continue();
        return;
      }

      await route.fulfill({
        contentType: "application/json",
        status: 200,
        body: JSON.stringify({
          ...bobKey,
          publicKey: malloryKey.publicKey
        })
      });
    });
    alicePage.on("response", (response) => {
      if (
        response.request().method() === "POST" &&
        response.url().includes("/memberships") &&
        response.ok()
      ) {
        membershipPosted = true;
      }
    });

    await createNote(alicePage, blockedNoteTitle, `Blocked body ${alice.suffix}`);
    await pageAttemptShare(alicePage, bob.username, "editor");

    await expect(alicePage.getByText("Share blocked")).toBeVisible();
    await expect(alicePage.getByText(/Sharing key changed/)).toBeVisible();
    expect(membershipPosted).toBe(false);
  } finally {
    await Promise.all(contexts.splice(0).map((context) => context.close()));
  }
});

test("retries failed revocation key rotation", async ({ baseURL, browser }) => {
  const contexts: BrowserContext[] = [];
  const alice = uniqueAccount("retry-alice");
  const bob = uniqueAccount("retry-bob");
  const noteTitle = `Retry rotation note ${alice.suffix}`;
  const otherTitle = `Retry navigation note ${alice.suffix}`;
  let failNextRotation = true;

  try {
    const bobPage = await newUserPage(browser, baseURL, contexts);
    await register(bobPage, bob.username, bob.password);
    await waitForSharingKey(bobPage);

    const alicePage = await newUserPage(browser, baseURL, contexts);
    await register(alicePage, alice.username, alice.password);
    await createNote(alicePage, otherTitle, `Navigation body ${alice.suffix}`);
    await createNote(alicePage, noteTitle, `Retry body ${alice.suffix}`);
    await shareNote(alicePage, bob.username, "editor");
    await alicePage.route("**/api/notes/*/key-rotation", async (route) => {
      if (!failNextRotation) {
        await route.continue();
        return;
      }
      failNextRotation = false;
      await route.fulfill({
        contentType: "application/json",
        status: 500,
        body: JSON.stringify({
          code: "forced_rotation_failure",
          message: "Forced rotation failure"
        })
      });
    });

    await revokeMember(alicePage, bob.username);
    await expect(alicePage.getByText("Key rotation incomplete")).toBeVisible();
    const retryButton = alicePage.getByRole("button", { name: "Retry rotation", exact: true });
    await expect(retryButton).toBeVisible();

    await openNote(alicePage, otherTitle);
    await expect(retryButton).toHaveCount(0);
    await openNote(alicePage, noteTitle);
    await expect(retryButton).toBeVisible();

    const retried = alicePage.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/key-rotation") &&
        response.ok()
    );
    await retryButton.click();
    await retried;
    await expect(alicePage.getByText("Keys rotated after revoke")).toBeVisible();
    await expect(alicePage.getByText("Key rotation incomplete")).toHaveCount(0);
  } finally {
    await Promise.all(contexts.splice(0).map((context) => context.close()));
  }
});

interface Account {
  password: string;
  suffix: string;
  username: string;
}

async function newUserPage(
  browser: Browser,
  baseURL: string | undefined,
  contexts: BrowserContext[]
): Promise<Page> {
  const context = await browser.newContext({ baseURL });
  contexts.push(context);
  return context.newPage();
}

async function closePageContext(page: Page, contexts: BrowserContext[]): Promise<void> {
  const context = page.context();
  await context.close();
  const index = contexts.indexOf(context);
  if (index >= 0) {
    contexts.splice(index, 1);
  }
}

async function register(page: Page, username: string, password: string): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Register" }).click();
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Account password").fill(password);
  await page.getByRole("button", { name: "Create encrypted vault" }).click();
  await expect(page.getByText("Signed in and decrypted")).toBeVisible();
}

async function signIn(page: Page, username: string, password: string): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Account password").fill(password);
  await page.getByRole("button", { name: "Sign in and decrypt" }).click();
  await expect(page.getByText("Signed in and decrypted")).toBeVisible();
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
      { timeout: 10_000 }
    )
    .toBe(true);
}

async function createNote(page: Page, title: string, body: string): Promise<void> {
  await page.getByLabel("New note").click();
  await expect(page.getByRole("button", { name: /Untitled note/ })).toBeVisible();
  const titleInput = page.getByLabel("Title");
  await expect(titleInput).toHaveValue("Untitled note");
  await titleInput.click();
  await titleInput.press("ControlOrMeta+A");
  await titleInput.pressSequentially(title);
  await expect(titleInput).toHaveValue(title);
  await expect(page.getByRole("button", { name: noteTitlePattern(title) })).toBeVisible();
  await page.getByLabel("Markdown editor").fill(body);
  const saved = waitForNoteSave(page);
  await page.getByRole("button", { name: "Save" }).click();
  await saved;
  await expect(page.getByText("Note encrypted and saved")).toBeVisible();
  await expect(page.getByRole("button", { name: noteTitlePattern(title) })).toBeVisible();
}

async function shareNote(
  page: Page,
  username: string,
  role: "editor" | "viewer"
): Promise<void> {
  await pageAttemptShare(page, username, role);
  const trustButton = page.getByRole("button", { name: "Trust key" });
  await trustButton
    .waitFor({ state: "visible", timeout: 5_000 })
    .then(async () => {
      await trustButton.click();
    })
    .catch(() => undefined);
  await expect(page.getByText("Note shared")).toBeVisible();
  await expect(page.locator(".membership-list li", { hasText: username })).toBeVisible();
}

async function pageAttemptShare(
  page: Page,
  username: string,
  role: "editor" | "viewer"
): Promise<void> {
  await page.getByLabel("Collaborator username").fill(username);
  await page.getByLabel("Collaborator role").selectOption(role);
  const shared = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/memberships") &&
      response.ok()
  );
  await page.getByRole("button", { name: "Share note" }).click();
  await Promise.race([
    shared.catch(() => undefined),
    page.getByRole("button", { name: "Trust key" }).waitFor({ state: "visible" }),
    page.getByText("Share blocked").waitFor({ state: "visible" })
  ]);
}

async function revokeMember(page: Page, username: string): Promise<void> {
  const revoked = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" &&
      response.url().includes("/memberships/") &&
      response.ok()
  );
  await page
    .locator(".membership-list li", { hasText: username })
    .getByRole("button", { name: "Revoke" })
    .click();
  await revoked;
  await expect(page.getByText("Collaborator revoked")).toBeVisible();
}

async function changeMemberRole(
  page: Page,
  username: string,
  role: "editor" | "viewer"
): Promise<void> {
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

async function openNote(page: Page, title: string): Promise<void> {
  await expect(page.getByRole("button", { name: noteTitlePattern(title) })).toBeVisible({
    timeout: 10_000
  });
  await page.getByRole("button", { name: noteTitlePattern(title) }).click();
}

async function editSelectedNote(page: Page, body: string): Promise<void> {
  await page.getByLabel("Markdown editor").fill(body);
  const saved = waitForNoteSave(page);
  await page.getByRole("button", { name: "Save" }).click();
  await saved;
  await expect(page.getByText("Note encrypted and saved")).toBeVisible();
}

async function uploadAttachment(
  page: Page,
  filename: string,
  contents: string
): Promise<void> {
  const uploaded = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/api/notes/") &&
      response.url().includes("/attachments") &&
      response.ok()
  );
  await page.getByLabel("Attach encrypted file").setInputFiles({
    name: filename,
    mimeType: "text/plain",
    buffer: Buffer.from(contents)
  });
  await uploaded;
  await expect(page.getByText("Attachment encrypted and saved")).toBeVisible();
}

async function verifyAttachmentDownload(
  page: Page,
  filename: string,
  contents: string
): Promise<void> {
  const downloaded = page.waitForEvent("download");
  await page
    .locator(".attachment-list li", { hasText: filename })
    .getByRole("button", { name: "Download" })
    .click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe(filename);
  const path = await download.path();
  expect(path).toBeTruthy();
  expect(await readFile(path, "utf8")).toBe(contents);
  await expect(page.getByText("Attachment decrypted")).toBeVisible();
}

async function waitForNoteSave(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().includes("/api/notes/") &&
      response.ok()
  );
}

async function lookupPublicSharingKey(page: Page, username: string): Promise<PublicSharingKey> {
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

interface PublicSharingKey {
  userId: string;
  username: string;
  sharingKeyVersion: number;
  publicKey: string;
  formatVersion: number;
  createdAt: string;
}

function noteTitlePattern(title: string): RegExp {
  return new RegExp(escapeRegExp(title));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueAccount(prefix: string): Account {
  const suffix = `${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
  return {
    suffix,
    username: `${prefix}-${suffix}`,
    password: `password-${suffix}`
  };
}
