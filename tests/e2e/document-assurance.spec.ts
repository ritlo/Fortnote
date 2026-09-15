import { Buffer } from "node:buffer";
import { expect, test, type BrowserContext } from "@playwright/test";
import {
  MIB,
  REPRESENTATIVE_DOCUMENT,
  appendWithRecoverableChunkFault,
  captureDocumentTraffic,
  captureJsonControlRequests,
  closePerformanceContexts,
  createRepresentativeDocument,
  exerciseIndependentOfflineEdits,
  exerciseServerQuotaPressure,
  expectBoundedColdOpen,
  expectStoredLogicalSize,
  newPerformancePage,
  openDocument,
  registerPerformanceUser,
  representativeDocumentProfileFromEnvironment,
  shareDocument,
  signInPerformanceUser,
  uniquePerformanceAccount
} from "./support/performance.js";

const runDocumentAssurance = process.env.FORTNOTE_RUN_DOCUMENT_ASSURANCE === "1";

test.describe("representative focused document", () => {
  test.skip(
    !runDocumentAssurance,
    "Set FORTNOTE_RUN_DOCUMENT_ASSURANCE=1 to run the focused-document durability journey"
  );

  test("keeps a chunked document bounded, recoverable, and collaborative", async ({
    baseURL,
    browser
  }) => {
    test.setTimeout(30 * 60_000);
    const profile = representativeDocumentProfileFromEnvironment();
    const contexts: BrowserContext[] = [];
    const owner = uniquePerformanceAccount("document-owner");
    const collaborator = uniquePerformanceAccount("document-editor");
    const title = `Representative document ${owner.suffix}`;

    try {
      const collaboratorSetup = await newPerformancePage(browser, baseURL, contexts);
      await registerPerformanceUser(collaboratorSetup, collaborator);
      const collaboratorSetupContext = collaboratorSetup.context();
      await collaboratorSetupContext.close();
      contexts.splice(contexts.indexOf(collaboratorSetupContext), 1);

      const ownerPage = await newPerformancePage(browser, baseURL, contexts);
      await registerPerformanceUser(ownerPage, owner);
      const controls = captureJsonControlRequests(ownerPage);
      const dataset = await createRepresentativeDocument(ownerPage, title, profile);
      await expectStoredLogicalSize(ownerPage, profile.documentBytes);

      await appendWithRecoverableChunkFault(ownerPage, owner, title, "interrupt");
      await appendWithRecoverableChunkFault(ownerPage, owner, title, "corrupt");
      await exerciseServerQuotaPressure(ownerPage, owner, title);
      await shareDocument(ownerPage, collaborator.username, "editor");

      expect(
        Math.max(...controls.bodies.map((body) => body.byteLength))
      ).toBeLessThanOrEqual(MIB);
      expect(
        controls.bodies.some((body) => body.includes(Buffer.from(dataset.marker)))
      ).toBe(false);
      controls.stop();

      const collaboratorPage = await newPerformancePage(browser, baseURL, contexts);
      const traffic = captureDocumentTraffic(collaboratorPage, dataset.noteId);
      await signInPerformanceUser(collaboratorPage, collaborator);
      await openDocument(collaboratorPage, title, dataset.marker);
      await expectBoundedColdOpen(collaboratorPage, dataset, traffic);
      await exerciseIndependentOfflineEdits({ ownerPage, collaboratorPage });
      traffic.stop();

      if (process.env.FORTNOTE_DOCUMENT_BYTES === undefined) {
        expect(profile).toEqual(REPRESENTATIVE_DOCUMENT);
      }
    } finally {
      await closePerformanceContexts(contexts);
    }
  });
});
