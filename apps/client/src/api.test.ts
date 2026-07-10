import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest, ApiRequestError, getClientInstanceId } from "./api";

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
            code: "conflict",
            message: "Note version conflict"
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
  });
});
