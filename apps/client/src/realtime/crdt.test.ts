import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { replaceYText } from "./crdt";

describe("CRDT collaboration", () => {
  it("converges concurrent character edits from two clients", () => {
    const alice = createDocument("Title", "hello");
    const bob = new Y.Doc();
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));

    replaceYText(alice.getText("body"), "A hello");
    replaceYText(bob.getText("body"), "hello B");
    const aliceUpdate = Y.encodeStateAsUpdate(alice, Y.encodeStateVector(bob));
    const bobUpdate = Y.encodeStateAsUpdate(bob, Y.encodeStateVector(alice));
    Y.applyUpdate(alice, bobUpdate);
    Y.applyUpdate(bob, aliceUpdate);

    expect(alice.getText("body").toJSON()).toBe(bob.getText("body").toJSON());
    expect(alice.getText("body").toJSON()).toContain("A ");
    expect(alice.getText("body").toJSON()).toContain(" B");
  });
});

function createDocument(title: string, body: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getText("title").insert(0, title);
  doc.getText("body").insert(0, body);
  return doc;
}
