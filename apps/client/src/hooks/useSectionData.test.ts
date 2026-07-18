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
  getCrdtSectionOrder: vi.fn(),
  getStorageQuota: vi.fn(),
  listNoteSections: vi.fn(),
  openCrdtSection: vi.fn(),
  progressListener: undefined as ((value?: unknown) => void) | undefined,
  releaseCrdtSection: vi.fn(),
  waitForCrdtSectionReady: vi.fn()
}));

vi.mock("../api", () => ({
  getStorageQuota: mocks.getStorageQuota,
  listNoteSections: mocks.listNoteSections
}));

vi.mock("../realtime/crdt", () => ({
  getCrdtSectionOrder: mocks.getCrdtSectionOrder,
  openCrdtSection: mocks.openCrdtSection,
  releaseCrdtSection: mocks.releaseCrdtSection,
  waitForCrdtSectionReady: mocks.waitForCrdtSectionReady
}));

import { useSectionData } from "./useSectionData";

describe("useSectionData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.getState().resetVaultState("test reset");
    mocks.getCrdtSectionOrder.mockReturnValue(sectionIds(5));
    mocks.listNoteSections.mockResolvedValue({ sections: sections(5) });
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
});

function installNote(): DecryptedNote {
  const current = note();
  useAppStore.setState({
    user: { id: "user-1", username: "alice" },
    rootKey: Uint8Array.of(1),
    notes: [current],
    selectedNoteId: current.id
  });
  return current;
}

function note(): DecryptedNote {
  return {
    id: "note-1",
    folderId: null,
    title: "Large note",
    body: "",
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
    rootSectionId: "section-1"
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
