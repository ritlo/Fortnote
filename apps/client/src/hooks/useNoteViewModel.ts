import { useCallback, useEffect, useMemo, useState } from "react";
import { listNoteSections } from "../api";
import type { BlockNoteFragmentSnapshot } from "../lib/blockNote";
import {
  defaultCollaborationDimensions,
  deriveCollaborationState
} from "../lib/collaborationState";
import { openFortnoteIndexedDb } from "../lib/indexedDb";
import {
  createProtectedSearchIndex,
  type ProtectedSearchIndex,
  type SearchCoverage,
  type SearchCoverageTarget,
  type SearchIndexBlock,
  type SearchMatch
} from "../lib/searchIndex";
import {
  openCrdtSection,
  releaseCrdtSection,
  snapshotReadyCrdtSection,
  subscribeCrdtSectionChanges,
  waitForCrdtSectionReady
} from "../realtime/crdt";
import {
  sectionRuntimeKey,
  useAppStore,
  type DecryptedNote,
  type NotesView
} from "../store/appStore";

interface NotesForViewInput {
  notes: DecryptedNote[];
  notesView: NotesView;
  selectedFolderId: string | null;
  trashNotes: DecryptedNote[];
}

export type SearchIndexStatus = "idle" | "discovering" | "indexing" | "ready" | "error";

interface SearchSession {
  index: ProtectedSearchIndex;
  targets: SearchCoverageTarget[];
}

interface QueryMatches {
  query: string;
  matches: SearchMatch[];
}

export function useNoteViewModel() {
  const notes = useAppStore((state) => state.notes);
  const trashNotes = useAppStore((state) => state.trashNotes);
  const notesView = useAppStore((state) => state.notesView);
  const selectedFolderId = useAppStore((state) => state.selectedFolderId);
  const selectedNoteId = useAppStore((state) => state.selectedNoteId);
  const attachmentsByNote = useAppStore((state) => state.attachmentsByNote);
  const search = useAppStore((state) => state.search);
  const user = useAppStore((state) => state.user);
  const rootKey = useAppStore((state) => state.rootKey);
  const realtimeStatus = useAppStore((state) => state.realtimeStatus);
  const removedNoteId = useAppStore((state) => state.removedNoteId);
  const revocationRotationPendingNoteId = useAppStore(
    (state) => state.revocationRotationPendingNoteId
  );
  const revocationRotationFailures = useAppStore(
    (state) => state.revocationRotationFailures
  );
  const noteProtectionFailures = useAppStore((state) => state.noteProtectionFailures);
  const localStorageCapacity = useAppStore((state) => state.localStorageCapacity);
  const serverStorageCapacity = useAppStore((state) => state.serverStorageCapacity);
  const recoverableDrafts = useAppStore((state) => state.recoverableDrafts);
  const loadedSections = useAppStore((state) => state.loadedSections);
  const selectedSectionByNote = useAppStore((state) => state.selectedSectionByNote);
  const error = useAppStore((state) => state.error);
  const operationFailure = useAppStore((state) => state.operationFailure);
  const [searchSession, setSearchSession] = useState<SearchSession | null>(null);
  const [searchCoverage, setSearchCoverage] = useState<SearchCoverage | null>(null);
  const [searchIndexStatus, setSearchIndexStatus] = useState<SearchIndexStatus>("idle");
  const [searchIndexError, setSearchIndexError] = useState<string | null>(null);
  const [searchRevision, setSearchRevision] = useState(0);
  const [searchRetryVersion, setSearchRetryVersion] = useState(0);
  const [queryMatches, setQueryMatches] = useState<QueryMatches>({
    query: "",
    matches: []
  });
  const searchableNotesSignature = searchableNoteSignature(notes);

  const viewNotes = useMemo(
    () => notesForView({ notes, notesView, selectedFolderId, trashNotes }),
    [notes, notesView, selectedFolderId, trashNotes]
  );

  const selectedNote = useMemo(
    () => viewNotes.find((note) => note.id === selectedNoteId) ?? null,
    [selectedNoteId, viewNotes]
  );

  const selectedAttachments = selectedNoteId
    ? (attachmentsByNote[selectedNoteId] ?? [])
    : [];
  const retainedDraft = selectedNote
    ? Object.values(recoverableDrafts).find(
        (draft) =>
          draft.noteId === selectedNote.id &&
          (draft.state === "retained" ||
            draft.state === "reviewing" ||
            draft.state === "exported")
      )
    : undefined;
  const selectedSectionId = selectedNote
    ? selectedSectionByNote[selectedNote.id]
    : undefined;
  const selectedSection =
    selectedNote && selectedSectionId
      ? loadedSections[sectionRuntimeKey(selectedNote.id, selectedSectionId)]
      : undefined;
  const collaborationState = deriveCollaborationState({
    ...defaultCollaborationDimensions,
    access: removedNoteId
      ? "removed"
      : notesView === "trash"
        ? "trash"
        : (selectedNote?.role ?? "owner"),
    protection:
      selectedNote && noteProtectionFailures[selectedNote.id] === "undecryptable"
        ? "undecryptable"
        : selectedNote && noteProtectionFailures[selectedNote.id] === "stale"
          ? "stale"
          : selectedNote?.id === revocationRotationPendingNoteId
            ? "preparing"
            : selectedNote && revocationRotationFailures[selectedNote.id]
              ? "aborted"
              : "ready",
    section: selectedNote
      ? selectedSection?.status === "ready"
        ? "ready"
        : selectedSection?.status === "loading"
          ? "loading"
          : "opening"
      : "idle",
    durability:
      localStorageCapacity.status === "full" || localStorageCapacity.status === "error"
        ? "local-full"
        : serverStorageCapacity.status === "full"
          ? "server-full"
          : serverStorageCapacity.status === "error"
            ? "compacting"
            : "clean",
    connection:
      realtimeStatus === "connecting"
        ? "reconnecting"
        : realtimeStatus === "disconnected"
          ? "offline"
          : "connected",
    recovery:
      retainedDraft?.state === "reviewing"
        ? "reviewing"
        : retainedDraft
          ? "divergent"
          : operationFailure
            ? operationFailure.kind === "conflict"
              ? "conflict"
              : operationFailure.kind === "generic"
                ? "error"
                : "none"
            : error
              ? "error"
              : "none",
    vault: selectedNote ? "ready" : viewNotes.length === 0 ? "empty" : "ready",
    draftRetained: Boolean(retainedDraft)
  });
  const normalizedSearch = normalizeSearch(search);
  const searchMatches =
    queryMatches.query === normalizedSearch ? queryMatches.matches : [];

  const filteredNotes = useMemo(() => {
    const matchingNoteIds = new Set(searchMatches.map((match) => match.noteId));
    const visibleNotes = !normalizedSearch
      ? viewNotes
      : viewNotes.filter(
          (note) =>
            normalizeSearch(note.title).includes(normalizedSearch) ||
            matchingNoteIds.has(note.id)
        );
    return [...visibleNotes].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt)
    );
  }, [normalizedSearch, searchMatches, viewNotes]);

  useEffect(() => {
    if (!user || !rootKey) {
      setSearchSession(null);
      setSearchCoverage(null);
      setSearchIndexStatus("idle");
      setSearchIndexError(null);
      return;
    }
    const controller = new AbortController();
    const requestScope = "protected-search-discovery";
    const requestToken = useAppStore.getState().beginRequest(requestScope);
    const throwIfStale = () => {
      throwIfCanceled(controller.signal);
      if (!useAppStore.getState().isCurrentRequest(requestScope, requestToken)) {
        throw new DOMException("Search request superseded", "AbortError");
      }
    };
    let database: Awaited<ReturnType<typeof openFortnoteIndexedDb>> | null = null;
    const userId = user.id;
    const vaultRootKey = rootKey;

    const searchTask = (async () => {
      setSearchSession(null);
      setSearchCoverage(null);
      setSearchIndexError(null);
      setSearchIndexStatus("discovering");
      database = await openFortnoteIndexedDb();
      throwIfStale();
      const index = createProtectedSearchIndex({
        database,
        rootKey: vaultRootKey,
        userId
      });
      const currentNotes = searchableNotes();
      const { failedNoteCount, targets } = await discoverSearchTargets(
        currentNotes,
        controller.signal
      );
      throwIfStale();
      const session = {
        index,
        targets
      };
      setSearchSession(session);
      let coverage = await index.coverage(targets);
      throwIfStale();
      setSearchCoverage(coverage);

      if (!normalizedSearch) {
        setSearchIndexStatus("idle");
        return;
      }

      while (!coverage.complete) {
        setSearchIndexStatus("indexing");
        coverage = await index.buildNextBatch(targets, (target) =>
          loadSearchSection(target, currentNotes, controller.signal)
        );
        throwIfStale();
        setSearchCoverage(coverage);
        setSearchRevision((revision) => revision + 1);
      }
      if (failedNoteCount > 0) {
        throw new Error(
          `Search coverage could not be determined for ${String(failedNoteCount)} note${
            failedNoteCount === 1 ? "" : "s"
          }.`
        );
      }
      setSearchIndexStatus("ready");
    })();
    void searchTask.catch((error: unknown) => {
      if (
        controller.signal.aborted ||
        !useAppStore.getState().isCurrentRequest(requestScope, requestToken)
      ) {
        return;
      }
      setSearchRevision((revision) => revision + 1);
      setSearchIndexStatus("error");
      setSearchIndexError(errorMessage(error, "Protected search indexing failed."));
    });

    return () => {
      controller.abort();
      useAppStore.getState().finishRequest(requestScope, requestToken);
      void searchTask.then(
        () => {
          database?.close();
        },
        () => {
          database?.close();
        }
      );
    };
  }, [normalizedSearch, rootKey, searchRetryVersion, searchableNotesSignature, user]);

  useEffect(() => {
    if (!searchSession) {
      return;
    }
    const controller = new AbortController();
    let pending = Promise.resolve();
    const unsubscribe = subscribeCrdtSectionChanges((change) => {
      const target = searchSession.targets.find(
        (candidate) => searchTargetKey(candidate) === searchTargetKey(change)
      );
      if (!target) {
        return;
      }
      target.serverSequence = Math.max(target.serverSequence, change.serverSequence);
      pending = pending
        .then(async () => {
          if (isCanceled(controller.signal)) {
            return;
          }
          const snapshot = snapshotReadyCrdtSection(
            change.noteId,
            change.keyEpoch,
            change.sectionId
          );
          if (!snapshot) {
            return;
          }
          await searchSession.index.applySection({
            ...target,
            blocks: searchBlocksFromSnapshot(snapshot)
          });
          const coverage = await searchSession.index.coverage(searchSession.targets);
          if (isCanceled(controller.signal)) {
            return;
          }
          setSearchCoverage(coverage);
          setSearchRevision((revision) => revision + 1);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) {
            return;
          }
          setSearchIndexStatus("error");
          setSearchIndexError(errorMessage(error, "Protected search refresh failed."));
        });
    });
    return () => {
      controller.abort();
      unsubscribe();
    };
  }, [searchSession]);

  useEffect(() => {
    if (!normalizedSearch || !searchSession) {
      setQueryMatches({ query: normalizedSearch, matches: [] });
      return;
    }
    const requestScope = "protected-search-query";
    const requestToken = useAppStore.getState().beginRequest(requestScope);
    const visibleNoteIds = new Set(viewNotes.map((note) => note.id));
    void searchSession.index
      .query(normalizedSearch, searchSession.targets)
      .then((result) => {
        if (!useAppStore.getState().isCurrentRequest(requestScope, requestToken)) {
          return;
        }
        setQueryMatches({
          query: normalizedSearch,
          matches: result.matches.filter((match) => visibleNoteIds.has(match.noteId))
        });
      })
      .catch((error: unknown) => {
        if (!useAppStore.getState().isCurrentRequest(requestScope, requestToken)) {
          return;
        }
        setQueryMatches({ query: normalizedSearch, matches: [] });
        setSearchIndexStatus("error");
        setSearchIndexError(errorMessage(error, "Protected search query failed."));
      });
    return () => {
      useAppStore.getState().finishRequest(requestScope, requestToken);
    };
  }, [normalizedSearch, searchRevision, searchSession, viewNotes]);

  const retrySearchIndex = useCallback(() => {
    setSearchRetryVersion((version) => version + 1);
  }, []);
  const selectSearchMatch = useCallback((match: SearchMatch) => {
    const state = useAppStore.getState();
    state.setSelectedNoteId(match.noteId);
    state.setSelectedSection(match.noteId, match.sectionId);
  }, []);

  return {
    filteredNotes,
    collaborationState,
    retrySearchIndex,
    searchCoverage,
    searchIndexError,
    searchIndexStatus,
    searchMatches,
    selectSearchMatch,
    selectedAttachments,
    selectedNote
  };
}

export function notesForView({
  notes,
  notesView,
  selectedFolderId,
  trashNotes
}: NotesForViewInput): DecryptedNote[] {
  switch (notesView) {
    case "settings":
      return [];
    case "trash":
      return trashNotes;
    case "shared":
      return notes.filter(isSharedNote);
    case "notes":
      return selectedFolderId
        ? notes.filter((note) => note.folderId === selectedFolderId)
        : notes;
  }
}

export function searchBlocksFromSnapshot(
  snapshot: BlockNoteFragmentSnapshot
): SearchIndexBlock[] {
  const blocks: SearchIndexBlock[] = [];
  visitSnapshotNodes(snapshot.content[0].content, blocks);
  return blocks;
}

async function discoverSearchTargets(
  notes: DecryptedNote[],
  signal: AbortSignal
): Promise<{ failedNoteCount: number; targets: SearchCoverageTarget[] }> {
  const targets: SearchCoverageTarget[] = [];
  let failedNoteCount = 0;
  for (const note of notes) {
    throwIfCanceled(signal);
    try {
      const response = await listNoteSections(note.id);
      throwIfCanceled(signal);
      targets.push(
        ...response.sections
          .filter((section) => section.initialized && !section.isDeleted)
          .map((section) => ({
            noteId: note.id,
            sectionId: section.id,
            keyEpoch: note.keyEpoch,
            serverSequence: section.currentSequence
          }))
      );
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      failedNoteCount += 1;
    }
  }
  return { failedNoteCount, targets };
}

async function loadSearchSection(
  target: SearchCoverageTarget,
  notes: DecryptedNote[],
  signal: AbortSignal
) {
  const note = notes.find(
    (candidate) =>
      candidate.id === target.noteId && candidate.keyEpoch === target.keyEpoch
  );
  if (!note) {
    throw new Error("Search target note is unavailable.");
  }
  const loaded =
    useAppStore.getState().loadedSections[
      sectionRuntimeKey(target.noteId, target.sectionId)
    ];
  const alreadyOpen =
    loaded?.keyEpoch === target.keyEpoch &&
    (loaded.status === "loading" || loaded.status === "ready");
  const lease = alreadyOpen ? null : openCrdtSection(note, target.sectionId);
  try {
    await waitForCrdtSectionReady(target.noteId, target.keyEpoch, target.sectionId, {
      signal
    });
    throwIfCanceled(signal);
    const snapshot = snapshotReadyCrdtSection(
      target.noteId,
      target.keyEpoch,
      target.sectionId
    );
    if (!snapshot) {
      throw new Error("Verified search section is unavailable.");
    }
    return {
      ...target,
      blocks: searchBlocksFromSnapshot(snapshot)
    };
  } finally {
    if (lease) {
      await releaseCrdtSection(
        target.noteId,
        target.sectionId,
        target.keyEpoch,
        lease.generation
      );
    }
  }
}

function searchableNotes(): DecryptedNote[] {
  return useAppStore.getState().notes.filter(isSearchableNote);
}

function searchableNoteSignature(notes: DecryptedNote[]): string {
  return notes
    .filter(isSearchableNote)
    .map((note) =>
      [note.id, note.keyEpoch, note.rootVersion ?? note.version, note.rootSectionId].join(
        ":"
      )
    )
    .sort()
    .join("|");
}

function isSearchableNote(note: DecryptedNote): boolean {
  return !note.isDeleted && Boolean(note.rootSectionId);
}

function visitSnapshotNodes(values: unknown[], blocks: SearchIndexBlock[]): void {
  for (const value of values) {
    if (!isRecord(value)) {
      continue;
    }
    if (value.type === "blockContainer") {
      const blockId =
        isRecord(value.attrs) && typeof value.attrs.id === "string" ? value.attrs.id : "";
      if (blockId) {
        blocks.push({ blockId, text: textWithinBlock(value, value) });
      }
    }
    if (Array.isArray(value.content)) {
      visitSnapshotNodes(value.content, blocks);
    }
  }
}

function textWithinBlock(value: unknown, root: Record<string, unknown>): string {
  if (!isRecord(value)) {
    return "";
  }
  if (value !== root && value.type === "blockContainer") {
    return "";
  }
  const ownText = typeof value.text === "string" ? value.text : "";
  const childText = Array.isArray(value.content)
    ? value.content.map((child) => textWithinBlock(child, root)).join(" ")
    : "";
  return `${ownText} ${childText}`.replace(/\s+/g, " ").trim();
}

function searchTargetKey(
  target: Pick<SearchCoverageTarget, "keyEpoch" | "noteId" | "sectionId">
): string {
  return `${target.noteId}\u0000${target.sectionId}\u0000${String(target.keyEpoch)}`;
}

function normalizeSearch(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().trim();
}

function isSharedNote(note: DecryptedNote): boolean {
  return note.role !== "owner";
}

function throwIfCanceled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("Search indexing canceled", "AbortError");
  }
}

function isCanceled(signal: AbortSignal): boolean {
  return signal.aborted;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
