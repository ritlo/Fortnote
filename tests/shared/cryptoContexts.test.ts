import { describe, expect, it } from "vitest";
import {
  associatedDataV2,
  contentChunkAssociatedData,
  crdtBinaryAssociatedData,
  epochLinkAssociatedData
} from "@shared/crypto.js";

// Stored ciphertext is bound to these exact bytes. A change here makes every
// existing v2 envelope undecryptable, so update the expectations only as part
// of a deliberate format migration.
const OWNER = "00000000-0000-4000-8000-0000000000a1";
const NOTE = "00000000-0000-4000-8000-0000000000b1";
const SECTION = "00000000-0000-4000-8000-0000000000c1";
const UPDATE = "00000000-0000-4000-8000-0000000000d1";
const UPLOAD = "00000000-0000-4000-8000-0000000000e1";

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("v2 associated data", () => {
  it("serializes purpose and sorted typed context", () => {
    expect(decode(associatedDataV2("example", { b: 2, a: "one", c: true }))).toBe(
      '["fortnote","example",2,[["a","string","one"],["b","number",2],["c","boolean",true]]]'
    );
  });

  it("binds content chunks", () => {
    expect(
      decode(
        contentChunkAssociatedData({
          cryptoOwnerId: OWNER,
          noteId: NOTE,
          sectionId: SECTION,
          keyEpoch: 3,
          updateId: UPDATE,
          uploadId: UPLOAD,
          chunkIndex: 1,
          chunkCount: 2,
          totalCipherBytes: 64,
          kind: "checkpoint",
          checkpointSequenceCutoff: 9,
          formatVersion: 2
        })
      )
    ).toBe(
      '["fortnote","content-chunk",2,[["checkpointSequenceCutoff","number",9],["chunkCount","number",2],["chunkIndex","number",1],["cryptoOwnerId","string","00000000-0000-4000-8000-0000000000a1"],["formatVersion","number",2],["keyEpoch","number",3],["kind","string","checkpoint"],["noteId","string","00000000-0000-4000-8000-0000000000b1"],["sectionId","string","00000000-0000-4000-8000-0000000000c1"],["totalCipherBytes","number",64],["updateId","string","00000000-0000-4000-8000-0000000000d1"],["uploadId","string","00000000-0000-4000-8000-0000000000e1"]]]'
    );
  });

  it("binds binary CRDT frames", () => {
    expect(
      decode(
        crdtBinaryAssociatedData({
          cryptoOwnerId: OWNER,
          noteId: NOTE,
          sectionId: SECTION,
          keyEpoch: 3,
          updateId: UPDATE,
          kind: "update",
          formatVersion: 2
        })
      )
    ).toBe(
      '["fortnote","crdt-binary",2,[["checkpointSequenceCutoff","number",0],["cryptoOwnerId","string","00000000-0000-4000-8000-0000000000a1"],["formatVersion","number",2],["keyEpoch","number",3],["kind","string","update"],["noteId","string","00000000-0000-4000-8000-0000000000b1"],["sectionId","string","00000000-0000-4000-8000-0000000000c1"],["updateId","string","00000000-0000-4000-8000-0000000000d1"]]]'
    );
  });

  it("binds epoch links", () => {
    expect(
      decode(
        epochLinkAssociatedData({
          cryptoOwnerId: OWNER,
          noteId: NOTE,
          sourceEpoch: 3,
          targetEpoch: 4,
          formatVersion: 2
        })
      )
    ).toBe(
      '["fortnote","note-epoch-link",2,[["cryptoOwnerId","string","00000000-0000-4000-8000-0000000000a1"],["formatVersion","number",2],["noteId","string","00000000-0000-4000-8000-0000000000b1"],["sourceEpoch","number",3],["targetEpoch","number",4]]]'
    );
  });
});
