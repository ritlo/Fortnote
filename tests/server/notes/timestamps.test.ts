import { describe, expect, it, vi } from "vitest";
import { createTestApp, csrfHeaders, registerAgent } from "../support/http.js";
import { protectedNotePayload } from "./routes.fixtures.js";

describe("note save timestamps", () => {
  it.each([
    ["2026-09-14 17:01:53", "2026-09-14T17:01:53.000Z"],
    ["2026-09-14 17:01:53.344647+00", "2026-09-14T17:01:53.344Z"],
    ["2026-09-14 19:01:53.344647+02", "2026-09-14T17:01:53.344Z"],
    ["2026-09-14 11:31:53.344647-05:30", "2026-09-14T17:01:53.344Z"],
    ["2026-09-14T17:01:53.344Z", "2026-09-14T17:01:53.344Z"]
  ])("serializes %s as canonical UTC", async (stored, expected) => {
    const app = await createTestApp();
    const agent = await registerAgent(app, "timestamp_user");
    const note = protectedNotePayload();
    await agent.post("/api/notes").set(csrfHeaders()).send(note).expect(201);
    const spy = vi
      .spyOn(app.locals.db.noteMutations, "updateProtected")
      .mockResolvedValue({
        kind: "saved",
        rootVersion: 2,
        keyEpoch: 1,
        eventCursor: 1,
        updatedAt: stored
      });
    try {
      const response = await agent
        .put(`/api/notes/${note.id}`)
        .set(csrfHeaders())
        .send({ rootVersion: 1, keyEpoch: 1 })
        .expect(200);
      expect(response.body.updatedAt).toBe(expected);
    } finally {
      spy.mockRestore();
      await app.locals.db.close();
    }
  });
});
