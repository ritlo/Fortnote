import { describe, expect, it } from "vitest";
import { randomBytes, toBase64 } from "./crypto.js";
import {
  CRDT_BINARY_FORMAT_VERSION,
  type CrdtBinaryHeader,
  decodeCrdtBinaryFrame,
  encodeCrdtBinaryFrame,
  parseCrdtControlMessage
} from "./crdt.js";

describe("bounded CRDT v2 protocol", () => {
  it("round-trips a binary section update without Base64 content", () => {
    const cipher = randomBytes(128);
    const header = binaryHeader(cipher.length);
    const frame = encodeCrdtBinaryFrame(header, cipher, 1024);
    const decoded = decodeCrdtBinaryFrame(frame, 1024);

    expect(decoded.header).toEqual(header);
    expect(decoded.cipher).toEqual(cipher);
    expect(frame.length).toBeLessThan(1024);
    expect(new TextDecoder().decode(frame)).not.toContain(toBase64(cipher));

    const rootHeader = { ...header, sectionId: "root", kind: "root-update" as const };
    expect(decodeCrdtBinaryFrame(
      encodeCrdtBinaryFrame(rootHeader, cipher, 1024),
      1024
    ).header).toEqual(rootHeader);
  });

  it("rejects mismatched lengths, malformed headers, and oversized frames", () => {
    const cipher = randomBytes(32);
    expect(() =>
      encodeCrdtBinaryFrame({ ...binaryHeader(cipher.length), cipherLength: 31 }, cipher, 1024)
    ).toThrow("cipher length");
    expect(() => encodeCrdtBinaryFrame(binaryHeader(cipher.length), cipher, 16)).toThrow(
      "frame limit"
    );

    const frame = encodeCrdtBinaryFrame(binaryHeader(cipher.length), cipher, 1024);
    frame[3] = 0;
    expect(() => decodeCrdtBinaryFrame(frame, 1024)).toThrow("header");
  });

  it("parses a bounded root or section subscription", () => {
    expect(
      parseCrdtControlMessage({
        type: "crdt-subscribe",
        requestId: crypto.randomUUID(),
        noteId: crypto.randomUUID(),
        sectionId: "root",
        expectedKeyEpoch: 3,
        afterSequence: 812
      })
    ).toMatchObject({ type: "crdt-subscribe", sectionId: "root", afterSequence: 812 });
    expect(() =>
      parseCrdtControlMessage({
        type: "crdt-subscribe",
        requestId: crypto.randomUUID(),
        noteId: crypto.randomUUID(),
        sectionId: crypto.randomUUID(),
        expectedKeyEpoch: 0,
        afterSequence: -1
      })
    ).toThrow("control message");
  });

  it("parses durable acknowledgements and exhaustive typed rejects", () => {
    expect(
      parseCrdtControlMessage({
        type: "crdt-ack",
        updateId: crypto.randomUUID(),
        sectionId: "root",
        result: "already-present",
        keyEpoch: 2,
        serverSequence: 91
      })
    ).toMatchObject({ type: "crdt-ack", result: "already-present", serverSequence: 91 });

    for (const code of [
      "storage-limit",
      "frame-too-large",
      "stale-epoch",
      "rotation-pending",
      "forbidden"
    ]) {
      expect(
        parseCrdtControlMessage({
          type: "crdt-reject",
          updateId: crypto.randomUUID(),
          sectionId: crypto.randomUUID(),
          code
        })
      ).toMatchObject({ type: "crdt-reject", code });
    }
  });

  it("parses paged history and committed manifest references", () => {
    const noteId = crypto.randomUUID();
    const sectionId = crypto.randomUUID();
    expect(
      parseCrdtControlMessage({
        type: "crdt-history-page",
        noteId,
        sectionId,
        keyEpoch: 4,
        afterSequence: 10,
        nextSequence: 20,
        hasMore: true,
        entries: [
          { kind: "inline", updateId: crypto.randomUUID(), serverSequence: 11 },
          {
            kind: "manifest",
            updateId: crypto.randomUUID(),
            manifestId: crypto.randomUUID(),
            serverSequence: 12
          }
        ]
      })
    ).toMatchObject({ type: "crdt-history-page", hasMore: true, nextSequence: 20 });

    expect(
      parseCrdtControlMessage({
        type: "crdt-manifest",
        noteId,
        sectionId,
        keyEpoch: 4,
        updateId: crypto.randomUUID(),
        manifestId: crypto.randomUUID(),
        serverSequence: 21
      })
    ).toMatchObject({ type: "crdt-manifest", serverSequence: 21 });
  });
});

function binaryHeader(cipherLength: number): CrdtBinaryHeader {
  return {
    type: "crdt-binary" as const,
    kind: "update" as const,
    formatVersion: CRDT_BINARY_FORMAT_VERSION,
    updateId: crypto.randomUUID(),
    noteId: crypto.randomUUID(),
    sectionId: crypto.randomUUID(),
    cryptoOwnerId: crypto.randomUUID(),
    expectedKeyEpoch: 2,
    nonce: toBase64(randomBytes(24)),
    cipherLength
  };
}
