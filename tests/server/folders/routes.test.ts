import { describe, expect, it } from "vitest";
import type { ApplicationDatabase } from "@server/db/types.js";
import {
  createTestApp,
  csrfHeaders,
  notePayload,
  registerAgent
} from "../support/http.js";
import { failNoteEventWrites, testSql } from "../support/database.js";

describe("folders routes", () => {
  it("writes owner-scoped folder events", async () => {
    const app = await createTestApp();
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

  it("rolls back folder creates when event writes fail", async () => {
    const app = await createTestApp();
    const agent = await registerAgent(app, "folder_create_rollback_user");
    const db = app.locals.db as ApplicationDatabase;
    const folderId = crypto.randomUUID();

    await failNoteEventWrites(app.locals.db);

    await agent
      .post("/api/folders")
      .set(csrfHeaders())
      .send({ id: folderId, name: "Drafts" })
      .expect(500);

    const storedFolder = await testSql(db).get(
      "SELECT id FROM folders WHERE id = ?",
      folderId
    );
    expect(storedFolder).toBeUndefined();
  });

  it("rolls back folder updates when event writes fail", async () => {
    const app = await createTestApp();
    const agent = await registerAgent(app, "folder_update_rollback_user");
    const db = app.locals.db as ApplicationDatabase;
    const folder = await agent
      .post("/api/folders")
      .set(csrfHeaders())
      .send({ name: "Inbox" })
      .expect(201);
    const folderId = String(folder.body.id);

    await failNoteEventWrites(app.locals.db);

    await agent
      .put(`/api/folders/${folderId}`)
      .set(csrfHeaders())
      .send({ name: "Renamed" })
      .expect(500);

    const storedFolder = await testSql(db).get(
      "SELECT name FROM folders WHERE id = ?",
      folderId
    );
    expect(storedFolder).toEqual({ name: "Inbox" });
  });

  it("rolls back folder deletes when event writes fail", async () => {
    const app = await createTestApp();
    const agent = await registerAgent(app, "folder_rollback_user");
    const db = app.locals.db as ApplicationDatabase;

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

    await failNoteEventWrites(app.locals.db);

    await agent.delete(`/api/folders/${folderId}`).set(csrfHeaders()).expect(500);

    const storedFolder = await testSql(db).get(
      "SELECT id FROM folders WHERE id = ?",
      folderId
    );
    expect(storedFolder).toEqual({ id: folderId });
    const storedNote = await testSql(db).get(
      "SELECT folder_id AS folderId FROM notes WHERE id = ?",
      noteId
    );
    expect(storedNote).toEqual({ folderId });
  });

  it("reparents a note to the deleted folder's parent", async () => {
    const app = await createTestApp();
    const agent = await registerAgent(app, "folder_reparent_user");
    const db = app.locals.db as ApplicationDatabase;

    const parent = await agent
      .post("/api/folders")
      .set(csrfHeaders())
      .send({ name: "Parent" })
      .expect(201);
    const parentId = String(parent.body.id);
    const nested = await agent
      .post("/api/folders")
      .set(csrfHeaders())
      .send({ name: "Nested", parentFolderId: parentId })
      .expect(201);
    const nestedId = String(nested.body.id);
    const note = await agent
      .post("/api/notes")
      .set(csrfHeaders())
      .send(notePayload(nestedId))
      .expect(201);
    const noteId = String(note.body.id);

    await agent.delete(`/api/folders/${nestedId}`).set(csrfHeaders()).expect(204);

    const storedNote = await testSql(db).get(
      "SELECT folder_id AS folderId FROM notes WHERE id = ?",
      noteId
    );
    expect(storedNote).toEqual({ folderId: parentId });
  });
});
