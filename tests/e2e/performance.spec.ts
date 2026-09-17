import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { performanceFixtureDefinition } from "../../scripts/create-performance-fixture.mjs";
import {
  captureDocumentTraffic,
  closePerformanceContexts,
  countCachedDocumentScopes,
  createRepresentativeDocument,
  expectBoundedColdOpen,
  newPerformancePage,
  openDocument,
  registerPerformanceUser,
  shareDocument,
  signInPerformanceUser
} from "./support/performance.js";
import { editableEditor } from "./support/editor.js";

const runPerformance = process.env.FORTNOTE_RUN_PERFORMANCE === "1";
const budgets = {
  "authenticated-action": 500,
  "collaborator-visible": 1_000,
  "fresh-session-usable": 5_000,
  "local-feedback": 100,
  "note-usable": 2_000,
  "representative-note-usable": 5_000
} as const;
type MetricName = keyof typeof budgets;

test.describe("controlled production performance", () => {
  test.skip(
    !runPerformance,
    "Run pnpm assurance:perf to create the isolated production fixture"
  );

  test("records focused-editor timings and bounded encrypted content residency", async ({
    baseURL,
    browser,
    browserName
  }) => {
    test.setTimeout(45 * 60_000);
    const performanceProfile =
      process.env.FORTNOTE_PERFORMANCE_PROFILE === "full" ? "full" : "smoke";
    const definition = performanceFixtureDefinition(
      process.env.FORTNOTE_PERFORMANCE_SEED,
      performanceProfile
    );
    const enforceBudgets =
      process.env.FORTNOTE_PERFORMANCE_ENFORCE_BUDGETS === "1" ||
      (performanceProfile === "full" &&
        process.env.FORTNOTE_PERFORMANCE_ENFORCE_BUDGETS !== "0");
    const samples = positiveInteger(
      process.env.FORTNOTE_PERFORMANCE_SAMPLES,
      definition.samples
    );
    const warmupRuns = positiveInteger(
      process.env.FORTNOTE_PERFORMANCE_WARMUPS,
      definition.warmupRuns
    );
    const profile = {
      documentBytes: positiveInteger(
        process.env.FORTNOTE_PERFORMANCE_DOCUMENT_BYTES,
        definition.documentBytes
      )
    };
    const contexts: BrowserContext[] = [];
    const raw = Object.fromEntries(
      Object.keys(budgets).map((name) => [name, []])
    ) as Record<MetricName, number[]>;
    let residentContentScopes = 0;
    let transferredBytes = 0;

    try {
      const editorPage = await newPerformancePage(browser, baseURL, contexts);
      await registerPerformanceUser(editorPage, definition.accounts.editor);
      const viewerPage = await newPerformancePage(browser, baseURL, contexts);
      await registerPerformanceUser(viewerPage, definition.accounts.viewer);
      const ownerPage = await newPerformancePage(browser, baseURL, contexts);
      await registerPerformanceUser(ownerPage, definition.accounts.owner);
      trackTransferBytes(ownerPage, (bytes) => {
        transferredBytes += bytes;
      });

      const ordinaryTitle = `Ordinary ${definition.seed}`;
      await createOrdinaryNote(ownerPage, ordinaryTitle);
      const dataset = await createRepresentativeDocument(
        ownerPage,
        definition.title,
        profile
      );
      await crossCompactionBoundary(ownerPage, definition.compactionEdits);
      await shareDocument(ownerPage, definition.accounts.editor.username, "editor");
      await shareDocument(ownerPage, definition.accounts.viewer.username, "viewer");
      await signInPerformanceUser(editorPage, definition.accounts.editor);
      await openDocument(editorPage, definition.title, dataset.marker);
      await signInPerformanceUser(viewerPage, definition.accounts.viewer);
      await openDocument(viewerPage, definition.title, dataset.marker);
      await expect(viewerPage.locator(".block-editor .bn-editor")).toHaveAttribute(
        "contenteditable",
        "false"
      );
      const samplePage = await newPerformancePage(browser, baseURL, contexts);
      const initialTraffic = captureDocumentTraffic(samplePage, dataset.noteId);
      trackTransferBytes(samplePage, (bytes) => {
        transferredBytes += bytes;
      });
      await signInPerformanceUser(samplePage, definition.accounts.owner);

      for (let run = 0; run < warmupRuns + samples; run += 1) {
        const retained = run >= warmupRuns;
        const traffic =
          run === 0 ? initialTraffic : captureDocumentTraffic(samplePage, dataset.noteId);
        const noteUsable = await userTiming(samplePage, "note-usable", async () => {
          await openOrdinaryNote(samplePage, ordinaryTitle);
        });
        const representativeUsable = await userTiming(
          samplePage,
          "representative-note-usable",
          async () => {
            await openDocument(samplePage, definition.title, dataset.marker);
          }
        );
        if (run === 0) await expectBoundedColdOpen(samplePage, dataset, traffic);
        residentContentScopes = Math.max(
          residentContentScopes,
          await countCachedDocumentScopes(samplePage, dataset.noteId)
        );
        expect(residentContentScopes).toBeLessThanOrEqual(2);
        traffic.stop();

        await samplePage.reload();
        await samplePage.getByRole("button", { name: "Sign in", exact: true }).click();
        const accountHandle = samplePage.getByLabel("Account handle");
        const accountPassword = samplePage.getByLabel("Account password");
        await accountHandle.fill(definition.accounts.owner.username);
        await accountPassword.fill(definition.accounts.owner.password);
        await expect(accountHandle).toHaveValue(definition.accounts.owner.username);
        await expect(accountPassword).toHaveValue(definition.accounts.owner.password);
        const freshSessionUsable = await userTiming(
          samplePage,
          "fresh-session-usable",
          async () => {
            await samplePage.getByRole("button", { name: "Sign in and decrypt" }).click();
            await expect(samplePage.getByText("Signed in and decrypted")).toBeVisible({
              timeout: 30_000
            });
            await openDocument(samplePage, definition.title, dataset.marker);
          }
        );

        const localFeedback = await userTiming(ownerPage, "local-feedback", async () => {
          await appendText(ownerPage, `l${String(run % 10)}`);
        });

        const currentTitle = `${definition.title} ${String(run).padStart(2, "0")}`;
        const authenticatedAction = await userTiming(
          ownerPage,
          "authenticated-action",
          async () => {
            const saved = ownerPage.waitForResponse(
              (response) =>
                response.request().method() === "PUT" &&
                response.url().includes(`/api/notes/${dataset.noteId}`) &&
                response.ok()
            );
            await ownerPage.getByRole("textbox", { name: "Title" }).fill(currentTitle);
            await saved;
            await expect(ownerPage.locator(".collaboration-status")).toContainText(
              "Saved and synchronized"
            );
          }
        );

        const marker = `remote-${String(run).padStart(2, "0")}`;
        const collaboratorVisible = await userTiming(
          editorPage,
          "collaborator-visible",
          async () => {
            await appendText(editorPage, marker);
            await expect(ownerPage.locator(".block-editor .bn-editor")).toContainText(
              marker,
              {
                timeout: 30_000
              }
            );
          }
        );

        if (retained) {
          raw["note-usable"].push(noteUsable);
          raw["representative-note-usable"].push(representativeUsable);
          raw["fresh-session-usable"].push(freshSessionUsable);
          raw["local-feedback"].push(localFeedback);
          raw["authenticated-action"].push(authenticatedAction);
          raw["collaborator-visible"].push(collaboratorVisible);
        }
      }

      for (const name of Object.keys(budgets) as MetricName[]) {
        expect(raw[name]).toHaveLength(samples);
        if (enforceBudgets) {
          expect(nearestRankP95(raw[name]), `${name} p95`).toBeLessThanOrEqual(
            budgets[name]
          );
          expect(
            raw[name].filter((value) => value <= budgets[name]).length / samples
          ).toBeGreaterThanOrEqual(0.95);
        }
      }

      const environment = {
        browser: `${browserName} ${browser.version()}`,
        buildMode: "production",
        collaborators: definition.collaborators,
        cpu: `${String(os.cpus().length)}x ${os.cpus()[0]?.model ?? "unknown"}`,
        database: "isolated PostgreSQL and database ciphertext storage",
        dataset: `${String(profile.documentBytes)} focused-document bytes/${String(definition.compactionEdits)} edits`,
        node: process.version,
        os: `${os.platform()} ${os.release()} ${os.arch()}`,
        warmupRuns
      };
      const metrics = (Object.keys(budgets) as MetricName[]).map((name) => ({
        budgetMs: budgets[name],
        name,
        p95Ms: nearestRankP95(raw[name]),
        samples: raw[name]
      }));
      const artifact = {
        budgetsEnforced: enforceBudgets,
        commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        dataset: {
          ...profile,
          collaborators: definition.collaborators,
          compactionEdits: definition.compactionEdits
        },
        environment,
        finishedAt: new Date().toISOString(),
        metrics,
        profile: performanceProfile,
        residentContentScopes,
        transferredBytes,
        warmupRuns
      };
      await compareBaseline(artifact);
      const outputDirectory = path.resolve(
        process.env.FORTNOTE_PERFORMANCE_OUTPUT ?? "test-results/performance"
      );
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(
        path.join(outputDirectory, "performance-results.json"),
        `${JSON.stringify(artifact, null, 2)}\n`,
        "utf8"
      );
    } finally {
      await closePerformanceContexts(contexts);
    }
  });
});

async function userTiming(
  page: Page,
  name: MetricName,
  action: () => Promise<void>
): Promise<number> {
  const id = `${name}-${crypto.randomUUID()}`;
  await page.evaluate((mark) => performance.mark(`${mark}:start`), id);
  await action();
  return page.evaluate(
    async ({ mark, metric }) => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            resolve();
          })
        )
      );
      performance.mark(`${mark}:end`);
      const measure = performance.measure(metric, `${mark}:start`, `${mark}:end`);
      performance.clearMarks(`${mark}:start`);
      performance.clearMarks(`${mark}:end`);
      performance.clearMeasures(metric);
      return measure.duration;
    },
    { mark: id, metric: name }
  );
}

async function createOrdinaryNote(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: "New note" }).click();
  await page
    .getByRole("dialog", { name: "New note" })
    .getByRole("button", { name: "Create" })
    .click();
  const titleInput = page.getByRole("textbox", { name: "Title" });
  await expect(titleInput).toHaveValue("Untitled note");
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().includes("/api/notes/") &&
      response.ok()
  );
  await titleInput.fill(title);
  await saved;
}

async function openOrdinaryNote(page: Page, title: string): Promise<void> {
  const card = page.getByRole("button", { name: new RegExp(title, "u") });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.click();
  await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue(title);
  await expect(page.locator(".block-editor .bn-editor")).toBeVisible();
}

async function crossCompactionBoundary(page: Page, edits: number): Promise<void> {
  const editor = await editableEditor(page);
  await editor.focus();
  await editor.press("ControlOrMeta+End");
  for (let edit = 0; edit < edits; edit += 1) await editor.pressSequentially("c");
  await expect(page.locator(".collaboration-status")).toContainText(
    "Saved and synchronized",
    {
      timeout: 120_000
    }
  );
}

async function appendText(page: Page, text: string): Promise<void> {
  const editor = await editableEditor(page);
  await editor.focus();
  await editor.press("ControlOrMeta+End");
  await editor.pressSequentially(text);
  await expect(editor).toContainText(text);
}

function nearestRankP95(samples: number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(0.95 * sorted.length) - 1];
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error("Expected a positive integer");
  return parsed;
}

function trackTransferBytes(page: Page, record: (bytes: number) => void): void {
  page.on("request", (request) => {
    record(request.postDataBuffer()?.byteLength ?? 0);
  });
  page.on("response", (response) => {
    const value = Number(response.headers()["content-length"] ?? 0);
    if (Number.isFinite(value)) record(value);
  });
}

async function compareBaseline(artifact: {
  environment: object;
  metrics: { name: MetricName; p95Ms: number }[];
}) {
  const baselinePath = process.env.FORTNOTE_PERFORMANCE_BASELINE;
  if (!baselinePath) return;
  const baseline = JSON.parse(
    await readFile(path.resolve(baselinePath), "utf8")
  ) as typeof artifact;
  expect(baseline.environment).toEqual(artifact.environment);
  for (const metric of artifact.metrics) {
    const previous = baseline.metrics.find((candidate) => candidate.name === metric.name);
    if (!previous) throw new Error(`Baseline is missing ${metric.name}`);
    expect(metric.p95Ms, `${metric.name} regression`).toBeLessThanOrEqual(
      previous.p95Ms * 1.1
    );
  }
}
