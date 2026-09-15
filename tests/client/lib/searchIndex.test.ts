import { indexedDB as fakeIndexedDb } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFortnoteIndexedDb } from "@client/lib/indexedDb";
import {
  createProtectedSearchIndex,
  type SearchCoverageTarget
} from "@client/lib/searchIndex";

const databases: Awaited<ReturnType<typeof openFortnoteIndexedDb>>[] = [];

afterEach(async () => {
  await Promise.all(
    databases.splice(0).map(async (database) => database.deleteDatabase())
  );
});

describe("protected incremental search index", () => {
  it("reindexes only changed blocks and persists no plaintext terms", async () => {
    const database = await openDatabase();
    const tokenize = vi.fn((text: string) => text.toLocaleLowerCase().split(/\s+/u));
    const index = createProtectedSearchIndex({
      database,
      rootKey: key(1),
      tokenize,
      userId: "user-a"
    });

    await index.applySection(
      sectionUpdate(1, [
        { blockId: "block-a", text: "Alpha stable" },
        { blockId: "block-b", text: "Beta changes" }
      ])
    );
    const changed = await index.applySection(
      sectionUpdate(2, [
        { blockId: "block-a", text: "Alpha stable" },
        { blockId: "block-b", text: "Gamma changed" }
      ])
    );

    expect(tokenize).toHaveBeenCalledTimes(3);
    expect(changed.changedBlockIds).toEqual(["block-b"]);
    await expect(index.query("gamma", [target("section-a", 2)])).resolves.toMatchObject({
      coverage: { complete: true, indexedSections: 1, totalSections: 1 },
      matches: [{ blockId: "block-b", noteId: "note-a", sectionId: "section-a" }]
    });
    await expect(index.query("beta", [target("section-a", 2)])).resolves.toMatchObject({
      matches: []
    });
    expect(JSON.stringify(await database.listSearchIndex("user-a"))).not.toMatch(
      /alpha|beta|gamma|stable|changed/iu
    );
  });

  it("isolates encrypted records by account and root key", async () => {
    const database = await openDatabase();
    const first = createProtectedSearchIndex({
      database,
      rootKey: key(2),
      userId: "user-a"
    });
    const second = createProtectedSearchIndex({
      database,
      rootKey: key(3),
      userId: "user-b"
    });
    const wrongKey = createProtectedSearchIndex({
      database,
      rootKey: key(9),
      userId: "user-a"
    });
    await first.applySection(
      sectionUpdate(1, [{ blockId: "block-a", text: "private apricot" }])
    );
    await second.applySection(
      sectionUpdate(1, [{ blockId: "block-b", text: "private blueberry" }])
    );

    await expect(first.query("apricot", [target("section-a", 1)])).resolves.toMatchObject(
      { matches: [{ blockId: "block-a" }] }
    );
    await expect(
      first.query("blueberry", [target("section-a", 1)])
    ).resolves.toMatchObject({ matches: [] });
    await expect(
      second.query("blueberry", [target("section-a", 1)])
    ).resolves.toMatchObject({ matches: [{ blockId: "block-b" }] });
    await expect(
      wrongKey.query("apricot", [target("section-a", 1)])
    ).resolves.toMatchObject({
      coverage: { complete: false, indexedSections: 0 },
      matches: []
    });
    expect(await database.listSearchIndex("user-a")).toHaveLength(1);
    expect(await database.listSearchIndex("user-b")).toHaveLength(1);
  });

  it("reports sequence coverage until every target section is current", async () => {
    const database = await openDatabase();
    const index = createProtectedSearchIndex({
      database,
      rootKey: key(4),
      userId: "user-a"
    });
    const targets = [target("section-a", 5), target("section-b", 3)];
    await index.applySection(
      sectionUpdate(5, [{ blockId: "block-a", text: "covered result" }])
    );
    await index.applySection({
      ...sectionUpdate(2, [{ blockId: "block-b", text: "stale result" }]),
      sectionId: "section-b"
    });

    await expect(index.query("result", targets)).resolves.toMatchObject({
      coverage: {
        complete: false,
        indexedSections: 1,
        totalSections: 2,
        pending: [{ indexedSequence: 2, sectionId: "section-b", targetSequence: 3 }]
      },
      matches: [{ blockId: "block-a" }, { blockId: "block-b" }]
    });

    await index.applySection({
      ...sectionUpdate(3, [{ blockId: "block-b", text: "fresh result" }]),
      sectionId: "section-b"
    });
    await expect(index.query("result", targets)).resolves.toMatchObject({
      coverage: { complete: true, indexedSections: 2, pending: [] }
    });
  });

  it("returns matches only from the requested note, section, and epoch targets", async () => {
    const database = await openDatabase();
    const index = createProtectedSearchIndex({
      database,
      rootKey: key(6),
      userId: "user-a"
    });
    await index.applySection(
      sectionUpdate(1, [{ blockId: "included", text: "scoped result" }])
    );
    await index.applySection({
      ...sectionUpdate(1, [{ blockId: "excluded", text: "scoped result" }]),
      sectionId: "section-b"
    });

    await expect(index.query("scoped", [target("section-a", 1)])).resolves.toMatchObject({
      matches: [{ blockId: "included" }]
    });
  });

  it("builds bounded coverage while repeat queries transfer no sections", async () => {
    const database = await openDatabase();
    const yieldControl = vi.fn().mockResolvedValue(undefined);
    const loadSection = vi.fn((coverage: SearchCoverageTarget) =>
      Promise.resolve({
        ...coverage,
        blocks: [{ blockId: `block-${coverage.sectionId}`, text: "findable content" }]
      })
    );
    const index = createProtectedSearchIndex({
      database,
      maxSectionsPerBatch: 2,
      rootKey: key(5),
      userId: "user-a",
      yieldControl
    });
    const targets = [
      target("section-a", 1),
      target("section-b", 2),
      target("section-c", 3)
    ];

    const firstBatch = await index.buildNextBatch(targets, loadSection);

    expect(loadSection).toHaveBeenCalledTimes(2);
    expect(yieldControl).toHaveBeenCalledTimes(2);
    expect(firstBatch).toMatchObject({
      complete: false,
      indexedSections: 2,
      totalSections: 3
    });
    await index.query("findable", targets);
    await index.query("findable", targets);
    expect(loadSection).toHaveBeenCalledTimes(2);

    const complete = await index.buildNextBatch(targets, loadSection);
    expect(loadSection).toHaveBeenCalledTimes(3);
    expect(complete).toMatchObject({
      complete: true,
      indexedSections: 3,
      totalSections: 3
    });
  });
});

async function openDatabase() {
  const database = await openFortnoteIndexedDb({
    factory: fakeIndexedDb,
    name: `fortnote-search-test-${crypto.randomUUID()}`
  });
  databases.push(database);
  return database;
}

function key(seed: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, index) => (seed + index) % 256);
}

function sectionUpdate(
  serverSequence: number,
  blocks: { blockId: string; text: string }[]
) {
  return {
    blocks,
    keyEpoch: 1,
    noteId: "note-a",
    sectionId: "section-a",
    serverSequence
  };
}

function target(sectionId: string, serverSequence: number): SearchCoverageTarget {
  return {
    keyEpoch: 1,
    noteId: "note-a",
    sectionId,
    serverSequence
  };
}
