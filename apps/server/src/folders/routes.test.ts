import { describe, expect, it } from "vitest";
import type { AppDb } from "../db/client.js";
import {
  createTestApp,
  csrfHeaders,
  notePayload,
  registerAgent
} from "../test/http.js";

describe("folders routes", () => {
  it("writes owner-scoped folder events", async () => {
    const app = createTestApp();
    const alice = await registerAgent(app, "folder_events_alice");
    const bob = await registerAgent(app, "folder_events_bob");

    const created = await alice
      .post("/api/folders")
      .set(csrfHeaders())
      .send({ name: "Projects" })
      .expect(201);
    const folderId = String(created.body.id);

    await alice
      .put(`/api/folders/${folderId}`)
      .set(csrfHeaders())
      .send({ name: "Archive" })
      .expect(200);
    await alice.delete(`/api/folders/${folderId}`).set(csrfHeaders()).expect(204);

    const aliceEvents = await alice.get("/api/events").query({ after: 0 }).expect(200);
    expect(aliceEvents.body.events.map((event: { type: string }) => event.type)).toEqual([
      "folder.created",
      "folder.updated",
      "folder.deleted"
    ]);
    expect(aliceEvents.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          noteId: null,
          resourceId: folderId,
          resourceType: "folder"
        })
      ])
    );

    const bobEvents = await bob.get("/api/events").query({ after: 0 }).expect(200);
    expect(bobEvents.body.events).toEqual([]);
  });

  it("rolls back folder deletes when event writes fail", async () => {
    const app = createTestApp();
    const agent = await registerAgent(app, "folder_rollback_user");
    const db = app.locals.db as AppDb;

    const folder = await agent
      .post("/api/folders")
      .set(csrfHeaders())
      .send({ name: "Inbox" })
      .expect(201);
    const folderId = String(folder.body.id);
    const note = await agent
      .post("/api/notes")
      .set(csrfHeaders())
      .send(notePayload(folderId))
      .expect(201);
    const noteId = String(note.body.id);

    failNoteEventWrites(app);

    await agent.delete(`/api/folders/${folderId}`).set(csrfHeaders()).expect(500);

    const storedFolder = db.sqlite
      .prepare("SELECT id FROM folders WHERE id = ?")
      .get(folderId);
    expect(storedFolder).toEqual({ id: folderId });
    const storedNote = db.sqlite
      .prepare("SELECT folder_id AS folderId FROM notes WHERE id = ?")
      .get(noteId);
    expect(storedNote).toEqual({ folderId });
  });
});

function failNoteEventWrites(app: ReturnType<typeof createTestApp>): void {
  app.locals.db.sqlite.exec(`
    CREATE TRIGGER fail_note_events_insert
    BEFORE INSERT ON note_events
    BEGIN
      SELECT RAISE(ABORT, 'note event failure');
    END;
  `);
}
