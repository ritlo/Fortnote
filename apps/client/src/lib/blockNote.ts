import {
  BlockNoteEditor,
  blockToNode,
  type PartialBlock
} from "@blocknote/core";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import type * as Y from "yjs";

const converter = BlockNoteEditor.create();
const emptyDocument: PartialBlock[] = [{ type: "paragraph" }];

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
  return parseBlockNoteBody(body) ?? emptyDocument;
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
