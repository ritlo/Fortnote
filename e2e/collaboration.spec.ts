import { Buffer } from "node:buffer";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { decodeCrdtBinaryFrame } from "../packages/shared/src/index.js";
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type Response
} from "@playwright/test";
import { waitForCrdtDurability } from "./support/durability.js";

test("syncs a shared note for an online editor and offline viewer", async ({
  baseURL,
  browser
}) => {
  test.setTimeout(90_000);
  const contexts: BrowserContext[] = [];
  const alice = uniqueAccount("collab-alice");
  const bob = uniqueAccount("collab-bob");
  const carol = uniqueAccount("collab-carol");
  const noteTitle = `Collaboration note ${alice.suffix}`;
  const initialBody = `Initial body ${alice.suffix}`;
  const aliceBody = `Alice online update ${alice.suffix}`;
  const concurrentAliceEdit = `alice-edit-${alice.suffix}`;
  const concurrentBobEdit = `bob-edit-${alice.suffix}`;
  const attachmentName = `shared-${alice.suffix}.txt`;
  const attachmentBody = `Shared attachment ${alice.suffix}`;
  const bobBody = `Bob editor update ${alice.suffix}`;
  const realtimeFrames: string[] = [];
  const carolRealtime = { closes: 0 };

  try {
    let bobPage = await newUserPage(browser, baseURL, contexts);
    const traffic = captureApiTraffic(bobPage);
    captureRealtimeFrames(bobPage, realtimeFrames);
    await register(bobPage, bob.username, bob.password);
    await waitForSharingKey(bobPage);
    const bobFingerprint = await readOwnSharingFingerprint(bobPage);

    let carolPage = await newUserPage(browser, baseURL, contexts);
    captureApiTraffic(carolPage, traffic);
    await register(carolPage, carol.username, carol.password);
    await waitForSharingKey(carolPage);
    const carolFingerprint = await readOwnSharingFingerprint(carolPage);
    await closePageContext(carolPage, contexts);

    const alicePage = await newUserPage(browser, baseURL, contexts);
    captureApiTraffic(alicePage, traffic);
    captureRealtimeFrames(alicePage, realtimeFrames);
    await register(alicePage, alice.username, alice.password);
    await createNote(alicePage, noteTitle, initialBody);
    await shareNote(alicePage, bob.username, "editor", bobFingerprint);
    await shareNote(alicePage, carol.username, "viewer", carolFingerprint);

    await openShareDialog(alicePage);
    await openNote(bobPage, noteTitle);
    await expect(blockEditor(bobPage)).toContainText("Initial body");
    await blockEditor(bobPage).focus();
    await expect(
      alicePage.locator(".membership-list li", { hasText: bob.username })
    ).toContainText("active", { timeout: 10_000 });
    await expect(alicePage.getByText(/^Last saved/)).toHaveCount(0);
    await closeShareDialog(alicePage);


    await editSelectedNote(alicePage, aliceBody);
    await expect(blockEditor(bobPage)).toContainText(aliceBody, {
      timeout: 10_000
    });

    const aliceEditor = blockEditor(alicePage);
    const bobEditor = blockEditor(bobPage);
    await Promise.all([
      aliceEditor.press("ControlOrMeta+Home"),
      bobEditor.press("ControlOrMeta+End")
    ]);
    await Promise.all([
      aliceEditor.pressSequentially(concurrentAliceEdit),
      bobEditor.pressSequentially(concurrentBobEdit)
    ]);
    await expect.poll(async () => {
      const [aliceValue, bobValue] = await Promise.all([
        editorText(alicePage),
        editorText(bobPage)
      ]);
      return (
        aliceValue === bobValue &&
        aliceValue.includes(concurrentAliceEdit) &&
        aliceValue.includes(concurrentBobEdit)
      );
    }, { timeout: 10_000 }).toBe(true);
    const mergedBody = await editorText(alicePage);
    expect(mergedBody.match(new RegExp(escapeRegExp(concurrentAliceEdit), "gu"))).toHaveLength(1);
    expect(mergedBody.match(new RegExp(escapeRegExp(concurrentBobEdit), "gu"))).toHaveLength(1);
    await Promise.all([
      waitForCrdtDurability(alicePage),
      waitForCrdtDurability(bobPage)
    ]);

    carolPage = await newUserPage(browser, baseURL, contexts);
    captureApiTraffic(carolPage, traffic);
    captureRealtimeFrames(carolPage, realtimeFrames, carolRealtime);
    await signIn(carolPage, carol.username, carol.password);
    await openNote(carolPage, noteTitle);
    await expect.poll(() => editorText(carolPage)).toBe(mergedBody);
    await expect(blockEditor(carolPage)).toHaveAttribute("contenteditable", "false");
    await expect(carolPage.getByRole("button", { name: "Save" })).toHaveCount(0);
    await expect(carolPage.getByRole("button", { name: "Undo", exact: true })).toHaveCount(0);
    await expect(carolPage.getByRole("button", { name: "Redo", exact: true })).toHaveCount(0);
    await revokeMember(alicePage, carol.username);
    await expect.poll(() => carolRealtime.closes).toBeGreaterThan(0);
    await expect(carolPage.getByRole("button", { name: noteTitlePattern(noteTitle) })).toHaveCount(
      0
    );
    await expect(blockEditor(carolPage)).toHaveCount(0);
    await expect(blockEditor(alicePage)).toBeVisible({ timeout: 10_000 });
    await waitForCrdtDurability(alicePage);
    await closePageContext(carolPage, contexts);

    await closePageContext(bobPage, contexts);
    bobPage = await newUserPage(browser, baseURL, contexts);
    captureApiTraffic(bobPage, traffic);
    captureRealtimeFrames(bobPage, realtimeFrames);
    await signIn(bobPage, bob.username, bob.password);
    await openNote(bobPage, noteTitle);
    await expect.poll(() => editorText(bobPage)).toBe(mergedBody);

    await editSelectedNote(bobPage, bobBody);
    await expect(blockEditor(alicePage)).toContainText(bobBody, {
      timeout: 10_000
    });
    await changeMemberRole(alicePage, bob.username, "viewer");
    await expect(blockEditor(bobPage)).toHaveAttribute("contenteditable", "false", {
      timeout: 10_000
    });
    await expect(bobPage.getByRole("button", { name: "Save" })).toHaveCount(0);
    await expect(bobPage.getByRole("button", { name: "Undo", exact: true })).toHaveCount(0);
    await expect(bobPage.getByRole("button", { name: "Redo", exact: true })).toHaveCount(0);
    expect(realtimeFrames.join("\n")).not.toContain(aliceBody);
    expect(realtimeFrames.join("\n")).not.toContain(bobBody);
    expect(realtimeFrames.join("\n")).not.toContain("awareness");

    carolPage = await newUserPage(browser, baseURL, contexts);
    captureApiTraffic(carolPage, traffic);
    captureRealtimeFrames(carolPage, realtimeFrames);
    await signIn(carolPage, carol.username, carol.password);
    await expect(carolPage.getByRole("button", { name: noteTitlePattern(noteTitle) })).toHaveCount(
      0
    );
    await expect(blockEditor(carolPage)).toHaveCount(0);

    const stored = readStoredCollaboration(alice.username);
    const storedAttachment = stored.attachmentPath ? await readFile(stored.attachmentPath) : null;
    const responseBodies = await Promise.all(traffic.responseBodies);
    const browserTraffic = Buffer.concat([...traffic.requestBodies, ...responseBodies]);
    for (const plaintext of [
      noteTitle,
      initialBody,
      aliceBody,
      mergedBody,
      bobBody,
      attachmentName,
      attachmentBody
    ]) {
      expect(browserTraffic.toString("utf8")).not.toContain(plaintext);
      expect(realtimeFrames.join("\n")).not.toContain(plaintext);
      expect(stored.databasePayload).not.toContain(plaintext);
      if (storedAttachment) {
        expect(storedAttachment.toString("utf8")).not.toContain(plaintext);
      }
    }
  } finally {
    await closeContexts(contexts);
  }
});

test("syncs and persists collaborative undo and redo", async ({ baseURL, browser }) => {
  test.setTimeout(45_000);
  const contexts: BrowserContext[] = [];
  const alice = uniqueAccount("undo-alice");
  const bob = uniqueAccount("undo-bob");
  const noteTitle = `Undo note ${alice.suffix}`;
  const suffix = ` undo-redo-${alice.suffix}`;

  try {
    const bobPage = await newUserPage(browser, baseURL, contexts);
    await test.step("create the collaborator", async () => {
      await register(bobPage, bob.username, bob.password);
      await waitForSharingKey(bobPage);
    });

    const alicePage = await newUserPage(browser, baseURL, contexts);
    await test.step("share a note", async () => {
      await register(alicePage, alice.username, alice.password);
      await createNote(alicePage, noteTitle, "Initial body");
      await shareNote(alicePage, bob.username, "editor");
      await openNote(bobPage, noteTitle);
      await expect(blockEditor(bobPage)).toContainText("Initial body");
    });

    await test.step("synchronize undo and redo", async () => {
      const editor = blockEditor(alicePage);
      await editor.press("ControlOrMeta+End");
      await editor.pressSequentially(suffix);
      await waitForCrdtDurability(alicePage);
      await expect(blockEditor(bobPage)).toContainText(suffix);

      await alicePage.getByRole("button", { name: "Undo", exact: true }).click();
      await waitForCrdtDurability(alicePage);
      await expect(blockEditor(bobPage)).not.toContainText(suffix);

      await alicePage.getByRole("button", { name: "Redo", exact: true }).click();
      await waitForCrdtDurability(alicePage);
      await expect(blockEditor(bobPage)).toContainText(suffix);
    });

    await test.step("retain redo after relogin", async () => {
      await closePageContext(bobPage, contexts);
      const reloadedBobPage = await newUserPage(browser, baseURL, contexts);
      await signIn(reloadedBobPage, bob.username, bob.password);
      await openNote(reloadedBobPage, noteTitle);
      await expect(blockEditor(reloadedBobPage)).toContainText(suffix);
    });
  } finally {
    await closeContexts(contexts);
  }
});

test("embeds encrypted media for reloads and shared viewers", async ({
  baseURL,
  browser
}) => {
  test.setTimeout(90_000);
  const contexts: BrowserContext[] = [];
  const alice = uniqueAccount("media-alice");
  const bob = uniqueAccount("media-bob");
  const noteTitle = `Media note ${alice.suffix}`;
  const filename = `encrypted-${alice.suffix}.svg`;
  const marker = `media-plaintext-${alice.suffix}`;
  const image = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><metadata>${marker}</metadata><rect width="2" height="2" fill="green"/></svg>`
  );
  const realtimeFrames: string[] = [];
  let storedFilePath = "";
  let storedAttachmentId = "";

  try {
    const bobPage = await newUserPage(browser, baseURL, contexts);
    await register(bobPage, bob.username, bob.password);
    await waitForSharingKey(bobPage);

    const alicePage = await newUserPage(browser, baseURL, contexts);
    await register(alicePage, alice.username, alice.password);
    await createNote(alicePage, noteTitle, "Encrypted media body");
    const traffic = captureApiTraffic(alicePage);
    captureRealtimeFrames(alicePage, realtimeFrames);

    await test.step("upload and render encrypted block media", async () => {
      await insertImageBlock(alicePage);
      const uploaded = waitForAttachmentUpload(alicePage);
      await alicePage.locator('input[type="file"][accept="image/*"]').setInputFiles({
        name: filename,
        mimeType: "image/svg+xml",
        buffer: image
      });
      await uploaded;
      await waitForCrdtDurability(alicePage);

      await expect(alicePage.getByRole("img", { name: filename })).toHaveAttribute(
        "src",
        /^blob:/
      );
      expect(traffic.attachmentUploads).toBe(1);

      const noteCard = alicePage.locator(".note-card", { hasText: noteTitle });
      await noteCard.click({ button: "right" });
      await alicePage.getByRole("menuitem", { name: "Attachments" }).click();
      const attachmentDialog = alicePage.getByRole("dialog", {
        name: `Attachments for ${noteTitle}`
      });
      await expect(attachmentDialog).toBeVisible();
      await attachmentDialog.getByRole("button", { name: filename, exact: true }).click();
      await expect(attachmentDialog.getByRole("img", { name: `Preview of ${filename}` }))
        .toBeVisible();
      await attachmentDialog.getByRole("button", { name: "Close attachments" }).click();
    });

    await test.step("reuse the attachment without another upload", async () => {
      await insertImageBlock(alicePage);
      await alicePage.locator('[data-test="attachments-tab"]').click();
      await alicePage.getByRole("button", { name: filename, exact: true }).click();
      await waitForCrdtDurability(alicePage);

      await expect(alicePage.getByRole("img", { name: filename })).toHaveCount(2);
      const imageSources = await alicePage
        .getByRole("img", { name: filename })
        .evaluateAll((images) => images.map((item) => item.getAttribute("src")));
      expect(imageSources.every((source) => source?.startsWith("blob:"))).toBe(true);
      expect(new Set(imageSources).size).toBe(1);
      expect(traffic.attachmentUploads).toBe(1);
    });

    await test.step("reload and render for a read-only collaborator", async () => {
      await reloadAndUnlock(alicePage, alice.password);
      await expect(alicePage.getByRole("img", { name: filename })).toHaveCount(2);
      await expect(alicePage.getByRole("img", { name: filename }).first()).toHaveAttribute(
        "src",
        /^blob:/
      );

      await shareNote(alicePage, bob.username, "viewer");
      await openNote(bobPage, noteTitle);
      const viewerImages = bobPage.getByRole("img", { name: filename });
      await expect(viewerImages).toHaveCount(2);
      await expect(viewerImages.first()).toHaveAttribute("src", /^blob:/);
      await viewerImages.first().click();
      await expect(blockEditor(bobPage)).toHaveAttribute("contenteditable", "false");
      await expect(bobPage.getByRole("button", { name: "Replace image" })).toHaveCount(0);
      await expect(bobPage.getByRole("button", { name: "Delete image" })).toHaveCount(0);
      await expect(bobPage.locator('[data-test="upload-tab"]')).toHaveCount(0);
      await expect(bobPage.locator('[data-test="attachments-tab"]')).toHaveCount(0);
    });

    await test.step("keep plaintext and object URLs client-only", async () => {
      const stored = readStoredMedia(alice.username);
      storedFilePath = stored.filePath;
      storedAttachmentId = stored.attachmentId;
      const storedBytes = await readFile(stored.filePath);
      const responseBodies = await Promise.all(traffic.responseBodies);
      const browserTraffic = Buffer.concat([...traffic.requestBodies, ...responseBodies]);

      expect(browserTraffic.includes(image)).toBe(false);
      expect(browserTraffic.toString("utf8")).not.toContain(marker);
      expect(browserTraffic.toString("utf8")).not.toContain("blob:");
      expect(realtimeFrames.join("\n")).not.toContain(marker);
      expect(realtimeFrames.join("\n")).not.toContain("blob:");
      expect(stored.databasePayload).not.toContain(marker);
      expect(stored.databasePayload).not.toContain("blob:");
      expect(storedBytes.includes(image)).toBe(false);
      expect(storedBytes.toString("utf8")).not.toContain(marker);
    });

    await test.step("leave deleted embeds unavailable without corrupting the document", async () => {
      const attachmentId = storedAttachmentId;
      if (!attachmentId) throw new Error("Could not get attachment ID from stored media");
      const deleted = alicePage.waitForResponse(
        (response) =>
          response.request().method() === "DELETE" &&
          response.url().includes(`/api/attachments/${attachmentId}`) &&
          response.ok()
      );
      await alicePage.evaluate((id) => {
        void fetch(`/api/attachments/${id}`, { method: "DELETE" });
      }, attachmentId);
      await deleted;

      await reloadAndUnlock(alicePage, alice.password);
      const unavailableImages = alicePage.getByRole("img", { name: filename });
      await expect(unavailableImages).toHaveCount(2);
      await expect
        .poll(() =>
          unavailableImages.evaluateAll((images) =>
            images.map((item) => item.getAttribute("src"))
          )
        )
        .toEqual([null, null]);
      await expect(readFile(storedFilePath)).rejects.toThrow();
    });
  } finally {
    await closeContexts(contexts);
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
    await expect(blockEditor(secondPage)).toContainText(firstBody, {
      timeout: 10_000
    });

    await editSelectedNote(secondPage, secondBody);
    await expect(blockEditor(firstPage)).toContainText(secondBody, {
      timeout: 10_000
    });

    const firstEditor = blockEditor(firstPage);
    const secondEditor = blockEditor(secondPage);
    await Promise.all([
      firstEditor.press("Control+Home"),
      secondEditor.press("Control+End")
    ]);
    await Promise.all([firstEditor.pressSequentially("A "), secondEditor.pressSequentially(" B")]);
    await expect.poll(async () => {
      const [firstValue, secondValue] = await Promise.all([
        editorText(firstPage),
        editorText(secondPage)
      ]);
      return firstValue === secondValue;
    }).toBe(true);
    await expect(firstEditor).toContainText(/^A.*B$/);
  } finally {
    await closeContexts(contexts);
  }
});

test("converges offline tabs after a lost ack, API restart, and fresh session", async ({
  baseURL,
  browser
}) => {
  test.setTimeout(120_000);
  const contexts: BrowserContext[] = [];
  const alice = uniqueAccount("durable-alice");
  const bob = uniqueAccount("durable-bob");
  const noteTitle = `Durable convergence ${alice.suffix}`;
  const droppedAcks = {
    alreadyPresent: 0,
    armed: false,
    dropped: 0,
    targetSends: 0,
    targetUpdateId: null as string | null
  };

  try {
    let bobPage = await newUserPage(browser, baseURL, contexts);
    await register(bobPage, bob.username, bob.password);
    await waitForSharingKey(bobPage);

    const aliceContext = await browser.newContext({ baseURL });
    contexts.push(aliceContext);
    const firstAlicePage = await aliceContext.newPage();
    await dropFirstDurableAck(firstAlicePage, droppedAcks);
    await register(firstAlicePage, alice.username, alice.password);
    await createNote(firstAlicePage, noteTitle, `Initial ${alice.suffix}`);
    await shareNote(firstAlicePage, bob.username, "editor");
    await openNote(bobPage, noteTitle);

    const secondAlicePage = await aliceContext.newPage();
    await signIn(secondAlicePage, alice.username, alice.password);
    await openNote(secondAlicePage, noteTitle);
    droppedAcks.armed = true;
    await blockEditor(firstAlicePage).press("ControlOrMeta+End");
    await blockEditor(firstAlicePage).pressSequentially(` lost-ack-${alice.suffix}`);
    await expect.poll(() => droppedAcks.dropped, { timeout: 10_000 }).toBe(1);
    await expect.poll(() => droppedAcks.targetSends, { timeout: 15_000 }).toBeGreaterThan(1);
    await expect(blockEditor(secondAlicePage)).toContainText(`lost-ack-${alice.suffix}`, {
      timeout: 15_000
    });
    await firstAlicePage.close();

    await bobPage.context().setOffline(true);
    await blockEditor(bobPage).press("ControlOrMeta+End");
    await blockEditor(bobPage).pressSequentially(` bob-offline-${alice.suffix}`);
    await expect(blockEditor(bobPage)).toContainText(`bob-offline-${alice.suffix}`);

    await blockEditor(secondAlicePage).press("ControlOrMeta+Home");
    await blockEditor(secondAlicePage).pressSequentially(`alice-online-${alice.suffix} `);
    await blockEditor(secondAlicePage).press("ControlOrMeta+End");
    await blockEditor(secondAlicePage).pressSequentially(` alice-tail-${alice.suffix}`);

    await bobPage.context().setOffline(false);
    await expect.poll(async () => {
      const values = await Promise.all([
        editorText(secondAlicePage),
        editorText(bobPage)
      ]);
      return new Set(values).size;
    }, { timeout: 30_000 }).toBe(1);
    const beforeRestart = await editorText(secondAlicePage);
    expect(beforeRestart).toContain(`bob-offline-${alice.suffix}`);
    expect(beforeRestart).toContain(`lost-ack-${alice.suffix}`);
    expect(beforeRestart).toContain(`alice-online-${alice.suffix}`);
    expect(beforeRestart).toContain(`alice-tail-${alice.suffix}`);

    const restarted = await restartManagedE2eServer();
    if (!restarted) {
      test.info().annotations.push({
        type: "managed-server",
        description: "API restart skipped because Playwright reused an external server"
      });
    }
    await expect.poll(async () => {
      const values = await Promise.all([
        editorText(secondAlicePage),
        editorText(bobPage)
      ]);
      return new Set(values).size;
    }, { timeout: 30_000 }).toBe(1);

    const postRestartSuffix = ` post-restart-${alice.suffix}`;
    await blockEditor(secondAlicePage).press("ControlOrMeta+End");
    await blockEditor(secondAlicePage).pressSequentially(postRestartSuffix);
    await expect(blockEditor(bobPage)).toContainText(postRestartSuffix, {
      timeout: 15_000
    });
    const finalBody = await editorText(secondAlicePage);

    await closePageContext(bobPage, contexts);
    bobPage = await newUserPage(browser, baseURL, contexts);
    await signIn(bobPage, bob.username, bob.password);
    await openNote(bobPage, noteTitle);
    await expect.poll(() => editorText(bobPage), { timeout: 20_000 }).toBe(finalBody);
  } finally {
    await closeContexts(contexts);
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
    await alicePage.getByRole("button", { name: "More note actions" }).click();
    await alicePage.getByRole("menuitem", { name: "Move to trash" }).click();
    await expect(alicePage.getByText("Note moved to trash")).toBeVisible();
    await alicePage.getByRole("button", { name: "Trash", exact: true }).click();
    await openNote(alicePage, noteTitle);
    await alicePage.getByRole("button", { name: "More note actions" }).click();
    await alicePage.getByRole("menuitem", { name: "Delete forever" }).click();
    await expect(alicePage.getByText("Note permanently deleted")).toBeVisible();

    await bobPage.context().setOffline(false);
    await expect(bobPage.getByRole("button", { name: noteTitlePattern(noteTitle) })).toHaveCount(0, {
      timeout: 15_000
    });
    await expect(blockEditor(bobPage)).toHaveCount(0);
  } finally {
    await closeContexts(contexts);
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
    await closeShareDialog(alicePage);
    await openNote(alicePage, otherTitle);
    await expect(alicePage.getByRole("button", { name: "Trust key" })).toHaveCount(0);
    expect(membershipPosted).toBe(false);
  } finally {
    await closeContexts(contexts);
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
    await closeContexts(contexts);
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

    await revokeMember(alicePage, bob.username, false);
    await expect(alicePage.getByText("Key rotation incomplete")).toBeVisible();
    const retryButton = alicePage.getByRole("button", { name: "Retry rotation", exact: true });
    await expect(retryButton).toBeVisible();

    await closeShareDialog(alicePage);
    await openNote(alicePage, otherTitle);
    await expect(retryButton).toHaveCount(0);
    await openNote(alicePage, noteTitle);
    await openShareDialog(alicePage);
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
    await closeContexts(contexts);
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

async function closeContexts(contexts: BrowserContext[]): Promise<void> {
  await Promise.all(
    contexts.splice(0).map((context) => context.close().catch(() => undefined))
  );
}

async function dropFirstDurableAck(
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

async function restartManagedE2eServer(): Promise<boolean> {
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

async function register(page: Page, username: string, password: string): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account" }).click();
  await page.getByLabel("Account handle").fill(username);
  await page.getByLabel("Account password").fill(password);
  await page.getByRole("button", { name: "Create encrypted vault" }).click();
  await expect(page.getByText("Signed in and decrypted")).toBeVisible();
}

async function signIn(page: Page, username: string, password: string): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Account handle").fill(username);
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

async function readOwnSharingFingerprint(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const fingerprint = page.locator(".sharing-fingerprint code");
  await expect(fingerprint).toBeVisible();
  const value = (await fingerprint.innerText()).trim();
  expect(value).toMatch(/^(?:[0-9A-F]{4} ){7}[0-9A-F]{4}$/);
  await page.getByRole("button", { name: "All notes", exact: true }).click();
  return value;
}

async function createNote(page: Page, title: string, body: string): Promise<void> {
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

async function shareNote(
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

async function openShareDialog(page: Page): Promise<import("@playwright/test").Locator> {
  const dialog = page.getByRole("dialog", { name: "Share note" });
  if (!(await dialog.isVisible())) {
    await page.getByRole("button", { name: "Share note" }).click();
    await expect(dialog).toBeVisible();
  }
  return dialog;
}

async function closeShareDialog(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Share note" });
  if (await dialog.isVisible()) {
    await page.getByRole("button", { name: "Close sharing dialog" }).click();
    await expect(dialog).not.toBeVisible();
  }
}

async function pageAttemptShare(
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

async function revokeMember(
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

async function changeMemberRole(
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

async function openNote(page: Page, title: string): Promise<void> {
  const pattern = new RegExp(`^${escapeRegExp(title)}`);
  await expect(page.getByRole("button", { name: pattern })).toBeVisible({
    timeout: 10_000
  });
  await page.getByRole("button", { name: pattern }).click();
}

async function editSelectedNote(page: Page, body: string): Promise<void> {
  await setEditorText(page, body);
  await waitForCrdtDurability(page);
}

function blockEditor(page: Page) {
  return page.locator(".block-editor .bn-editor");
}

async function editorText(page: Page): Promise<string> {
  return (await blockEditor(page).innerText()).trim();
}

async function setEditorText(page: Page, body: string): Promise<void> {
  const editor = blockEditor(page);
  await expect(editor).toBeVisible();
  await editor.click();
  await editor.press("ControlOrMeta+A");
  await editor.pressSequentially(body);
}

function captureRealtimeFrames(
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

interface ApiTraffic {
  attachmentUploads: number;
  requestBodies: Buffer[];
  responseBodies: Promise<Buffer>[];
}

function captureApiTraffic(page: Page, existing?: ApiTraffic): ApiTraffic {
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

async function readResponseBody(response: Response): Promise<Buffer> {
  try {
    return Buffer.from(await response.body());
  } catch {
    return Buffer.alloc(0);
  }
}

function isMediaApiUrl(url: string): boolean {
  return url.includes("/api/notes/") || url.includes("/api/attachments/");
}

async function insertImageBlock(page: Page): Promise<void> {
  const editor = blockEditor(page);
  await editor.focus();
  await editor.press("ControlOrMeta+End");
  await editor.press("Enter");
  await editor.pressSequentially("/image");
  await page.getByRole("option", { name: /^Image/ }).click();
  await expect(page.locator('[data-test="upload-tab"]')).toBeVisible();
  await expect(page.locator('[data-test="attachments-tab"]')).toBeVisible();
}

async function reloadAndUnlock(page: Page, password: string): Promise<void> {
  await page.reload();
  await page.getByLabel("Account password").fill(password);
  await page.getByRole("button", { name: "Sign in and decrypt" }).click();
  await expect(page.getByText("Signed in and decrypted")).toBeVisible();
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

function readStoredMedia(ownerUsername: string): {
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

function readStoredCollaboration(ownerUsername: string): {
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
