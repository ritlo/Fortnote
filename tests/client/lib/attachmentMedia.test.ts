import { describe, expect, it } from "vitest";
import {
  formatAttachmentReference,
  isAttachmentMimeCompatible,
  parseAttachmentReference
} from "@client/lib/attachmentMedia";

const ATTACHMENT_ID = "00000000-0000-4000-8000-000000000001";

describe("Fortnote attachment references", () => {
  it("formats and parses UUID references", () => {
    const reference = formatAttachmentReference(ATTACHMENT_ID);
    expect(reference).toBe(`fortnote-attachment:${ATTACHMENT_ID}`);
    expect(parseAttachmentReference(reference)).toBe(ATTACHMENT_ID);
  });

  it("rejects malformed Fortnote references and ids", () => {
    expect(() => formatAttachmentReference("not-a-uuid")).toThrow("Invalid attachment id");
    expect(() => parseAttachmentReference("fortnote-attachment:not-a-uuid")).toThrow(
      "Invalid Fortnote attachment reference"
    );
  });

  it("passes ordinary embed URLs through as non-attachment references", () => {
    expect(parseAttachmentReference("https://example.com/image.png")).toBeNull();
    expect(parseAttachmentReference("blob:https://example.com/session-id")).toBeNull();
  });
});

describe("attachment MIME compatibility", () => {
  it.each([
    ["image/png", ["image/*"], true],
    ["audio/mpeg", ["audio/*"], true],
    ["video/mp4", ["video/*"], true],
    ["application/pdf", ["*/*"], true],
    ["application/pdf", [], true],
    ["audio/mpeg", ["image/*"], false],
    ["image/svg+xml", ["image/png"], false]
  ] as const)("matches %s against %j", (mimeType, accepted, compatible) => {
    expect(isAttachmentMimeCompatible(mimeType, accepted)).toBe(compatible);
  });
});
