import * as Y from "yjs";
import type { DecryptedNote } from "../../store/appStore";
import {
  createCrdtDocument,
  REMOTE_UPDATE,
  ROOT_SECTION_ID,
  seedDocument,
  SNAPSHOT_SEED
} from "./document";
import { CrdtProvider } from "./provider";
import type { DurableDelivery } from "./transport";

export interface Binding {
  doc: Y.Doc;
  fragment: Y.XmlFragment;
  noteId: string;
  sectionId: string;
  provider: CrdtProvider;
  note: DecryptedNote;
  onChange: (patch: Partial<Pick<DecryptedNote, "title">>) => void;
  pendingUpdateIds: Set<string>;
  /** Received updates that must be fetched again before the section is complete. */
  failedUpdateIds: Map<string, CrdtUpdateFailure>;
  receivedServerSequences: Map<string, number>;
  generation: number;
  appliedUpdateCount: number;
  checkpointing: boolean;
  observedServerSequence: number;
  pendingPatch: Partial<Pick<DecryptedNote, "title">>;
  titleAuthorityVersion: number;
  pendingBroadcasts: Set<Promise<void>>;
  openGeneration: number;
  ready: boolean;
  receiving: Promise<void>;
  snapshotSeeded: boolean;
  inheritedEpochState: boolean;
  keyEpoch: number;
}

/**
 * Why a received update could not become part of the local history. Only
 * "unreadable" means the ciphertext or its plaintext could not be opened.
 */
export type CrdtUpdateFailure = "unreadable" | "unavailable";

export class CrdtUpdateError extends Error {
  constructor(
    readonly failure: CrdtUpdateFailure | "display",
    cause: unknown
  ) {
    super(
      cause instanceof Error ? cause.message : "Realtime update could not be applied",
      {
        cause
      }
    );
    this.name = "CrdtUpdateError";
  }
}

export function isCrdtUpdateFailure(
  error: unknown,
  failure: CrdtUpdateError["failure"]
): boolean {
  return error instanceof CrdtUpdateError && error.failure === failure;
}

export interface BindingHooks {
  broadcastUpdate: (binding: Binding, update: Uint8Array) => DurableDelivery<void>;
  notifyChange: (binding: Binding) => void;
}

export const bindings = new Map<string, Binding>();
let nextBindingGeneration = 1;

export function getOrCreateBinding(
  noteId: string,
  sectionId: string,
  keyEpoch: number | undefined,
  hooks: BindingHooks
): Binding {
  const key = bindingKey(noteId, sectionId);
  const existing = bindings.get(key);
  if (
    existing &&
    (keyEpoch === undefined ||
      existing.keyEpoch === keyEpoch ||
      keyEpoch < existing.keyEpoch)
  ) {
    return existing;
  }
  const inheritedState = existing ? Y.encodeStateAsUpdate(existing.doc) : null;
  const epochAdvanced = Boolean(
    existing && keyEpoch !== undefined && keyEpoch > existing.keyEpoch
  );
  const { doc, fragment } = createCrdtDocument();
  const provider = new CrdtProvider(doc);
  const created: Binding = {
    doc,
    fragment,
    noteId,
    sectionId,
    provider,
    note: undefined as unknown as DecryptedNote,
    onChange: () => undefined,
    pendingUpdateIds: new Set(epochAdvanced ? [] : (existing?.pendingUpdateIds ?? [])),
    failedUpdateIds: new Map(existing?.failedUpdateIds ?? []),
    receivedServerSequences: new Map(
      epochAdvanced ? [] : (existing?.receivedServerSequences ?? [])
    ),
    generation: nextBindingGeneration,
    appliedUpdateCount: epochAdvanced ? 0 : (existing?.appliedUpdateCount ?? 0),
    checkpointing: false,
    observedServerSequence: epochAdvanced ? 0 : (existing?.observedServerSequence ?? 0),
    pendingPatch: {},
    titleAuthorityVersion: existing?.titleAuthorityVersion ?? 0,
    pendingBroadcasts: new Set(),
    openGeneration: 0,
    ready: epochAdvanced ? false : (existing?.ready ?? false),
    receiving: Promise.resolve(),
    snapshotSeeded: inheritedState !== null,
    inheritedEpochState: epochAdvanced && inheritedState !== null,
    keyEpoch: keyEpoch ?? 0
  };
  nextBindingGeneration += 1;
  if (inheritedState) {
    Y.applyUpdate(doc, inheritedState, SNAPSHOT_SEED);
  }
  if (epochAdvanced && existing) {
    existing.onChange = () => undefined;
    existing.provider.awareness.destroy();
    existing.doc.destroy();
  }
  bindings.set(key, created);
  if (sectionId === ROOT_SECTION_ID) {
    doc.getText("title").observe((event) => {
      if (event.transaction.origin !== SNAPSHOT_SEED && isActiveBinding(created)) {
        created.onChange({ title: doc.getText("title").toJSON() });
      }
    });
  }
  doc.on("update", (update, origin) => {
    const note = created.note as DecryptedNote | undefined;
    if (
      origin !== REMOTE_UPDATE &&
      origin !== SNAPSHOT_SEED &&
      isActiveBinding(created) &&
      note &&
      note.role !== "viewer"
    ) {
      const delivery = hooks.broadcastUpdate(created, update);
      trackPendingBroadcast(created, delivery.durable);
      created.provider.emit("save-state", "saving");
      void delivery.delivered.then(
        () => {
          if (isActiveBinding(created) && created.pendingBroadcasts.size === 0) {
            created.provider.emit("save-state", "saved");
          }
        },
        () => {
          if (isActiveBinding(created)) {
            created.provider.emit("save-state", "failed");
          }
        }
      );
      void delivery.delivered.catch(() => undefined);
    }
    hooks.notifyChange(created);
  });
  return created;
}

export function seedBinding(binding: Binding, note: DecryptedNote): void {
  seedDocument(binding.doc, binding.fragment, binding.sectionId, note);
}

export function throwIfCrdtHistoryUnreadable(binding: Binding): void {
  if ([...binding.failedUpdateIds.values()].includes("unreadable")) {
    throw new Error("Realtime history could not be decrypted");
  }
  if (binding.failedUpdateIds.size > 0) {
    throw new Error("Realtime history could not be downloaded");
  }
}

export function isCrdtHistoryUnreadableError(error: unknown): boolean {
  return (
    error instanceof Error && error.message === "Realtime history could not be decrypted"
  );
}

export function trackPendingBroadcast(binding: Binding, pending: Promise<void>): void {
  binding.pendingBroadcasts.add(pending);
  const finish = () => {
    binding.pendingBroadcasts.delete(pending);
  };
  void pending.then(finish, finish);
}

export function canWrite(binding: Binding): boolean {
  return binding.note.role !== "viewer";
}

export function bindingsForNote(noteId: string): Binding[] {
  return [...bindings.values()].filter((binding) => binding.noteId === noteId);
}

export function defaultSectionId(noteId: string): string {
  for (const binding of bindingsForNote(noteId)) {
    const note = binding.note as DecryptedNote | undefined;
    if (note?.rootSectionId) {
      return note.rootSectionId;
    }
  }
  return ROOT_SECTION_ID;
}

export function bindingKey(noteId: string, sectionId: string): string {
  return JSON.stringify([noteId, sectionId]);
}

export function isBinding(binding: Binding | undefined): binding is Binding {
  return binding !== undefined;
}

export function isActiveBinding(binding: Binding): boolean {
  const active = bindings.get(bindingKey(binding.noteId, binding.sectionId));
  return active === binding && active.generation === binding.generation;
}

export function isActiveBindingForNote(binding: Binding, note: DecryptedNote): boolean {
  return (
    isActiveBinding(binding) &&
    binding.note.id === note.id &&
    binding.keyEpoch === note.keyEpoch &&
    binding.note.cryptoOwnerId === note.cryptoOwnerId
  );
}

export function writableReadyBinding(noteId: string, sectionId: string): Binding {
  const binding = bindings.get(bindingKey(noteId, sectionId));
  if (!binding?.ready || !canWrite(binding) || !isActiveBinding(binding)) {
    throw new Error("Encrypted section is not ready for this operation");
  }
  return binding;
}
