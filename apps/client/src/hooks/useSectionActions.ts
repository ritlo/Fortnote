import { useRef } from "react";
import {
  createNoteSection,
  deleteNoteSection,
  initializeNoteSection,
  type LogicalNoteSectionSummary
} from "../api";
import {
  appendCrdtSectionContent,
  createCrdtSectionInitializationManifest,
  openCrdtSection,
  releaseCrdtSection,
  replaceCrdtSectionContent,
  replaceCrdtSectionOrder,
  snapshotCrdtSection,
  splitCrdtSectionContent,
  waitForCrdtSectionDurable,
  waitForCrdtSectionReady
} from "../realtime/crdt";
import {
  sectionRuntimeKey,
  useAppStore,
  type DecryptedNote,
  type NoteSectionIndexState
} from "../store/appStore";
import type { BlockNoteFragmentSnapshot } from "../lib/blockNote";

export interface SectionActions {
  createSection: () => Promise<void>;
  copySectionToNext: (sectionId: string) => Promise<void>;
  deleteSection: (sectionId: string) => Promise<void>;
  mergeSectionWithNext: (sectionId: string) => Promise<void>;
  moveSection: (sectionId: string, direction: -1 | 1) => Promise<void>;
  splitSection: (sectionId: string) => Promise<void>;
}

export function useSectionActions(note: DecryptedNote | null): SectionActions {
  const running = useRef(false);

  async function run(label: string, operation: (current: DecryptedNote) => Promise<void>) {
    if (running.current || !note || note.role === "viewer" || note.isDeleted) {
      return;
    }
    running.current = true;
    const { setError, setStatus } = useAppStore.getState();
    setError(null);
    setStatus(label);
    try {
      await operation(note);
      setStatus("Ready");
    } catch (error) {
      setStatus("Section operation failed");
      setError(error instanceof Error ? error.message : "Section operation failed");
    } finally {
      running.current = false;
    }
  }

  return {
    createSection: () => run("Creating encrypted section", async (current) => {
      const index = readyIndex(current.id);
      const selected = useAppStore.getState().selectedSectionByNote[current.id] ?? null;
      const insertion = selected ? index.orderedSectionIds.indexOf(selected) + 1 : index.orderedSectionIds.length;
      const created = await createInitializedSection(current);
      let published = false;
      try {
        const order = [...index.orderedSectionIds];
        order.splice(Math.max(0, insertion), 0, created.section.id);
        await commitOrder(created.note, order);
        published = true;
        publishCreatedSection(created.note, index, created.section, order);
      } finally {
        if (!published) {
          await cleanupUnpublishedSection(created.note, created.section.id);
        }
      }
    }),
    moveSection: (sectionId, direction) =>
      run("Reordering encrypted sections", async (current) => {
        const index = readyIndex(current.id);
        const from = index.orderedSectionIds.indexOf(sectionId);
        const to = from + direction;
        if (from < 0 || to < 0 || to >= index.orderedSectionIds.length) {
          return;
        }
        const order = [...index.orderedSectionIds];
        [order[from], order[to]] = [order[to]!, order[from]!];
        await commitOrder(current, order);
        updateIndex(index, { orderedSectionIds: order });
      }),
    deleteSection: (sectionId) =>
      run("Deleting encrypted section", async (current) => {
        const index = readyIndex(current.id);
        if (index.orderedSectionIds.length <= 1) {
          throw new Error("A note must keep at least one section");
        }
        const deleted = await deleteNoteSection(
          current.id,
          sectionId,
          mutationFence(current)
        );
        const advanced = updateNoteFence(current, deleted);
        const position = index.orderedSectionIds.indexOf(sectionId);
        const order = index.orderedSectionIds.filter((id) => id !== sectionId);
        await commitOrder(advanced, order);
        updateIndex(index, {
          orderedSectionIds: order,
          sections: index.sections.filter((section) => section.id !== sectionId)
        });
        const state = useAppStore.getState();
        state.setSelectedSection(
          current.id,
          order[Math.min(Math.max(position, 0), order.length - 1)] ?? null
        );
        state.setLoadedSection(null, sectionRuntimeKey(current.id, sectionId));
        await releaseCrdtSection(current.id, sectionId, current.keyEpoch);
      }),
    splitSection: (sectionId) =>
      run("Splitting encrypted section", async (current) => {
        const index = readyIndex(current.id);
        const split = splitCrdtSectionContent(current.id, sectionId);
        if (!split) {
          throw new Error("A section needs at least two blocks to split");
        }
        const created = await createInitializedSection(current, split.after);
        let published = false;
        try {
          const order = [...index.orderedSectionIds];
          const position = order.indexOf(sectionId);
          order.splice(position < 0 ? order.length : position + 1, 0, created.section.id);
          await commitOrder(created.note, order);
          published = true;
          publishCreatedSection(created.note, index, created.section, order);
          replaceCrdtSectionContent(current.id, sectionId, split.before);
          await waitForCrdtSectionDurable(current.id, current.keyEpoch, sectionId);
        } finally {
          if (!published) {
            await cleanupUnpublishedSection(created.note, created.section.id);
          }
        }
      }),
    mergeSectionWithNext: (sectionId) =>
      run("Merging encrypted sections", async (current) => {
        const index = readyIndex(current.id);
        const position = index.orderedSectionIds.indexOf(sectionId);
        const nextSectionId = index.orderedSectionIds[position + 1];
        if (!nextSectionId) {
          throw new Error("There is no following section to merge");
        }
        await ensureSectionReady(current, nextSectionId);
        appendCrdtSectionContent(
          current.id,
          sectionId,
          snapshotCrdtSection(current.id, nextSectionId)
        );
        await createCrdtSectionInitializationManifest(
          current.id,
          current.keyEpoch,
          sectionId
        );
        const deleted = await deleteNoteSection(
          current.id,
          nextSectionId,
          mutationFence(current)
        );
        const advanced = updateNoteFence(current, deleted);
        const order = index.orderedSectionIds.filter((id) => id !== nextSectionId);
        await commitOrder(advanced, order);
        updateIndex(index, {
          orderedSectionIds: order,
          sections: index.sections.filter((section) => section.id !== nextSectionId)
        });
        useAppStore.getState().setLoadedSection(
          null,
          sectionRuntimeKey(current.id, nextSectionId)
        );
        await releaseCrdtSection(current.id, nextSectionId, current.keyEpoch);
      }),
    copySectionToNext: (sectionId) =>
      run("Copying encrypted section content", async (current) => {
        const index = readyIndex(current.id);
        const position = index.orderedSectionIds.indexOf(sectionId);
        const targetSectionId = index.orderedSectionIds[position + 1];
        if (!targetSectionId) {
          throw new Error("There is no following section to copy into");
        }
        await ensureSectionReady(current, targetSectionId);
        appendCrdtSectionContent(
          current.id,
          targetSectionId,
          snapshotCrdtSection(current.id, sectionId)
        );
        await createCrdtSectionInitializationManifest(
          current.id,
          current.keyEpoch,
          targetSectionId
        );
      })
  };
}

async function createInitializedSection(
  note: DecryptedNote,
  snapshot?: BlockNoteFragmentSnapshot
): Promise<{ note: DecryptedNote; section: LogicalNoteSectionSummary }> {
  const sectionId = crypto.randomUUID();
  const created = await createNoteSection(note.id, {
    sectionId,
    ...mutationFence(note)
  });
  const advanced = updateNoteFence(note, created);
  try {
    await ensureSectionReady(advanced, sectionId);
    if (snapshot) {
      replaceCrdtSectionContent(note.id, sectionId, snapshot);
      await waitForCrdtSectionDurable(advanced.id, advanced.keyEpoch, sectionId);
    }
    const manifest = await createCrdtSectionInitializationManifest(
      advanced.id,
      advanced.keyEpoch,
      sectionId
    );
    await initializeNoteSection(advanced.id, sectionId, {
      manifestId: manifest.manifestId,
      ...mutationFence(advanced)
    });
    return {
      note: advanced,
      section: {
        ...created.section,
        initialized: true,
        currentSequence: manifest.lastSequence
      }
    };
  } catch (error) {
    await cleanupUnpublishedSection(advanced, sectionId);
    throw error;
  }
}

async function ensureSectionReady(note: DecryptedNote, sectionId: string): Promise<void> {
  openCrdtSection(note, sectionId);
  await waitForCrdtSectionReady(note.id, note.keyEpoch, sectionId);
}

async function commitOrder(note: DecryptedNote, order: string[]): Promise<void> {
  if (!replaceCrdtSectionOrder(note.id, order)) {
    throw new Error("Encrypted section order is not ready");
  }
  await waitForCrdtSectionDurable(note.id, note.keyEpoch, "root");
}

function publishCreatedSection(
  note: DecryptedNote,
  index: NoteSectionIndexState,
  section: LogicalNoteSectionSummary,
  order: string[]
): void {
  updateIndex(index, {
    orderedSectionIds: order,
    sections: [...index.sections, section]
  });
  const state = useAppStore.getState();
  state.setLoadedSection({
    noteId: note.id,
    sectionId: section.id,
    keyEpoch: note.keyEpoch,
    status: "ready",
    currentSequence: section.currentSequence,
    prefetched: false
  });
  state.setSelectedSection(note.id, section.id);
}

async function cleanupUnpublishedSection(note: DecryptedNote, sectionId: string): Promise<void> {
  await deleteNoteSection(note.id, sectionId, mutationFence(note))
    .then((deleted) => {
      updateNoteFence(note, deleted);
    })
    .catch(() => undefined);
  await releaseCrdtSection(note.id, sectionId, note.keyEpoch).catch(() => false);
}

function updateNoteFence(
  note: DecryptedNote,
  result: { rootVersion: number; version: number }
): DecryptedNote {
  const advanced = {
    ...note,
    rootVersion: result.rootVersion,
    version: result.version
  };
  useAppStore.getState().setNotes((notes) =>
    notes.map((candidate) =>
      candidate.id === note.id && candidate.keyEpoch === note.keyEpoch
        ? { ...candidate, rootVersion: result.rootVersion, version: result.version }
        : candidate
    )
  );
  return advanced;
}

function mutationFence(note: DecryptedNote) {
  return {
    expectedKeyEpoch: note.keyEpoch,
    expectedRootVersion: note.rootVersion ?? note.version
  };
}

function readyIndex(noteId: string): NoteSectionIndexState {
  const index = useAppStore.getState().sectionIndexes[noteId];
  if (index?.status !== "ready") {
    throw new Error("Encrypted section index is not ready");
  }
  return index;
}

function updateIndex(
  current: NoteSectionIndexState,
  patch: Partial<Pick<NoteSectionIndexState, "orderedSectionIds" | "sections">>
): void {
  useAppStore.getState().setSectionIndex(current.noteId, { ...current, ...patch });
}
