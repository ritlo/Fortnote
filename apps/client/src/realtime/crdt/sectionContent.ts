import type { BlockNoteFragmentSnapshot } from "../../lib/blockNote";
import {
  appendSectionContent,
  getSectionOrder,
  replaceSectionContent,
  replaceSectionOrder,
  ROOT_SECTION_ID,
  snapshotSection,
  splitSectionContent
} from "./document";
import {
  bindingKey,
  bindings,
  canWrite,
  isActiveBinding,
  writableReadyBinding
} from "./state";

export function snapshotReadyCrdtSection(
  noteId: string,
  keyEpoch: number,
  sectionId: string
): BlockNoteFragmentSnapshot | null {
  const binding = bindings.get(bindingKey(noteId, sectionId));
  if (
    binding?.keyEpoch !== keyEpoch ||
    !binding.ready ||
    !isActiveBinding(binding)
  ) {
    return null;
  }
  return snapshotSection(binding.fragment);
}

export function getCrdtSectionOrder(noteId: string): string[] {
  const root = bindings.get(bindingKey(noteId, ROOT_SECTION_ID));
  if (!root?.ready) {
    return [];
  }
  return getSectionOrder(root.doc);
}

export function replaceCrdtSectionOrder(
  noteId: string,
  orderedSectionIds: string[]
): boolean {
  const root = bindings.get(bindingKey(noteId, ROOT_SECTION_ID));
  if (!root?.ready || !canWrite(root)) {
    return false;
  }
  replaceSectionOrder(root.doc, orderedSectionIds);
  return true;
}

export function snapshotCrdtSection(
  noteId: string,
  sectionId: string
): BlockNoteFragmentSnapshot {
  const binding = writableReadyBinding(noteId, sectionId);
  return snapshotSection(binding.fragment);
}

export function replaceCrdtSectionContent(
  noteId: string,
  sectionId: string,
  snapshot: BlockNoteFragmentSnapshot
): void {
  const binding = writableReadyBinding(noteId, sectionId);
  replaceSectionContent(binding.fragment, snapshot);
}

export function appendCrdtSectionContent(
  noteId: string,
  sectionId: string,
  snapshot: BlockNoteFragmentSnapshot
): void {
  const binding = writableReadyBinding(noteId, sectionId);
  appendSectionContent(binding.fragment, snapshot);
}

export function splitCrdtSectionContent(
  noteId: string,
  sectionId: string
): { before: BlockNoteFragmentSnapshot; after: BlockNoteFragmentSnapshot } | null {
  return splitSectionContent(snapshotCrdtSection(noteId, sectionId));
}
