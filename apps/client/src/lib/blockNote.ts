import {
  BlockNoteEditor,
  blockToNode,
  type PartialBlock
} from "@blocknote/core";
import {
  prosemirrorJSONToYXmlFragment,
  prosemirrorToYXmlFragment,
  yXmlFragmentToProseMirrorRootNode
} from "y-prosemirror";
import type * as Y from "yjs";

const converter = BlockNoteEditor.create();
const emptyDocument: PartialBlock[] = [{ type: "paragraph" }];

interface BlockNoteGroupSnapshot extends Record<string, unknown> {
  type: "blockGroup";
  content: unknown[];
}

export type BlockNoteFragmentSnapshot = Record<string, unknown> & {
  type: "doc";
  content: [BlockNoteGroupSnapshot];
};

export function parseBlockNoteBody(body: string | undefined): PartialBlock[] | null {
  if (!body) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(body);
    if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(isStoredBlock)) {
      return null;
    }
    toProseMirrorDocument(parsed as PartialBlock[]);
    return parsed as PartialBlock[];
  } catch {
    return null;
  }
}

export function blockNoteInitialContent(body: string | undefined): PartialBlock[] {
  const stored = parseBlockNoteBody(body);
  if (stored) {
    return stored;
  }
  return body ? [{ type: "paragraph", content: body }] : emptyDocument;
}

export function replaceBlockNoteFragment(fragment: Y.XmlFragment, body: string | undefined): void {
  if (fragment.length > 0) {
    fragment.delete(0, fragment.length);
  }
  prosemirrorToYXmlFragment(
    toProseMirrorDocument(blockNoteInitialContent(body)),
    fragment
  );
}

export function snapshotBlockNoteFragment(
  fragment: Y.XmlFragment
): BlockNoteFragmentSnapshot {
  const snapshot: unknown = yXmlFragmentToProseMirrorRootNode(
    fragment,
    converter.pmSchema
  ).toJSON();
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    !("type" in snapshot) ||
    snapshot.type !== "doc" ||
    !("content" in snapshot) ||
    !Array.isArray(snapshot.content) ||
    snapshot.content.length !== 1 ||
    !isBlockGroupSnapshot(snapshot.content[0])
  ) {
    throw new Error("Encrypted section document is invalid");
  }
  return snapshot as BlockNoteFragmentSnapshot;
}

export function replaceBlockNoteFragmentSnapshot(
  fragment: Y.XmlFragment,
  snapshot: BlockNoteFragmentSnapshot
): void {
  prosemirrorJSONToYXmlFragment(converter.pmSchema, snapshot, fragment);
}

export function appendBlockNoteFragmentSnapshot(
  fragment: Y.XmlFragment,
  appended: BlockNoteFragmentSnapshot
): void {
  const current = snapshotBlockNoteFragment(fragment);
  replaceBlockNoteFragmentSnapshot(fragment, {
    ...current,
    content: [{
      ...current.content[0],
      content: [
        ...current.content[0].content,
        ...appended.content[0].content
      ]
    }]
  });
}

export function splitBlockNoteFragmentSnapshot(
  snapshot: BlockNoteFragmentSnapshot
): { before: BlockNoteFragmentSnapshot; after: BlockNoteFragmentSnapshot } | null {
  const blocks = snapshot.content[0].content;
  if (blocks.length < 2) {
    return null;
  }
  const splitAt = Math.ceil(blocks.length / 2);
  const group = snapshot.content[0];
  return {
    before: {
      ...snapshot,
      content: [{ ...group, content: blocks.slice(0, splitAt) }]
    },
    after: {
      ...snapshot,
      content: [{ ...group, content: blocks.slice(splitAt) }]
    }
  };
}

function isBlockGroupSnapshot(value: unknown): value is BlockNoteGroupSnapshot {
  return Boolean(
    value &&
    typeof value === "object" &&
    "type" in value &&
    value.type === "blockGroup" &&
    "content" in value &&
    Array.isArray(value.content)
  );
}

function toProseMirrorDocument(blocks: PartialBlock[]) {
  const nodes = blocks.map((block) => blockToNode(block, converter.pmSchema));
  return converter.pmSchema.topNodeType.create(
    null,
    converter.pmSchema.nodes.blockGroup!.create(null, nodes)
  );
}

function isStoredBlock(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const block = value as Record<string, unknown>;
  return (
    typeof block.id === "string" &&
    typeof block.type === "string" &&
    !!block.props &&
    typeof block.props === "object" &&
    Array.isArray(block.children) &&
    block.children.every(isStoredBlock)
  );
}
