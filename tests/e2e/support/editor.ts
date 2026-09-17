import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Returns the note content editor once it accepts input. Content stays read-only
 * until the note's encrypted section has loaded, so typing any earlier is refused.
 */
export async function editableEditor(page: Page): Promise<Locator> {
  const editor = page.locator(".block-editor .bn-editor");
  await expect(editor).toHaveAttribute("contenteditable", "true", { timeout: 15_000 });
  return editor;
}
