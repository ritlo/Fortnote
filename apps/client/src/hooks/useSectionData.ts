import { useCallback, useEffect, useRef, useState } from "react";
import {
  getStorageQuota,
  listNoteSections,
  type LogicalNoteSectionSummary
} from "../api";
import {
  getCrdtSectionOrder,
  openCrdtSection,
  releaseCrdtSection,
  waitForCrdtSectionReady
} from "../realtime/crdt";
import {
  sectionRuntimeKey,
  useAppStore,
  type DecryptedNote,
  type LoadedSectionState,
  type SectionTransferProgress,
  type StorageCapacityState
} from "../store/appStore";
import { ensureLegacyNoteMigrated } from "./useAppData";

const ROOT_SECTION_ID = "root";
const ADJACENT_PREFETCH_COUNT = 1;

export function useSectionData(selectedNote: DecryptedNote | null) {
  const selectedSectionId = useAppStore((state) =>
    selectedNote ? state.selectedSectionByNote[selectedNote.id] ?? null : null
  );
  const setSectionIndex = useAppStore((state) => state.setSectionIndex);
  const setLoadedSection = useAppStore((state) => state.setLoadedSection);
  const setSelectedSection = useAppStore((state) => state.setSelectedSection);
  const setLocalStorageCapacity = useAppStore(
    (state) => state.setLocalStorageCapacity
  );
  const setServerStorageCapacity = useAppStore(
    (state) => state.setServerStorageCapacity
  );
  const loadedTargetsRef = useRef(new Map<string, LoadedTarget>());
  const [retryVersion, setRetryVersion] = useState(0);

  useEffect(() => {
    if (
      !selectedNote?.legacyContentAvailable ||
      ((selectedNote.isDeleted || selectedNote.role === "viewer") &&
        selectedNote.legacyBodyLoaded)
    ) {
      return;
    }
    const controller = new AbortController();
    const note = selectedNote;
    setSectionIndex(note.id, {
      noteId: note.id,
      status: "loading",
      orderedSectionIds: [],
      sections: []
    });
    void ensureLegacyNoteMigrated(note, controller.signal).catch((error: unknown) => {
      if (controller.signal.aborted || !isSelectedNote(note)) {
        return;
      }
      setSectionIndex(note.id, {
        noteId: note.id,
        status: "error",
        orderedSectionIds: [],
        sections: [],
        error: errorMessage(error, "Legacy encrypted note could not migrate")
      });
    });
    return () => {
      controller.abort();
    };
  }, [
    retryVersion,
    selectedNote?.id,
    selectedNote?.isDeleted,
    selectedNote?.keyEpoch,
    selectedNote?.legacyBodyLoaded,
    selectedNote?.legacyContentAvailable,
    selectedNote?.role,
    selectedNote?.rootVersion
  ]);

  useEffect(() => {
    if (
      !selectedNote ||
      selectedNote.isDeleted ||
      (selectedNote.legacyContentAvailable &&
        (selectedNote.role !== "viewer" || !selectedNote.legacyBodyLoaded))
    ) {
      return;
    }
    const note = selectedNote;
    const rootLease = openCrdtSection(note, ROOT_SECTION_ID, (patch) => {
      if (patch.title === undefined) {
        return;
      }
      useAppStore.getState().setNotes((notes) =>
        notes.map((candidate) =>
          candidate.id === note.id
            ? { ...candidate, title: patch.title ?? candidate.title }
            : candidate
        )
      );
    });
    return () => {
      void releaseCrdtSection(
        note.id,
        ROOT_SECTION_ID,
        note.keyEpoch,
        rootLease.generation
      );
      for (const target of loadedTargetsRef.current.values()) {
        if (target.noteId === note.id) {
          void releaseTarget(target, setLoadedSection);
          loadedTargetsRef.current.delete(sectionRuntimeKey(target.noteId, target.sectionId));
        }
      }
    };
  }, [
    selectedNote?.id,
    selectedNote?.isDeleted,
    selectedNote?.keyEpoch,
    selectedNote?.legacyBodyLoaded,
    selectedNote?.legacyContentAvailable,
    selectedNote?.role
  ]);

  useEffect(() => {
    if (
      !selectedNote ||
      selectedNote.isDeleted ||
      selectedNote.legacyContentAvailable ||
      !selectedNote.rootSectionId
    ) {
      return;
    }
    const controller = new AbortController();
    const note = selectedNote;
    setSectionIndex(note.id, {
      noteId: note.id,
      status: "loading",
      orderedSectionIds: [],
      sections: []
    });

    void loadSectionIndex(note, controller.signal).catch((error: unknown) => {
      if (controller.signal.aborted || !isSelectedNote(note)) {
        return;
      }
      setSectionIndex(note.id, {
        noteId: note.id,
        status: "error",
        orderedSectionIds: [],
        sections: [],
        error: errorMessage(error, "Encrypted note index could not load")
      });
    });

    return () => {
      controller.abort();
    };
  }, [
    retryVersion,
    selectedNote?.id,
    selectedNote?.isDeleted,
    selectedNote?.keyEpoch,
    selectedNote?.legacyContentAvailable,
    selectedNote?.rootVersion,
    selectedNote?.rootSectionId
  ]);

  useEffect(() => {
    if (!selectedNote || selectedNote.isDeleted || !selectedSectionId) {
      return;
    }
    const index = useAppStore.getState().sectionIndexes[selectedNote.id];
    if (index?.status !== "ready") {
      return;
    }
    const controller = new AbortController();
    const note = selectedNote;
    const targets = requestedAndAdjacentSections(
      index.sections,
      index.orderedSectionIds,
      selectedSectionId
    );
    const targetKeys = new Set(
      targets.map(({ id }) => sectionRuntimeKey(note.id, id))
    );
    for (const [key, previous] of loadedTargetsRef.current) {
      if (previous.noteId === note.id && !targetKeys.has(key)) {
        loadedTargetsRef.current.delete(key);
        void releaseTarget(previous, setLoadedSection);
      }
    }

    void loadRequestedSections({
      note,
      selectedSectionId,
      targets,
      signal: controller.signal,
      loadedTargets: loadedTargetsRef.current,
      setLoadedSection
    });
    return () => {
      controller.abort();
    };
  }, [retryVersion, selectedNote?.id, selectedNote?.isDeleted, selectedNote?.keyEpoch, selectedSectionId]);

  useEffect(() => {
    if (!selectedNote || selectedNote.isDeleted) {
      return;
    }
    let active = true;
    void loadLocalCapacity().then((capacity) => {
      if (active) {
        setLocalStorageCapacity(capacity);
      }
    });
    void getStorageQuota()
      .then((quota) => {
        if (active) {
          setServerStorageCapacity({
            status: quota.availableBytes > 0 ? "available" : "full",
            usedBytes: quota.usedBytes + quota.reservedBytes,
            availableBytes: quota.availableBytes,
            quotaBytes: quota.quotaBytes
          });
        }
      })
      .catch(() => {
        if (active) {
          setServerStorageCapacity(capacityError());
        }
      });
    return () => {
      active = false;
    };
  }, [retryVersion, selectedNote?.id, selectedNote?.isDeleted]);

  return {
    retry: useCallback(() => {
      setRetryVersion((version) => version + 1);
    }, []),
    selectSection: useCallback(
      (sectionId: string) => {
        if (selectedNote) {
          setSelectedSection(selectedNote.id, sectionId);
        }
      },
      [selectedNote, setSelectedSection]
    )
  };
}

interface LoadedTarget {
  noteId: string;
  sectionId: string;
  keyEpoch: number;
  generation: number;
}

async function loadSectionIndex(note: DecryptedNote, signal: AbortSignal): Promise<void> {
  await waitForCrdtSectionReady(note.id, note.keyEpoch, ROOT_SECTION_ID, { signal });
  const response = await listNoteSections(note.id);
  throwIfCanceled(signal);
  const visibleIds = new Set(response.sections.map((section) => section.id));
  const encryptedOrder = getCrdtSectionOrder(note.id);
  const orderedSectionIds = encryptedOrder.length > 0
    ? encryptedOrder.filter((sectionId) => visibleIds.has(sectionId))
    : response.sections.map((section) => section.id);
  const state = useAppStore.getState();
  if (!isSelectedNote(note)) {
    return;
  }
  state.setSectionIndex(note.id, {
    noteId: note.id,
    status: "ready",
    orderedSectionIds,
    sections: response.sections
  });
  const selected = state.selectedSectionByNote[note.id];
  state.setSelectedSection(
    note.id,
    selected && visibleIds.has(selected)
      ? selected
      : (orderedSectionIds[0] ?? null)
  );
}

async function loadRequestedSections(input: {
  note: DecryptedNote;
  selectedSectionId: string;
  targets: LogicalNoteSectionSummary[];
  signal: AbortSignal;
  loadedTargets: Map<string, LoadedTarget>;
  setLoadedSection: ReturnType<typeof useAppStore.getState>["setLoadedSection"];
}): Promise<void> {
  const selected = input.targets.find(
    (section) => section.id === input.selectedSectionId
  );
  if (!selected) {
    return;
  }
  await loadOneSection(input, selected, false);
  if (input.signal.aborted) {
    return;
  }
  await Promise.all(
    input.targets
      .filter((section) => section.id !== selected.id)
      .map((section) => loadOneSection(input, section, true))
  );
}

async function loadOneSection(
  input: Parameters<typeof loadRequestedSections>[0],
  section: LogicalNoteSectionSummary,
  prefetched: boolean
): Promise<void> {
  const lease = openCrdtSection(input.note, section.id);
  const target = {
    noteId: input.note.id,
    sectionId: section.id,
    keyEpoch: input.note.keyEpoch,
    generation: lease.generation
  };
  const key = sectionRuntimeKey(target.noteId, target.sectionId);
  input.loadedTargets.set(key, target);
  input.setLoadedSection(sectionState(input.note, section, "loading", prefetched));
  const onProgress = (value?: unknown) => {
    if (
      !isSectionTransferProgress(value) ||
      input.loadedTargets.get(key) !== target
    ) {
      return;
    }
    input.setLoadedSection({
      ...sectionState(input.note, section, "loading", prefetched),
      transferProgress: value
    });
  };
  lease.provider.on("progress", onProgress);
  try {
    await waitForCrdtSectionReady(
      input.note.id,
      input.note.keyEpoch,
      section.id,
      { signal: input.signal }
    );
    throwIfCanceled(input.signal);
    if (!isSelectedNote(input.note) || input.loadedTargets.get(key) !== target) {
      return;
    }
    input.setLoadedSection(sectionState(input.note, section, "ready", prefetched));
  } catch (error) {
    if (input.signal.aborted || input.loadedTargets.get(key) !== target) {
      return;
    }
    input.setLoadedSection({
      ...sectionState(input.note, section, "error", prefetched),
      error: errorMessage(error, "Encrypted section could not load")
    });
  } finally {
    lease.provider.off("progress", onProgress);
  }
}

async function releaseTarget(
  target: LoadedTarget,
  setLoadedSection: ReturnType<typeof useAppStore.getState>["setLoadedSection"]
): Promise<void> {
  const key = sectionRuntimeKey(target.noteId, target.sectionId);
  const current = useAppStore.getState().loadedSections[key];
  if (current) {
    setLoadedSection({ ...current, status: "releasing" });
  }
  const released = await releaseCrdtSection(
    target.noteId,
    target.sectionId,
    target.keyEpoch,
    target.generation
  );
  if (released) {
    setLoadedSection(null, key);
  } else if (current) {
    setLoadedSection({
      ...current,
      status: "error",
      error: "Encrypted pending work prevented section release"
    });
  }
}

function requestedAndAdjacentSections(
  sections: LogicalNoteSectionSummary[],
  order: string[],
  requestedId: string
): LogicalNoteSectionSummary[] {
  const byId = new Map(sections.map((section) => [section.id, section]));
  const position = order.indexOf(requestedId);
  if (position < 0) {
    return [];
  }
  return order
    .slice(
      Math.max(0, position - ADJACENT_PREFETCH_COUNT),
      position + ADJACENT_PREFETCH_COUNT + 1
    )
    .map((sectionId) => byId.get(sectionId))
    .filter((section): section is LogicalNoteSectionSummary => section !== undefined);
}

function sectionState(
  note: DecryptedNote,
  section: LogicalNoteSectionSummary,
  status: LoadedSectionState["status"],
  prefetched: boolean
): LoadedSectionState {
  return {
    noteId: note.id,
    sectionId: section.id,
    keyEpoch: note.keyEpoch,
    status,
    currentSequence: section.currentSequence,
    prefetched
  };
}

async function loadLocalCapacity(): Promise<StorageCapacityState> {
  try {
    const estimate = await navigator.storage.estimate();
    const usedBytes = estimate.usage ?? 0;
    const quotaBytes = estimate.quota ?? 0;
    const availableBytes = Math.max(0, quotaBytes - usedBytes);
    return {
      status: quotaBytes > 0 && availableBytes === 0 ? "full" : "available",
      usedBytes,
      availableBytes,
      quotaBytes
    };
  } catch {
    return capacityError();
  }
}

function capacityError(): StorageCapacityState {
  return {
    status: "error",
    usedBytes: 0,
    availableBytes: 0,
    quotaBytes: 0
  };
}

function isSectionTransferProgress(value: unknown): value is SectionTransferProgress {
  if (!value || typeof value !== "object") {
    return false;
  }
  const progress = value as Partial<SectionTransferProgress>;
  return (
    (progress.phase === "uploading" ||
      progress.phase === "downloading" ||
      progress.phase === "verifying") &&
    typeof progress.completedChunks === "number" &&
    typeof progress.totalChunks === "number" &&
    typeof progress.transferredBytes === "number" &&
    typeof progress.totalBytes === "number"
  );
}

function isSelectedNote(note: DecryptedNote): boolean {
  const state = useAppStore.getState();
  return (
    state.selectedNoteId === note.id &&
    state.notes.some(
      (candidate) => candidate.id === note.id && candidate.keyEpoch === note.keyEpoch
    )
  );
}

function throwIfCanceled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("Section load canceled", "AbortError");
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
