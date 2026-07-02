import { describe, expect, it } from "vitest";
import { parseRealtimeMessage } from "./client";

describe("realtime client", () => {
  it("ignores malformed websocket messages", () => {
    expect(parseRealtimeMessage("{not json")).toBeNull();
    expect(parseRealtimeMessage(JSON.stringify({ type: "unknown" }))).toBeNull();
    expect(parseRealtimeMessage(JSON.stringify({ type: "replay" }))).toBeNull();
    expect(
      parseRealtimeMessage(
        JSON.stringify({
          type: "presence",
          noteId: "note_1",
          users: [{ userId: "user_1", username: "alice", state: "unknown", updatedAt: "now" }]
        })
      )
    ).toBeNull();
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

  it("parses replay events with expected shape", () => {
    const event = {
      actorUserId: "user_1",
      createdAt: "2026-07-02T10:00:00.000Z",
      cursor: 1,
      eventId: "event_1",
      metadata: { attachmentId: "attachment_1" },
      noteId: "note_1",
      resourceId: "attachment_1",
      resourceType: "attachment",
      type: "attachment.created",
      version: 2
    };

    expect(parseRealtimeMessage(JSON.stringify({ type: "replay", events: [event] }))).toEqual({
      type: "replay",
      events: [event]
    });
  });
});
