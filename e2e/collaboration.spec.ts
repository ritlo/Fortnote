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
    await expect(
      alicePage.locator(".membership-list li", { hasText: bob.username }).getByText(/active/)
    ).toBeVisible();

    await editSelectedNote(alicePage, aliceBody);
    await expect(bobPage.locator(".preview-body", { hasText: aliceBody })).toBeVisible({
      timeout: 10_000
    });

    carolPage = await newUserPage(browser, baseURL, contexts);
    await signIn(carolPage, carol.username, carol.password);
    await openNote(carolPage, noteTitle);
    await expect(carolPage.locator(".preview-body", { hasText: aliceBody })).toBeVisible();
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
  await page.getByLabel("Collaborator username").fill(username);
  await page.getByLabel("Collaborator role").selectOption(role);
  const shared = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/memberships") &&
      response.ok()
  );
  await page.getByRole("button", { name: "Share note" }).click();
  await shared;
  await expect(page.getByText("Note shared")).toBeVisible();
  await expect(page.locator(".membership-list li", { hasText: username })).toBeVisible();
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

async function waitForNoteSave(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().includes("/api/notes/") &&
      response.ok()
  );
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
