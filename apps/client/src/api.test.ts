import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiRequest,
  ApiRequestError,
  beginContentUpload,
  downloadContentChunk,
  getClientInstanceId,
  inspectContentUpload,
  JSON_CONTROL_MAX_BYTES,
  putContentChunk
} from "./api";

describe("apiRequest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves structured API errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: "conflict",
              message: "Note version conflict",
              requestId: "00000000-0000-4000-8000-000000000001"
            }
          }),
          { status: 409 }
        )
      )
    );

    try {
      await apiRequest("/notes/note_1");
      throw new Error("Expected request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiRequestError);
      expect(error).toMatchObject({
        code: "conflict",
        message: "Note version conflict",
        requestId: "00000000-0000-4000-8000-000000000001",
        status: 409
      });
    }
  });

  it("identifies the originating browser instance", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await apiRequest("/test", { method: "POST", body: "{}" });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(new Headers(init?.headers).get("x-fortnote-client-id")).toBe(
      getClientInstanceId()
    );
    expect(new Headers(init?.headers).get("x-request-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    );
  });

  it("rejects oversized JSON control bodies before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      apiRequest("/control", {
        method: "POST",
        body: JSON.stringify({ value: "x".repeat(JSON_CONTROL_MAX_BYTES) })
      })
    ).rejects.toMatchObject({ code: "control_payload_too_large", status: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses binary bodies and responses without JSON/Base64 conversion", async () => {
    const uploadId = crypto.randomUUID();
    const bytes = Uint8Array.from([0, 1, 2, 253, 254, 255]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(bytes, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await putContentChunk(uploadId, 7, bytes, "a".repeat(64));
    expect(await downloadContentChunk(crypto.randomUUID(), 7)).toEqual(bytes);

    const uploadInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const uploadHeaders = new Headers(uploadInit.headers);
    expect(uploadHeaders.get("content-type")).toBe("application/octet-stream");
    expect(uploadHeaders.get("x-fortnote-cipher-hash")).toBe("a".repeat(64));
    expect(uploadInit.body).toBeInstanceOf(Blob);
  });

  it("begins and inspects resumable uploads through bounded control JSON", async () => {
    const uploadId = crypto.randomUUID();
    const updateId = crypto.randomUUID();
    const noteId = crypto.randomUUID();
    const sectionId = crypto.randomUUID();
    const status = {
      uploadId,
      status: "receiving" as const,
      receivedChunkIndexes: [0, 2],
      reservedBytes: 786432,
      expiresAt: "2026-07-19T00:00:00.000Z"
    };
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(status), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      beginContentUpload({
        uploadId,
        updateId,
        noteId,
        sectionId,
        expectedKeyEpoch: 2,
        kind: "checkpoint",
        formatVersion: 2,
        totalCipherBytes: 786432,
        chunkCount: 3,
        manifestHash: "b".repeat(64),
        checkpointSequenceCutoff: 18
      })
    ).resolves.toEqual(status);
    await expect(inspectContentUpload(uploadId)).resolves.toEqual(status);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/content/uploads");
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/content/uploads/${uploadId}`);
  });
});
