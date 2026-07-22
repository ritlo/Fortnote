// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogicalNoteSectionSummary } from "../api";
import {
  sectionRuntimeKey,
  useAppStore,
  type DecryptedNote
} from "../store/appStore";

const mocks = vi.hoisted(() => ({
  createCrdtSectionInitializationManifest: vi.fn(),
  getCrdtSectionOrder: vi.fn(),
  isCrdtHistoryUnreadableError: vi.fn(),
  getStorageQuota: vi.fn(),
  initializeNoteSection: vi.fn(),
  listNoteSections: vi.fn(),
  migrateLegacyNote: vi.fn(),
  openCrdtSection: vi.fn(),
  progressListener: undefined as ((value?: unknown) => void) | undefined,
  releaseCrdtSection: vi.fn(),
  waitForCrdtSectionReady: vi.fn()
}));

vi.mock("../api", () => ({
  getStorageQuota: mocks.getStorageQuota,
  initializeNoteSection: mocks.initializeNoteSection,
  listNoteSections: mocks.listNoteSections
}));

vi.mock("../realtime/crdt", () => ({
  createCrdtSectionInitializationManifest: mocks.createCrdtSectionInitializationManifest,
  getCrdtSectionOrder: mocks.getCrdtSectionOrder,
  isCrdtHistoryUnreadableError: mocks.isCrdtHistoryUnreadableError,
  openCrdtSection: mocks.openCrdtSection,
  releaseCrdtSection: mocks.releaseCrdtSection,
  waitForCrdtSectionReady: mocks.waitForCrdtSectionReady
}));

vi.mock("./useAppData", () => ({
  ensureLegacyNoteMigrated: mocks.migrateLegacyNote
}));

import { useSectionData } from "./useSectionData";

describe("useSectionData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.getState().resetVaultState("test reset");
    mocks.getCrdtSectionOrder.mockReturnValue(sectionIds(5));
    mocks.isCrdtHistoryUnreadableError.mockImplementation(
      (error: unknown) => error instanceof Error && error.message === "Realtime history could not be decrypted"
    );
    mocks.createCrdtSectionInitializationManifest.mockResolvedValue({
      manifestId: "manifest-1",
      lastSequence: 1
    });
    mocks.initializeNoteSection.mockResolvedValue({
      status: "installed",
      manifestId: "manifest-1",
      rootVersion: 1,
      version: 1
    });
    mocks.listNoteSections.mockResolvedValue({ sections: sections(5) });
    mocks.migrateLegacyNote.mockResolvedValue(undefined);
    mocks.getStorageQuota.mockResolvedValue({
      usedBytes: 100,
      reservedBytes: 20,
      quotaBytes: 1000,
      availableBytes: 880
    });
    mocks.waitForCrdtSectionReady.mockResolvedValue(undefined);
    mocks.releaseCrdtSection.mockResolvedValue(true);
    mocks.progressListener = undefined;
    mocks.openCrdtSection.mockImplementation(() => ({
      generation: mocks.openCrdtSection.mock.calls.length,
      provider: {
        off: vi.fn(),
        on: (event: string, listener: (value?: unknown) => void) => {
          if (event === "progress") {
            mocks.progressListener = listener;
          }
        }
      }
    }));
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: { estimate: vi.fn().mockResolvedValue({ usage: 50, quota: 500 }) }
    });
  });

  afterEach(() => {
    cleanup();
    useAppStore.getState().resetVaultState("test reset");
  });

  it("loads root first, then only the requested section and bounded adjacent prefetch", async () => {
    const current = installNote();
    const root = deferred<undefined>();
    const requested = deferred<undefined>();
    mocks.waitForCrdtSectionReady.mockImplementation(
      (_noteId: string, _keyEpoch: number, sectionId: string) => {
        if (sectionId === "root") {
          return root.promise;
        }
        if (sectionId === "section-1") {
          return requested.promise;
        }
        return Promise.resolve();
      }
    );

    renderHook(() => useSectionData(current));
    expect(mocks.openCrdtSection).toHaveBeenCalledWith(
      current,
      "root",
      expect.any(Function)
    );
    expect(mocks.listNoteSections).not.toHaveBeenCalled();

    await act(async () => {
      root.resolve(undefined);
      await root.promise;
    });
    await waitFor(() => {
      expect(mocks.openCrdtSection).toHaveBeenCalledWith(current, "section-1");
    });
    expect(openedBodySections()).toEqual(["section-1"]);
    act(() => {
      mocks.progressListener?.({
        phase: "downloading",
        completedChunks: 2,
        totalChunks: 4,
        transferredBytes: 512,
        totalBytes: 1024
      });
    });
    expect(sectionState(current.id, "section-1")?.transferProgress).toMatchObject({
      completedChunks: 2,
      transferredBytes: 512
    });

    await act(async () => {
      requested.resolve(undefined);
      await requested.promise;
    });
    await waitFor(() => {
      expect(openedBodySections()).toEqual(["section-1", "section-2"]);
    });
    expect(openedBodySections()).not.toContain("section-3");
    expect(useAppStore.getState().loadedSections).toMatchObject({
      [sectionRuntimeKey(current.id, "section-1")]: {
        status: "ready",
        prefetched: false
      },
      [sectionRuntimeKey(current.id, "section-2")]: {
        status: "ready",
        prefetched: true
      }
    });
  });

  it("keeps server-created sections visible while root ordering catches up", async () => {
    const current = installNote();
    mocks.getCrdtSectionOrder.mockReturnValue(["section-1"]);
    useAppStore.getState().setSelectedSection(current.id, "section-1");

    renderHook(() => useSectionData(current));

    await waitFor(() => {
      expect(useAppStore.getState().sectionIndexes[current.id]?.orderedSectionIds)
        .toEqual(sectionIds(5));
    });
    await waitFor(() => {
      expect(mocks.openCrdtSection).toHaveBeenCalledWith(current, "section-1");
    });
  });

  it("initializes a new protected root section before exposing it as ready", async () => {
    const current = installNote();
    mocks.listNoteSections.mockResolvedValue({
      sections: [{ ...sections(1)[0]!, initialized: false }]
    });

    renderHook(() => useSectionData(current));

    await waitFor(() => {
      expect(mocks.initializeNoteSection).toHaveBeenCalledWith(
        current.id,
        "section-1",
        {
          manifestId: "manifest-1",
          expectedKeyEpoch: current.keyEpoch,
          expectedRootVersion: current.rootVersion
        }
      );
    });
    expect(useAppStore.getState().sectionIndexes[current.id]?.sections[0]).toMatchObject({
      initialized: true,
      currentSequence: 1
    });
    expect(sectionState(current.id, "section-1")).toMatchObject({
      status: "ready",
      currentSequence: 1
    });
  });

  it("gates section subscriptions while a legacy body is migrating", async () => {
    const current = installNote({
      legacyContentAvailable: true,
      legacyBodyLoaded: false,
      rootSectionId: null
    });

    renderHook(() => useSectionData(current));

    await waitFor(() => {
      expect(mocks.migrateLegacyNote).toHaveBeenCalledWith(
        current,
        expect.any(AbortSignal)
      );
    });
    expect(mocks.openCrdtSection).not.toHaveBeenCalled();
    expect(mocks.listNoteSections).not.toHaveBeenCalled();
    expect(useAppStore.getState().sectionIndexes[current.id]).toMatchObject({
      status: "loading"
    });
  });

  it("keeps a released section visible as releasing until pending-safe cleanup completes", async () => {
    const current = installNote();
    const release = deferred<boolean>();
    mocks.releaseCrdtSection.mockImplementation(
      (_noteId: string, sectionId: string) =>
        sectionId === "section-1" ? release.promise : Promise.resolve(true)
    );
    renderHook(() => useSectionData(current));
    await waitFor(() => {
      expect(sectionState(current.id, "section-1")?.status).toBe("ready");
    });

    act(() => {
      useAppStore.getState().setSelectedSection(current.id, "section-3");
    });
    await waitFor(() => {
      expect(sectionState(current.id, "section-1")?.status).toBe("releasing");
    });
    expect(mocks.releaseCrdtSection).toHaveBeenCalledWith(
      current.id,
      "section-1",
      current.keyEpoch,
      expect.any(Number)
    );

    await act(async () => {
      release.resolve(true);
      await release.promise;
    });
    await waitFor(() => {
      expect(sectionState(current.id, "section-1")).toBeUndefined();
    });
  });

  it("does not commit a stale requested section after navigation changes", async () => {
    const current = installNote();
    renderHook(() => useSectionData(current));
    await waitFor(() => {
      expect(sectionState(current.id, "section-1")?.status).toBe("ready");
    });
    const stale = deferred<undefined>();
    mocks.waitForCrdtSectionReady.mockImplementation(
      (_noteId: string, _keyEpoch: number, sectionId: string) =>
        sectionId === "section-3" ? stale.promise : Promise.resolve()
    );

    act(() => {
      useAppStore.getState().setSelectedSection(current.id, "section-3");
    });
    await waitFor(() => {
      expect(sectionState(current.id, "section-3")?.status).toBe("loading");
    });
    act(() => {
      useAppStore.getState().setSelectedSection(current.id, "section-5");
    });
    await waitFor(() => {
      expect(sectionState(current.id, "section-5")?.status).toBe("ready");
    });

    await act(async () => {
      stale.resolve(undefined);
      await stale.promise;
    });
    await waitFor(() => {
      expect(sectionState(current.id, "section-3")).toBeUndefined();
    });
  });

  it("reopens the selected section when access changes", async () => {
    const current = installNote();
    const { rerender } = renderHook(
      ({ note: selected }) => useSectionData(selected),
      { initialProps: { note: current } }
    );

    await waitFor(() => {
      expect(sectionState(current.id, "section-1")?.status).toBe("ready");
    });
    const openedBeforeRoleChange = mocks.openCrdtSection.mock.calls.length;

    const viewer = { ...current, role: "viewer" as const };
    rerender({ note: viewer });

    await waitFor(() => {
      expect(mocks.openCrdtSection.mock.calls.length).toBeGreaterThan(
        openedBeforeRoleChange
      );
    });
  });

  it("reports local browser pressure separately from available server quota", async () => {
    const current = installNote();
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: { estimate: vi.fn().mockResolvedValue({ usage: 500, quota: 500 }) }
    });
    renderHook(() => useSectionData(current));

    await waitFor(() => {
      expect(useAppStore.getState().localStorageCapacity.status).toBe("full");
      expect(useAppStore.getState().serverStorageCapacity.status).toBe("available");
    });
    expect(useAppStore.getState().localStorageCapacity).toMatchObject({
      usedBytes: 500,
      availableBytes: 0
    });
    expect(useAppStore.getState().serverStorageCapacity).toMatchObject({
      usedBytes: 120,
      availableBytes: 880
    });
  });

  it("surfaces undecryptable history as note protection state", async () => {
    const current = installNote();
    mocks.waitForCrdtSectionReady.mockRejectedValueOnce(
      new Error("Realtime history could not be decrypted")
    );

    renderHook(() => useSectionData(current));

    await waitFor(() => {
      expect(useAppStore.getState().noteProtectionFailures).toEqual({
        [current.id]: "undecryptable"
      });
    });
  });

  it("retains stable ordered section blocks for legacy encrypted content after migration", async () => {
    const current = installNote({
      legacyContentAvailable: true,
      legacyBodyLoaded: false,
      rootSectionId: null
    });
    mocks.getCrdtSectionOrder.mockReturnValue(["section-1", "section-2"]);
    mocks.waitForCrdtSectionReady.mockResolvedValue(undefined);

    renderHook(() => useSectionData(current));

    await waitFor(() => {
      expect(mocks.migrateLegacyNote).toHaveBeenCalled();
    });
    act(() => {
      useAppStore.getState().setSectionIndex(current.id, {
        noteId: current.id,
        status: "ready",
        orderedSectionIds: ["section-1", "section-2"],
        sections: sections(2)
      });
    });
    const index = useAppStore.getState().sectionIndexes[current.id];
    expect(index?.orderedSectionIds).toEqual(["section-1", "section-2"]);
  });

  it("handles empty section index without exposing navigation", () => {
    const current = installNote();
    useAppStore.getState().setSectionIndex(current.id, {
      noteId: current.id,
      status: "ready",
      orderedSectionIds: [],
      sections: []
    });
    const index = useAppStore.getState().sectionIndexes[current.id];
    expect(index?.orderedSectionIds).toEqual([]);
    expect(useAppStore.getState().selectedSectionByNote[current.id]).toBeUndefined();
  });

  it("preserves ordered multi-section content as a stable ordered list", async () => {
    const current = installNote();
    const expected = sectionIds(3);
    mocks.getCrdtSectionOrder.mockReturnValue(expected);
    mocks.listNoteSections.mockResolvedValue({ sections: sections(3) });

    renderHook(() => useSectionData(current));

    await waitFor(() => {
      const index = useAppStore.getState().sectionIndexes[current.id];
      expect(index?.orderedSectionIds).toHaveLength(3);
    });
    const index = useAppStore.getState().sectionIndexes[current.id];
    expect(index?.orderedSectionIds).toEqual(expected);
    expect(index?.sections).toHaveLength(3);
  });
});

function installNote(overrides: Partial<DecryptedNote> = {}): DecryptedNote {
  const current = note(overrides);
  useAppStore.setState({
    user: { id: "user-1", username: "alice" },
    rootKey: Uint8Array.of(1),
    notes: [current],
    selectedNoteId: current.id
  });
  return current;
}

function note(overrides: Partial<DecryptedNote> = {}): DecryptedNote {
  return {
    id: "note-1",
    folderId: null,
    title: "Large note",
    noteKeyBase64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    contentLength: 0,
    version: 1,
    keyEpoch: 1,
    isDeleted: false,
    updatedAt: "2026-07-18T00:00:00.000Z",
    ownerUserId: "user-1",
    cryptoOwnerId: "user-1",
    role: "owner",
    rootVersion: 1,
    rootSectionId: "section-1",
    ...overrides
  };
}

function sections(count: number): LogicalNoteSectionSummary[] {
  return sectionIds(count).map((id) => ({
    id,
    noteId: "note-1",
    createdEpoch: 1,
    currentSequence: 0,
    initialized: true,
    isDeleted: false
  }));
}

function sectionIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `section-${String(index + 1)}`);
}

function openedBodySections(): string[] {
  return mocks.openCrdtSection.mock.calls
    .map(([, sectionId]) => sectionId as string)
    .filter((sectionId) => sectionId !== "root");
}

function sectionState(noteId: string, sectionId: string) {
  return useAppStore.getState().loadedSections[sectionRuntimeKey(noteId, sectionId)];
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}
