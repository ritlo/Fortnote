import * as Y from "yjs";
import {
  appendBlockNoteFragmentSnapshot,
  replaceBlockNoteFragment,
  replaceBlockNoteFragmentSnapshot,
  snapshotBlockNoteFragment,
  splitBlockNoteFragmentSnapshot,
  type BlockNoteFragmentSnapshot
} from "../../lib/blockNote";
import type { DecryptedNote } from "../../store/appStore";

export const REMOTE_UPDATE = Symbol("remote-update");
export const SNAPSHOT_SEED = Symbol("snapshot-seed");
export const ROOT_SECTION_ID = "root";

const SNAPSHOT_VERSION_KEY = "snapshotVersion";
const FRAGMENT_KEY = "document-store";
const SECTION_ORDER_KEY = "sections";

export function createCrdtDocument(): { doc: Y.Doc; fragment: Y.XmlFragment } {
  const doc = new Y.Doc();
  return { doc, fragment: doc.getXmlFragment(FRAGMENT_KEY) };
}

export function getSectionOrder(doc: Y.Doc): string[] {
  return [...new Set(
    doc
      .getArray<unknown>(SECTION_ORDER_KEY)
      .toArray()
      .filter((sectionId): sectionId is string => typeof sectionId === "string")
  )];
}

export function replaceSectionOrder(doc: Y.Doc, orderedSectionIds: string[]): void {
  const uniqueIds = [...new Set(orderedSectionIds)];
  doc.transact(() => {
    const sections = doc.getArray<string>(SECTION_ORDER_KEY);
    sections.delete(0, sections.length);
    if (uniqueIds.length > 0) {
      sections.insert(0, uniqueIds);
    }
  });
}

export function snapshotSection(fragment: Y.XmlFragment): BlockNoteFragmentSnapshot {
  return snapshotBlockNoteFragment(fragment);
}

export function replaceSectionContent(
  fragment: Y.XmlFragment,
  snapshot: BlockNoteFragmentSnapshot
): void {
  replaceBlockNoteFragmentSnapshot(fragment, snapshot);
}

export function replaceLegacySectionContent(
  fragment: Y.XmlFragment,
  body: string
): void {
  replaceBlockNoteFragment(fragment, body);
}

export function appendSectionContent(
  fragment: Y.XmlFragment,
  snapshot: BlockNoteFragmentSnapshot
): void {
  appendBlockNoteFragmentSnapshot(fragment, snapshot);
}

export function splitSectionContent(
  snapshot: BlockNoteFragmentSnapshot
): { before: BlockNoteFragmentSnapshot; after: BlockNoteFragmentSnapshot } | null {
  return splitBlockNoteFragmentSnapshot(snapshot);
}

export function seedDocument(
  doc: Y.Doc,
  fragment: Y.XmlFragment,
  sectionId: string,
  note: DecryptedNote
): void {
  doc.transact(() => {
    if (sectionId === ROOT_SECTION_ID) {
      const title = doc.getText("title");
      if (title.length === 0) {
        title.insert(0, note.title);
      }
      const sections = doc.getArray<string>(SECTION_ORDER_KEY);
      if (sections.length === 0 && note.rootSectionId) {
        sections.insert(0, [note.rootSectionId]);
      }
    } else if (fragment.length === 0) {
      replaceBlockNoteFragment(fragment, undefined);
    }
    setSnapshotVersion(doc, note.version);
  }, SNAPSHOT_SEED);
}

export function getSnapshotVersion(doc: Y.Doc): number {
  return doc.getMap<number>("metadata").get(SNAPSHOT_VERSION_KEY) ?? 0;
}

export function setSnapshotVersion(doc: Y.Doc, version: number): void {
  doc.getMap<number>("metadata").set(SNAPSHOT_VERSION_KEY, version);
}

export function replaceWithSnapshot(
  doc: Y.Doc,
  fragment: Y.XmlFragment,
  sectionId: string,
  note: DecryptedNote
): void {
  doc.transact(() => {
    if (sectionId === ROOT_SECTION_ID) {
      const text = doc.getText("title");
      text.delete(0, text.length);
      text.insert(0, note.title);
    }
    if (sectionId !== ROOT_SECTION_ID && fragment.length === 0) {
      replaceBlockNoteFragment(fragment, undefined);
    }
    setSnapshotVersion(doc, note.version);
  }, SNAPSHOT_SEED);
}
