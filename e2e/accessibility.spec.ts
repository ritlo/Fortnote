import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  closeAssuranceContexts,
  newAssurancePage,
  uniqueAssuranceAccount
} from "./support/assurance.js";

test("auth and empty vault expose names, keyboard focus, and clean axe results", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Register" })).toBeVisible();
  await expect(page.getByLabel("Account handle")).toBeVisible();
  await expect(page.getByLabel("Account password")).toBeVisible();
  await expectAxeClean(page);

  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toBeVisible();
  await expectVisibleFocus(page);

  const account = uniqueAssuranceAccount("a11y-empty");
  await register(page, account.username, account.password);
  await expect(page.getByLabel("New note")).toBeVisible();
  await expect(page.getByText("No notes yet", { exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toHaveCount(0);
  await expectAxeClean(page);
});

test("editor and section navigation remain accessible at 375 by 812", async ({ page }) => {
  const account = uniqueAssuranceAccount("a11y-editor");
  await register(page, account.username, account.password);
  await page.getByLabel("New note").click();
  await expect(page.getByLabel("Title")).toBeEnabled();
  await expect(page.locator(".block-editor .bn-editor")).toBeVisible();

  const sections = page.getByRole("navigation", { name: "Note sections" });
  await expect(sections).toBeVisible();
  await expect(sections.getByRole("button", { name: "Section 1", exact: true }))
    .toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: "Add section" }).click();
  await expect(page.locator(".section-position")).toHaveText("Section 2 of 2");

  await page.getByLabel("Title").focus();
  await page.keyboard.press("Tab");
  await expect(sections.getByRole("button", { name: "Section 1", exact: true }))
    .toBeFocused();
  await expectVisibleFocus(page);
  await page.keyboard.press("Enter");
  await expect(page.locator(".section-position")).toHaveText("Section 1 of 2");
  await expect(page.locator(".block-editor .bn-editor")).toBeVisible();

  await page.setViewportSize({ width: 375, height: 812 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  await expect(page.getByRole("button", { name: "Logout" })).toBeVisible();
  await expect(page.getByLabel("Title")).toBeVisible();
  await expect(page.getByRole("status")).toBeVisible();
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
    await ownerPage.getByLabel("New note").click();
    const share = ownerPage.getByRole("button", { name: "Share note" });
    await ownerPage.getByLabel("Collaborator username").fill(collaborator.username);
    await share.click();
    const confirmation = ownerPage.locator(".trust-confirmation");
    await expect(confirmation).toBeVisible();
    await expect(confirmation.getByRole("checkbox", {
      name: "I independently verified this exact key"
    })).toBeFocused();
    await confirmation.getByRole("button", { name: "Cancel" }).click();
    await expect(share).toBeFocused();
  } finally {
    await closeAssuranceContexts(contexts);
  }
});

async function register(page: Page, username: string, password: string): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Register" }).click();
  await page.getByLabel("Account handle").fill(username);
  await page.getByLabel("Account password").fill(password);
  await page.getByRole("button", { name: "Create encrypted vault" }).click();
  await expect(page.getByText("Signed in and decrypted")).toBeVisible();
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
