import { toBase64 } from "@fortnote/shared";
import { useMemo } from "react";
import { downloadBytes } from "../lib/browser";
import { openFortnoteIndexedDb, type EncryptedOutboxRecord } from "../lib/indexedDb";
import { createCrdtSectionInitializationManifest, waitForCrdtSectionDurable } from "../realtime/crdt";
import { useAppStore, type DecryptedNote, type RecoverableSectionDraft } from "../store/appStore";
import type { RecoveryCallbacks } from "../components/RecoveryPanel";
import type { SectionActions } from "./useSectionActions";

export function useRecoveryActions(
  note: DecryptedNote | null,
  sectionActions: SectionActions,
  retry: () => void
): RecoveryCallbacks {
  const draft = useAppStore((state) => note
    ? Object.values(state.recoverableDrafts).find(
        (candidate) =>
          candidate.noteId === note.id &&
          (candidate.state === "retained" ||
            candidate.state === "reviewing" ||
            candidate.state === "exported")
      ) ?? null
    : null
  );

  return useMemo(() => {
    const run = async (operation: (current: RecoverableSectionDraft) => Promise<void>) => {
      if (!draft) return;
      const { setError } = useAppStore.getState();
      setError(null);
      try {
        await operation(draft);
      } catch (error) {
        setError(error instanceof Error ? error.message : "Draft recovery failed");
      }
    };
    const resolveDraft = async (
      current: RecoverableSectionDraft,
      state: "reapplied" | "split" | "discarded"
    ) => {
      await withDatabase(async (database) => database.deleteOutboxFence(current));
      useAppStore.getState().setRecoverableDraftState(current.id, state);
    };
    const exportText = async (current: RecoverableSectionDraft) =>
      withDatabase(async (database) => encryptedDraftJson(current, await database.listOutbox(current.userId)));

    return {
      cleanup: () => run(async (current) => {
        await withDatabase(async (database) => database.evictSectionCache(current.userId, 0));
        retry();
      }),
      copy: () => run(async (current) => {
        await navigator.clipboard.writeText(await exportText(current));
      }),
      discard: () => run(async (current) => {
        if (globalThis.confirm("Permanently discard this retained encrypted draft?")) {
          await resolveDraft(current, "discarded");
        }
      }),
      encryptedExport: () => run(async (current) => {
        const text = await exportText(current);
        downloadBytes(
          new TextEncoder().encode(text),
          `fortnote-draft-${current.noteId}-${current.sectionId}.json`,
          "application/json"
        );
        useAppStore.getState().setRecoverableDraftState(current.id, "exported");
      }),
      reapply: () => run(async (current) => {
        assertCurrentEditableDraft(note, current);
        await createCrdtSectionInitializationManifest(note.id, note.keyEpoch, current.sectionId);
        await waitForCrdtSectionDurable(note.id, note.keyEpoch, current.sectionId);
        await resolveDraft(current, "reapplied");
      }),
      repairAccess: retry,
      retry,
      reviewAccess: retry,
      reviewDraft: () => {
        if (!draft) return;
        useAppStore.getState().setSelectedSection(draft.noteId, draft.sectionId);
        useAppStore.getState().setRecoverableDraftState(draft.id, "reviewing");
      },
      splitSection: () => run(async (current) => {
        assertCurrentEditableDraft(note, current);
        await sectionActions.splitSection(current.sectionId);
        const splitError = useAppStore.getState().error;
        if (splitError) throw new Error(splitError);
        await resolveDraft(current, "split");
      }),
      tryAgain: retry
    };
  }, [draft, note, retry, sectionActions]);
}

async function withDatabase<T>(operation: (database: Awaited<ReturnType<typeof openFortnoteIndexedDb>>) => Promise<T>): Promise<T> {
  const database = await openFortnoteIndexedDb();
  try {
    return await operation(database);
  } finally {
    database.close();
  }
}

function encryptedDraftJson(draft: RecoverableSectionDraft, records: EncryptedOutboxRecord[]): string {
  const updates = records.filter((record) =>
    record.noteId === draft.noteId &&
    record.sectionId === draft.sectionId &&
    record.keyEpoch === draft.keyEpoch &&
    draft.updateIds.includes(record.updateId)
  );
  if (updates.length === 0) throw new Error("Retained encrypted draft is unavailable");
  return JSON.stringify({
    format: "fortnote-encrypted-draft-v1",
    noteId: draft.noteId,
    sectionId: draft.sectionId,
    keyEpoch: draft.keyEpoch,
    reason: draft.reason,
    updates: updates.map(({ inlineCipher, nonce, ...record }) => ({
      ...record,
      inlineCipher: toBase64(inlineCipher),
      nonce: toBase64(nonce)
    }))
  }, null, 2);
}

function assertCurrentEditableDraft(
  note: DecryptedNote | null,
  draft: RecoverableSectionDraft
): asserts note is DecryptedNote {
  if (!note || note.isDeleted || note.role === "viewer" || note.keyEpoch !== draft.keyEpoch) {
    throw new Error("Refresh current access before reapplying this draft");
  }
}
