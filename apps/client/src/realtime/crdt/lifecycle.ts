import type { DecryptedNote } from "../../store/appStore";
import { notifyCrdtSectionChange } from "./changes";
import { ROOT_SECTION_ID } from "./document";
import { broadcastUpdate } from "./outbound";
import { CrdtProvider } from "./provider";
import { getCrdtTransport, rejectCrdtTransportWaiters } from "./runtime";
import {
  bindingKey,
  bindings,
  bindingsForNote,
  getOrCreateBinding as getOrCreateStoredBinding,
  type Binding
} from "./state";

export function getOrCreateBinding(
  noteId: string,
  sectionId: string,
  keyEpoch?: number
): Binding {
  return getOrCreateStoredBinding(noteId, sectionId, keyEpoch, {
    broadcastUpdate,
    notifyChange: notifyCrdtSectionChange
  });
}

export function attachCrdtNote(
  note: DecryptedNote,
  onChange: Binding["onChange"]
): () => void {
  const attached = noteBindings(note, true);
  for (const binding of attached) {
    binding.onChange = onChange;
    binding.note = note;
    getCrdtTransport()?.subscribe(
      note.id,
      binding.sectionId,
      note.keyEpoch,
      binding.observedServerSequence
    );
  }
  return () => {
    for (const binding of bindingsForNote(note.id)) {
      binding.onChange = () => undefined;
    }
  };
}

export function updateCrdtNote(note: DecryptedNote): void {
  for (const binding of bindingsForNote(note.id)) {
    if (binding.keyEpoch === note.keyEpoch) {
      binding.note = note;
    }
  }
}

export function openCrdtNote(
  note: DecryptedNote,
  onChange: Binding["onChange"]
): () => void {
  const currentBindings = bindingsForNote(note.id);
  if (currentBindings.some((binding) => binding.keyEpoch > note.keyEpoch)) {
    return () => undefined;
  }
  if (currentBindings.length === 0) {
    return attachCrdtNote(note, onChange);
  }
  const attached = noteBindings(note, true);
  for (const binding of attached) {
    binding.onChange = onChange;
    binding.note = note;
    getCrdtTransport()?.subscribe(
      note.id,
      binding.sectionId,
      note.keyEpoch,
      binding.observedServerSequence
    );
  }
  return () => {
    for (const binding of bindingsForNote(note.id)) {
      binding.onChange = () => undefined;
    }
  };
}

export function editCrdtNote(
  noteOrId: DecryptedNote | string,
  patch: Partial<Pick<DecryptedNote, "title">>
): boolean {
  const noteId = typeof noteOrId === "string" ? noteOrId : noteOrId.id;
  const root = bindings.get(bindingKey(noteId, ROOT_SECTION_ID));
  let writableRoot: Binding;
  if (typeof noteOrId === "string") {
    if (!root) {
      return false;
    }
    writableRoot = root;
  } else {
    writableRoot = root ?? getOrCreateBinding(noteId, ROOT_SECTION_ID, noteOrId.keyEpoch);
    writableRoot.note = noteOrId;
    writableRoot.titleAuthorityVersion = Math.max(
      writableRoot.titleAuthorityVersion,
      noteOrId.version
    );
    getCrdtTransport()?.subscribe(
      noteId,
      ROOT_SECTION_ID,
      noteOrId.keyEpoch,
      writableRoot.observedServerSequence
    );
  }
  if (!writableRoot.ready) {
    writableRoot.pendingPatch = { ...writableRoot.pendingPatch, ...patch };
    writableRoot.onChange(patch);
  }
  writableRoot.doc.transact(() => {
    if (patch.title !== undefined) {
      if (typeof noteOrId !== "string") {
        writableRoot.titleAuthorityVersion = Math.max(
          writableRoot.titleAuthorityVersion,
          noteOrId.version + 1
        );
      }
      const text = writableRoot.doc.getText("title");
      if (text.toJSON() === patch.title) {
        return;
      }
      text.delete(0, text.length);
      text.insert(0, patch.title);
    }
  });
  return true;
}

export function preserveCrdtContent(note: DecryptedNote): DecryptedNote {
  const root = bindings.get(bindingKey(note.id, ROOT_SECTION_ID));
  if (!root) {
    return note;
  }
  if (root.note.keyEpoch !== note.keyEpoch) {
    return note;
  }
  if (!root.ready) {
    return { ...note, ...root.pendingPatch };
  }
  if (root.titleAuthorityVersion < note.version) {
    return note;
  }
  const content = {
    title: root.doc.getText("title").toJSON()
  };
  root.note = { ...note, ...content };
  return root.note;
}

export function removeCrdtNote(noteId: string, expectedProvider?: CrdtProvider): void {
  const noteBindings = bindingsForNote(noteId);
  if (noteBindings.length === 0 && !expectedProvider) {
    return;
  }
  if (
    expectedProvider &&
    !noteBindings.some(({ provider }) => provider === expectedProvider)
  ) {
    expectedProvider.awareness.destroy();
    expectedProvider.doc.destroy();
    return;
  }
  for (const binding of noteBindings) {
    binding.provider.awareness.destroy();
    binding.doc.destroy();
    bindings.delete(bindingKey(binding.noteId, binding.sectionId));
  }
}

export function clearCrdtNotes(): void {
  for (const binding of bindings.values()) {
    binding.provider.awareness.destroy();
    binding.doc.destroy();
  }
  bindings.clear();
  rejectCrdtTransportWaiters(new Error("Vault locked"));
}

export function noteBindings(note: DecryptedNote, includeRoot: boolean): Binding[] {
  const sectionId = note.rootSectionId ?? ROOT_SECTION_ID;
  const section = getOrCreateBinding(note.id, sectionId, note.keyEpoch);
  if (!includeRoot || sectionId === ROOT_SECTION_ID) {
    return [section];
  }
  return [getOrCreateBinding(note.id, ROOT_SECTION_ID, note.keyEpoch), section];
}
