import { describe, expect, it } from "vitest";
import { parseRealtimeMessage } from "./client";

describe("realtime client", () => {
  it("ignores malformed websocket messages", () => {
    expect(parseRealtimeMessage("{not json")).toBeNull();
    expect(parseRealtimeMessage(JSON.stringify({ type: "unknown" }))).toBeNull();
    expect(parseRealtimeMessage(null)).toBeNull();
  });

  it("parses known websocket messages", () => {
    expect(
      parseRealtimeMessage(
        JSON.stringify({
          type: "connected",
          userId: "user_1",
          username: "alice"
        })
      )
    ).toEqual({
      type: "connected",
      userId: "user_1",
      username: "alice"
    });
  });
});
