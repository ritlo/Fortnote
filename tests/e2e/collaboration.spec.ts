import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import {
  expect,
  test,
  type BrowserContext
} from "@playwright/test";
import { waitForCrdtDurability } from "./support/durability.js";
import {
  blockEditor,
  captureApiTraffic,
  captureRealtimeFrames,
  changeMemberRole,
  closeContexts,
  closePageContext,
  closeShareDialog,
  createNote,
  dropFirstDurableAck,
  editSelectedNote,
  editorText,
  escapeRegExp,
  insertImageBlock,
  lookupPublicSharingKey,
  newUserPage,
  noteTitlePattern,
  openNote,
  openShareDialog,
  pageAttemptShare,
  readOwnSharingFingerprint,
  readStoredCollaboration,
  readStoredMedia,
  register,
  reloadAndUnlock,
  restartManagedE2eServer,
  revokeMember,
  shareNote,
  signIn,
  uniqueAccount,
  waitForAttachmentUpload,
  waitForSharingKey
} from "./support/collaboration.js";

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
    alicePage.once("dialog", (dialog) => {
      void dialog.accept();
    });
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
