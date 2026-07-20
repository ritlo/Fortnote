import { Buffer } from "node:buffer";
import { expect, test, type BrowserContext } from "@playwright/test";
import {
  MIB,
  REPRESENTATIVE_LARGE_NOTE,
  appendWithRecoverableChunkFault,
  captureJsonControlRequests,
  captureSectionTraffic,
  closeLargeNoteContexts,
  closeLargeNotePage,
  createLargeNoteThroughEditor,
  exerciseIndependentOfflineEdits,
  exerciseSectionOperations,
  exerciseServerQuotaPressure,
  expectColdOpenIsolation,
  expectStoredLogicalSize,
  largeNoteProfileFromEnvironment,
  newLargeNotePage,
  openLargeNote,
  registerLargeNoteUser,
  searchAllSectionsWithoutRepeatTransfer,
  shareLargeNote,
  signInLargeNoteUser,
  uniqueLargeNoteAccount
} from "./support/largeNote.js";

const runLargeNote = process.env.FORTNOTE_RUN_LARGE_NOTE === "1";

test.describe("representative large note", () => {
  test.skip(
    !runLargeNote,
    "Set FORTNOTE_RUN_LARGE_NOTE=1 to run the 100 MiB actual-editor assurance journey"
  );

  test("keeps a 100 MiB/100-section note bounded, recoverable, and collaborative", async ({
    baseURL,
    browser
  }) => {
    test.setTimeout(30 * 60_000);
    const profile = largeNoteProfileFromEnvironment();
    const contexts: BrowserContext[] = [];
    const owner = uniqueLargeNoteAccount("large-owner");
    const collaborator = uniqueLargeNoteAccount("large-editor");
    const title = `Representative large note ${owner.suffix}`;

    try {
      const collaboratorSetup = await newLargeNotePage(browser, baseURL, contexts);
      await registerLargeNoteUser(collaboratorSetup, collaborator);
      await closeLargeNotePage(collaboratorSetup, contexts);

      const ownerPage = await newLargeNotePage(browser, baseURL, contexts);
      await registerLargeNoteUser(ownerPage, owner);
      const controls = captureJsonControlRequests(ownerPage);
      const dataset = await createLargeNoteThroughEditor(ownerPage, owner, title, profile);
      expect(dataset.sectionIds).toHaveLength(profile.sectionCount);
      await expectStoredLogicalSize(ownerPage, profile.logicalBytes);

      await ownerPage
        .getByRole("button", { name: "Section 1", exact: true })
        .focus();
      await ownerPage
        .getByRole("button", { name: "Section 1", exact: true })
        .press("Enter");
      await expect(ownerPage.locator(".section-position")).toHaveText(
        `Section 1 of ${String(profile.sectionCount)}`
      );

      await appendWithRecoverableChunkFault(ownerPage, owner, title, "interrupt");
      await appendWithRecoverableChunkFault(ownerPage, owner, title, "corrupt");
      await exerciseServerQuotaPressure(ownerPage, owner, title);
      await shareLargeNote(ownerPage, collaborator.username, "editor");

      expect(Math.max(...controls.bodies.map((body) => body.byteLength))).toBeLessThanOrEqual(MIB);
      expect(
        controls.bodies.some((body) => body.includes(Buffer.from(dataset.distantMarker)))
      ).toBe(false);
      controls.stop();

      const collaboratorPage = await newLargeNotePage(browser, baseURL, contexts);
      const traffic = captureSectionTraffic(collaboratorPage, dataset.noteId);
      await signInLargeNoteUser(collaboratorPage, collaborator);
      await openLargeNote(collaboratorPage, title);
      await expectColdOpenIsolation(collaboratorPage, dataset, traffic);

      await searchAllSectionsWithoutRepeatTransfer(
        collaboratorPage,
        dataset.distantMarker,
        profile.sectionCount,
        traffic
      );
      await exerciseIndependentOfflineEdits({
        ownerPage,
        collaboratorPage,
        distantPosition: profile.sectionCount
      });
      await exerciseSectionOperations(ownerPage, profile.sectionCount);
      traffic.stop();

      if (
        process.env.FORTNOTE_LARGE_NOTE_BYTES === undefined &&
        process.env.FORTNOTE_LARGE_NOTE_SECTIONS === undefined &&
        process.env.FORTNOTE_LARGE_NOTE_ACTIVE_BYTES === undefined
      ) {
        expect(profile).toEqual(REPRESENTATIVE_LARGE_NOTE);
      }
    } finally {
      await closeLargeNoteContexts(contexts);
    }
  });
});
