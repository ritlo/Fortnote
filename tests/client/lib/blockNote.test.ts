import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  appendBlockNoteFragmentSnapshot,
  replaceBlockNoteFragment,
  replaceBlockNoteFragmentSnapshot,
  snapshotBlockNoteFragment,
  splitBlockNoteFragmentSnapshot
} from "@client/lib/blockNote";

describe("BlockNote section snapshots", () => {
  it("splits, replaces, and appends top-level blocks without plaintext serialization", () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("document-store");
    replaceBlockNoteFragment(fragment, JSON.stringify([
      block("one", "First"),
      block("two", "Second")
    ]));

    const split = splitBlockNoteFragmentSnapshot(snapshotBlockNoteFragment(fragment));

    expect(split?.before.content[0].content).toHaveLength(1);
    expect(split?.after.content[0].content).toHaveLength(1);
    replaceBlockNoteFragmentSnapshot(fragment, split!.before);
    expect(snapshotBlockNoteFragment(fragment).content[0].content).toHaveLength(1);
    appendBlockNoteFragmentSnapshot(fragment, split!.after);
    expect(snapshotBlockNoteFragment(fragment).content[0].content).toHaveLength(2);
  });
});

function block(id: string, text: string) {
  return {
    id,
    type: "paragraph",
    props: {
      backgroundColor: "default",
      textColor: "default",
      textAlignment: "left"
    },
    content: [{ type: "text", text, styles: {} }],
    children: []
  };
}
