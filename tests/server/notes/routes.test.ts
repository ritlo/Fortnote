import { describe, expect, it } from "vitest";
import {
  createTestApp,
  csrfHeaders,
  notePayload,
  registerAgent
} from "../support/http.js";
import {
  failNoteEventWrites,
  protectedNotePayload,
  seedCheckpointManifest,
  sharingKeyPayload
} from "./routes.fixtures.js";

describe("notes and folders routes", () => {
	  it("persists encrypted display metadata and returns body-free lists", async () => {
	    const app = createTestApp();
	    const agent = await registerAgent(app, "protected_metadata_user");
	    const folderId = crypto.randomUUID();
	    await agent
	      .post("/api/folders")
	      .set(csrfHeaders())
	      .send({
	        id: folderId,
	        nameCipher: "encrypted_folder_name_abcdefghijklmnopqrstuvwxyz",
	        nameNonce: "encrypted_folder_nonce_abcdefghijklmnopqrstuvwxyz",
	        nameFormatVersion: 2
	      })
	      .expect(201);
	    const payload = { ...protectedNotePayload(), folderId };
	    await agent.post("/api/notes").set(csrfHeaders()).send(payload).expect(201);

	    const listed = await agent.get("/api/notes").expect(200);
	    expect(listed.body.notes).toHaveLength(1);
	    expect(listed.body.notes[0]).toMatchObject({
	      id: payload.id,
	      title: "",
	      titleCipher: payload.titleCipher,
	      titleNonce: payload.titleNonce,
	      titleFormatVersion: 2,
	      rootSectionId: payload.rootSectionId,
	      rootVersion: 1,
	      keyEpoch: 1
	    });
	    expect(listed.body.notes[0]).not.toHaveProperty("contentCipher");
	    expect(listed.body.notes[0]).not.toHaveProperty("contentNonce");
	    const folders = await agent.get("/api/folders").expect(200);
	    expect(folders.body.folders[0]).toMatchObject({
	      id: folderId,
	      name: "",
	      nameCipher: "encrypted_folder_name_abcdefghijklmnopqrstuvwxyz",
	      nameFormatVersion: 2
	    });

	    const stored = app.locals.db.sqlite
	      .prepare(
	        `SELECT title, title_cipher AS titleCipher,
	                content_cipher AS contentCipher, content_length AS contentLength
	         FROM notes WHERE id = ?`
	      )
	      .get(payload.id);
	    expect(stored).toEqual({
	      title: "",
	      titleCipher: payload.titleCipher,
	      contentCipher: "",
	      contentLength: 0
	    });
	  });

	  it("revalidates metadata role, root version, and epoch with concealed denial", async () => {
	    const app = createTestApp();
	    const owner = await registerAgent(app, "metadata_owner");
	    const outsider = await registerAgent(app, "metadata_outsider");
	    const payload = protectedNotePayload();
	    await owner.post("/api/notes").set(csrfHeaders()).send(payload).expect(201);

	    await owner
	      .put(`/api/notes/${payload.id}`)
	      .set(csrfHeaders())
	      .send({
	        titleCipher: "updated_title_cipher_abcdefghijklmnopqrstuvwxyz",
	        titleNonce: "updated_title_nonce_abcdefghijklmnopqrstuvwxyz",
	        titleFormatVersion: 2,
	        rootVersion: 1,
	        keyEpoch: 1
	      })
	      .expect(200)
	      .expect(({ body }) => {
	        expect(body).toMatchObject({ rootVersion: 2, keyEpoch: 1 });
	      });
    await owner
      .put(`/api/notes/${payload.id}`)
      .set(csrfHeaders())
      .send({ rootVersion: 1, keyEpoch: 1 })
      .expect(409);
    await owner
      .put(`/api/notes/${payload.id}`)
      .set(csrfHeaders())
      .send({ rootVersion: 2, keyEpoch: 2 })
      .expect(409);

	    const denied = await outsider.get(`/api/notes/${payload.id}`).expect(404);
	    const absent = await outsider.get(`/api/notes/${crypto.randomUUID()}`).expect(404);
	    expect(denied.body.error).toMatchObject({
	      code: absent.body.error.code,
	      message: absent.body.error.message
	    });
	  });

  it("lists only opaque section metadata for authorized readers", async () => {
    const app = createTestApp();
    const owner = await registerAgent(app, "section_metadata_owner");
    const outsider = await registerAgent(app, "section_metadata_outsider");
    const payload = protectedNotePayload();
    await owner.post("/api/notes").set(csrfHeaders()).send(payload).expect(201);

    const listed = await owner.get(`/api/notes/${payload.id}/sections`).expect(200);
    expect(listed.body.sections).toEqual([
      {
        id: payload.rootSectionId,
        noteId: payload.id,
        createdEpoch: 1,
        currentSequence: 0,
        initialized: false,
        isDeleted: false
      }
    ]);
    expect(JSON.stringify(listed.body)).not.toContain("cipher");
    expect(JSON.stringify(listed.body)).not.toContain("nonce");

    const denied = await outsider
      .get(`/api/notes/${payload.id}/sections`)
      .expect(404);
    const absent = await outsider
      .get(`/api/notes/${crypto.randomUUID()}/sections`)
      .expect(404);
    expect(denied.body.error).toMatchObject({
      code: absent.body.error.code,
      message: absent.body.error.message
    });
  });

  it("creates and tombstones sections idempotently with fresh fences", async () => {
    const app = createTestApp();
    const owner = await registerAgent(app, "section_mutation_owner");
    const outsider = await registerAgent(app, "section_mutation_outsider");
    const payload = protectedNotePayload();
    const createdSectionId = crypto.randomUUID();
    await owner.post("/api/notes").set(csrfHeaders()).send(payload).expect(201);

    await owner
      .post(`/api/notes/${payload.id}/sections`)
      .set(csrfHeaders())
      .send({
        sectionId: createdSectionId,
        expectedKeyEpoch: 1,
        expectedRootVersion: 1
      })
      .expect(201)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          status: "created",
          rootVersion: 2,
          version: 2,
          section: { id: createdSectionId, initialized: false }
        });
      });
    await owner
      .post(`/api/notes/${payload.id}/sections`)
      .set(csrfHeaders())
      .send({
        sectionId: createdSectionId,
        expectedKeyEpoch: 1,
        expectedRootVersion: 99
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          status: "already-created",
          rootVersion: 2,
          version: 2
        });
      });
    await owner
      .post(`/api/notes/${payload.id}/sections`)
      .set(csrfHeaders())
      .send({
        sectionId: crypto.randomUUID(),
        expectedKeyEpoch: 1,
        expectedRootVersion: 99
      })
      .expect(409);
    await outsider
      .post(`/api/notes/${payload.id}/sections`)
      .set(csrfHeaders())
      .send({
        sectionId: crypto.randomUUID(),
        expectedKeyEpoch: 1,
        expectedRootVersion: 1
      })
      .expect(404);

    await owner
      .delete(`/api/notes/${payload.id}/sections/${createdSectionId}`)
      .set(csrfHeaders())
      .send({ expectedKeyEpoch: 1, expectedRootVersion: 2 })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          status: "deleted",
          rootVersion: 3,
          version: 3
        });
      });
    await owner
      .delete(`/api/notes/${payload.id}/sections/${createdSectionId}`)
      .set(csrfHeaders())
      .send({ expectedKeyEpoch: 1, expectedRootVersion: 99 })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          status: "already-deleted",
          rootVersion: 3,
          version: 3
        });
      });
    await owner
      .delete(`/api/notes/${payload.id}/sections/${payload.rootSectionId}`)
      .set(csrfHeaders())
      .send({ expectedKeyEpoch: 1, expectedRootVersion: 3 })
      .expect(409);
    const listed = await owner.get(`/api/notes/${payload.id}/sections`).expect(200);
    expect(listed.body.sections.map((section: { id: string }) => section.id)).toEqual([
      payload.rootSectionId
    ]);
  });

  it("reserves one recoverable migration section without exposing legacy content in metadata", async () => {
    const app = createTestApp();
    const owner = await registerAgent(app, "legacy_section_owner");
    const outsider = await registerAgent(app, "legacy_section_outsider");
    const legacy = notePayload();
    const firstSectionId = crypto.randomUUID();
    const competingSectionId = crypto.randomUUID();
    await owner.post("/api/notes").set(csrfHeaders()).send(legacy).expect(201);

    const listed = await owner.get("/api/notes").expect(200);
    expect(listed.body.notes[0]).toMatchObject({
      id: legacy.id,
      legacyContentAvailable: true,
      rootSectionId: null
    });
    expect(listed.body.notes[0]).not.toHaveProperty("contentCipher");
    const content = await owner
      .get(`/api/notes/${legacy.id}/legacy-content`)
      .expect(200);
    expect(content.body).toMatchObject({
      contentCipher: legacy.contentCipher,
      contentNonce: legacy.contentNonce,
      contentLength: legacy.contentLength,
      rootVersion: 1,
      keyEpoch: 1
    });
    await outsider.get(`/api/notes/${legacy.id}/legacy-content`).expect(404);

    const reserved = await owner
      .post(`/api/notes/${legacy.id}/sections/legacy-reservation`)
      .set(csrfHeaders())
      .send({
        sectionId: firstSectionId,
        expectedKeyEpoch: 1,
        expectedRootVersion: 1
      })
      .expect(201);
    expect(reserved.body).toMatchObject({
      status: "reserved",
      sectionId: firstSectionId,
      rootVersion: 2,
      version: 2
    });
    await owner
      .post(`/api/notes/${legacy.id}/sections/legacy-reservation`)
      .set(csrfHeaders())
      .send({
        sectionId: firstSectionId,
        expectedKeyEpoch: 1,
        expectedRootVersion: 1
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          status: "reserved",
          sectionId: firstSectionId,
          rootVersion: 2
        });
      });
    await owner
      .post(`/api/notes/${legacy.id}/sections/legacy-reservation`)
      .set(csrfHeaders())
      .send({
        sectionId: competingSectionId,
        expectedKeyEpoch: 1,
        expectedRootVersion: 2
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          status: "pending",
          sectionId: firstSectionId,
          rootVersion: 2
        });
      });
    expect(
      app.locals.db.sqlite
        .prepare(`
          SELECT n.root_section_id AS rootSectionId, s.is_deleted AS isDeleted
          FROM notes n INNER JOIN note_sections s ON s.id = n.root_section_id
          WHERE n.id = ?
        `)
        .get(legacy.id)
    ).toEqual({ rootSectionId: firstSectionId, isDeleted: 0 });
  });

  it("replaces only a stale empty migration reservation", async () => {
    const app = createTestApp();
    const owner = await registerAgent(app, "stale_legacy_section_owner");
    const legacy = notePayload();
    const staleSectionId = crypto.randomUUID();
    const replacementSectionId = crypto.randomUUID();
    await owner.post("/api/notes").set(csrfHeaders()).send(legacy).expect(201);
    await owner
      .post(`/api/notes/${legacy.id}/sections/legacy-reservation`)
      .set(csrfHeaders())
      .send({
        sectionId: staleSectionId,
        expectedKeyEpoch: 1,
        expectedRootVersion: 1
      })
      .expect(201);
    app.locals.db.sqlite
      .prepare("UPDATE note_sections SET updated_at = datetime('now', '-1 hour') WHERE id = ?")
      .run(staleSectionId);

    await owner
      .post(`/api/notes/${legacy.id}/sections/legacy-reservation`)
      .set(csrfHeaders())
      .send({
        sectionId: replacementSectionId,
        expectedKeyEpoch: 1,
        expectedRootVersion: 2
      })
      .expect(201)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          status: "reserved",
          sectionId: replacementSectionId,
          rootVersion: 3
        });
      });
    expect(
      app.locals.db.sqlite
        .prepare("SELECT id, is_deleted AS isDeleted FROM note_sections WHERE note_id = ? ORDER BY id")
        .all(legacy.id)
    ).toEqual(expect.arrayContaining([
      { id: staleSectionId, isDeleted: 1 },
      { id: replacementSectionId, isDeleted: 0 }
    ]));
  });

  it("clears legacy columns only after installing the committed initial checkpoint", async () => {
    const app = createTestApp();
    const owner = await registerAgent(app, "legacy_initialization_owner");
    const legacy = notePayload();
    const sectionId = crypto.randomUUID();
    await owner.post("/api/notes").set(csrfHeaders()).send(legacy).expect(201);
    await owner
      .post(`/api/notes/${legacy.id}/sections/legacy-reservation`)
      .set(csrfHeaders())
      .send({ sectionId, expectedKeyEpoch: 1, expectedRootVersion: 1 })
      .expect(201);
    const cryptoOwner = app.locals.db.sqlite
      .prepare("SELECT crypto_owner_id AS cryptoOwnerId FROM notes WHERE id = ?")
      .get(legacy.id) as { cryptoOwnerId: string };
    const manifestId = seedCheckpointManifest(app, {
      noteId: legacy.id,
      sectionId,
      cryptoOwnerId: cryptoOwner.cryptoOwnerId
    });

    await owner
      .post(`/api/notes/${legacy.id}/sections/${sectionId}/initialization`)
      .set(csrfHeaders())
      .send({ manifestId, expectedKeyEpoch: 1, expectedRootVersion: 2 })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          status: "installed",
          manifestId,
          rootVersion: 2,
          version: 2
        });
      });
    await owner.get(`/api/notes/${legacy.id}/legacy-content`).expect(409);
    await owner.get(`/api/notes/${legacy.id}`).expect(200).expect(({ body }) => {
      expect(body).toMatchObject({ legacyContentAvailable: false });
    });
    expect(
      app.locals.db.sqlite
        .prepare(`
          SELECT content_cipher AS contentCipher, content_nonce AS contentNonce,
                 content_length AS contentLength
          FROM notes WHERE id = ?
        `)
        .get(legacy.id)
    ).toEqual({ contentCipher: "", contentNonce: "", contentLength: 0 });
    await owner
      .post(`/api/notes/${legacy.id}/sections/${sectionId}/initialization`)
      .set(csrfHeaders())
      .send({ manifestId, expectedKeyEpoch: 1, expectedRootVersion: 2 })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({ status: "already-initialized", manifestId });
      });
    expect(
      app.locals.db.sqlite
        .prepare("SELECT COUNT(*) AS count FROM note_events WHERE note_id = ?")
        .get(legacy.id)
    ).toEqual({ count: 3 });
  });

  it("rolls back legacy section reservations when event writes fail", async () => {
    const app = createTestApp();
    const owner = await registerAgent(app, "rollback_section_reservation_owner");
    const legacy = notePayload();
    const sectionId = crypto.randomUUID();
    await owner.post("/api/notes").set(csrfHeaders()).send(legacy).expect(201);

    failNoteEventWrites(app);
    await owner
      .post(`/api/notes/${legacy.id}/sections/legacy-reservation`)
      .set(csrfHeaders())
      .send({ sectionId, expectedKeyEpoch: 1, expectedRootVersion: 1 })
      .expect(500);

    expect(
      app.locals.db.sqlite
        .prepare(
          `SELECT root_section_id AS rootSectionId, root_version AS rootVersion,
                  version FROM notes WHERE id = ?`
        )
        .get(legacy.id)
    ).toEqual({ rootSectionId: null, rootVersion: 1, version: 1 });
    expect(
      app.locals.db.sqlite
        .prepare("SELECT id FROM note_sections WHERE id = ?")
        .get(sectionId)
    ).toBeUndefined();
  });

  it("rolls back section initialization when event writes fail", async () => {
    const app = createTestApp();
    const owner = await registerAgent(app, "rollback_section_initialization_owner");
    const legacy = notePayload();
    const sectionId = crypto.randomUUID();
    await owner.post("/api/notes").set(csrfHeaders()).send(legacy).expect(201);
    await owner
      .post(`/api/notes/${legacy.id}/sections/legacy-reservation`)
      .set(csrfHeaders())
      .send({ sectionId, expectedKeyEpoch: 1, expectedRootVersion: 1 })
      .expect(201);
    const cryptoOwner = app.locals.db.sqlite
      .prepare("SELECT crypto_owner_id AS cryptoOwnerId FROM notes WHERE id = ?")
      .get(legacy.id) as { cryptoOwnerId: string };
    const manifestId = seedCheckpointManifest(app, {
      noteId: legacy.id,
      sectionId,
      cryptoOwnerId: cryptoOwner.cryptoOwnerId
    });

    failNoteEventWrites(app);
    await owner
      .post(`/api/notes/${legacy.id}/sections/${sectionId}/initialization`)
      .set(csrfHeaders())
      .send({ manifestId, expectedKeyEpoch: 1, expectedRootVersion: 2 })
      .expect(500);

    expect(
      app.locals.db.sqlite
        .prepare(
          `SELECT n.content_cipher AS contentCipher,
                  s.initialization_manifest_id AS initializationManifestId
           FROM notes n
           INNER JOIN note_sections s ON s.id = n.root_section_id
           WHERE n.id = ?`
        )
        .get(legacy.id)
    ).toEqual({
      contentCipher: legacy.contentCipher,
      initializationManifestId: null
    });
    expect(
      app.locals.db.sqlite
        .prepare(
          "SELECT manifest_id AS manifestId FROM crdt_initializations WHERE note_id = ?"
        )
        .get(legacy.id)
    ).toBeUndefined();
  });

	  it("atomically upgrades an owned legacy note to protected v2 metadata", async () => {
	    const app = createTestApp();
	    const owner = await registerAgent(app, "metadata_migration_owner");
	    const legacy = notePayload();
	    const rootSectionId = crypto.randomUUID();
	    await owner.post("/api/notes").set(csrfHeaders()).send(legacy).expect(201);

	    await owner
	      .put(`/api/notes/${legacy.id}`)
	      .set(csrfHeaders())
	      .send({
	        titleCipher: "migrated_title_cipher_abcdefghijklmnopqrstuvwxyz",
	        titleNonce: "migrated_title_nonce_abcdefghijklmnopqrstuvwxyz",
	        titleFormatVersion: 2,
	        encryptedNoteKey: "migrated_note_key_cipher_abcdefghijklmnopqrstuvwxyz",
	        noteKeyNonce: "migrated_note_key_nonce_abcdefghijklmnopqrstuvwxyz",
	        noteKeyFormatVersion: 2,
	        rootSectionId,
	        rootVersion: 1,
	        keyEpoch: 1
	      })
	      .expect(200);

	    expect(
	      app.locals.db.sqlite
	        .prepare(
	          `SELECT title, title_format_version AS titleFormatVersion,
	                  note_key_format_version AS noteKeyFormatVersion,
	                  root_section_id AS rootSectionId
	           FROM notes WHERE id = ?`
	        )
	        .get(legacy.id)
	    ).toEqual({
      title: "",
	      titleFormatVersion: 2,
	      noteKeyFormatVersion: 2,
	      rootSectionId
	    });
	    expect(
	      app.locals.db.sqlite
	        .prepare("SELECT id FROM note_sections WHERE id = ? AND note_id = ?")
	        .get(rootSectionId, legacy.id)
	    ).toEqual({ id: rootSectionId });
	  });

	  it("atomically revokes a member and activates an adjacent linked epoch", async () => {
	    const app = createTestApp();
	    const owner = await registerAgent(app, "linked_owner");
	    const revoked = await registerAgent(app, "linked_revoked");
	    const remaining = await registerAgent(app, "linked_remaining");
	    const revokedUser = await revoked.get("/api/auth/me").expect(200);
	    const remainingUser = await remaining.get("/api/auth/me").expect(200);
	    await revoked
	      .put("/api/sharing-keys/current")
	      .set(csrfHeaders())
	      .send({ ...sharingKeyPayload(2), formatVersion: 2 })
	      .expect(201);
	    await remaining
	      .put("/api/sharing-keys/current")
	      .set(csrfHeaders())
	      .send({ ...sharingKeyPayload(2), formatVersion: 2 })
	      .expect(201);
	    const payload = protectedNotePayload();
	    await owner.post("/api/notes").set(csrfHeaders()).send(payload).expect(201);
	    for (const username of ["linked_revoked", "linked_remaining"]) {
	      await owner
	        .post(`/api/notes/${payload.id}/memberships`)
	        .set(csrfHeaders())
	        .send({
	          username,
	          role: "editor",
	          sharingKeyVersion: 2,
	          encryptedNoteKey: `initial_share_${username}_abcdefghijklmnopqrstuvwxyz`,
	          formatVersion: 2
	        })
	        .expect(201);
	    }

	    const rotationPayload = {
	      mode: "linked",
	      revokedUserId: revokedUser.body.id,
	      rootVersion: 1,
	      sourceEpoch: 1,
	      targetEpoch: 2,
	      encryptedNoteKey: "new_owner_note_key_abcdefghijklmnopqrstuvwxyz",
	      noteKeyNonce: "new_owner_note_nonce_abcdefghijklmnopqrstuvwxyz",
	      noteKeyFormatVersion: 2,
	      titleCipher: "new_title_cipher_abcdefghijklmnopqrstuvwxyz",
	      titleNonce: "new_title_nonce_abcdefghijklmnopqrstuvwxyz",
	      titleFormatVersion: 2,
	      previousKeyCipher: "linked_previous_key_cipher_abcdefghijklmnopqrstuvwxyz",
	      previousKeyNonce: "linked_previous_key_nonce_abcdefghijklmnopqrstuvwxyz",
	      linkFormatVersion: 2,
	      shares: [
	        {
	          recipientUserId: remainingUser.body.id,
	          sharingKeyVersion: 2,
	          encryptedNoteKey: "new_remaining_share_abcdefghijklmnopqrstuvwxyz",
	          formatVersion: 2
	        }
	      ]
	    };

	    await owner
	      .post(`/api/notes/${payload.id}/key-rotation`)
	      .set(csrfHeaders())
	      .send({ ...rotationPayload, shares: [] })
	      .expect(400);
	    expect(
	      app.locals.db.sqlite
	        .prepare(
	          "SELECT key_epoch AS keyEpoch, root_version AS rootVersion, rotation_fenced AS rotationFenced FROM notes WHERE id = ?"
	        )
	        .get(payload.id)
	    ).toEqual({ keyEpoch: 1, rootVersion: 1, rotationFenced: 0 });
	    expect(
	      app.locals.db.sqlite
	        .prepare(
	          "SELECT status FROM note_memberships WHERE note_id = ? AND user_id = ?"
	        )
	        .get(payload.id, revokedUser.body.id)
	    ).toEqual({ status: "active" });

	    await owner
	      .post(`/api/notes/${payload.id}/key-rotation`)
	      .set(csrfHeaders())
	      .send(rotationPayload)
	      .expect(200)
	      .expect(({ body }) => {
	        expect(body).toMatchObject({ rootVersion: 2, keyEpoch: 2 });
	      });

	    const note = app.locals.db.sqlite
	      .prepare(
	        `SELECT key_epoch AS keyEpoch, root_version AS rootVersion,
	                rotation_fenced AS rotationFenced, title_cipher AS titleCipher
	         FROM notes WHERE id = ?`
	      )
	      .get(payload.id);
	    expect(note).toEqual({
	      keyEpoch: 2,
	      rootVersion: 2,
	      rotationFenced: 0,
	      titleCipher: rotationPayload.titleCipher
	    });
	    expect(
	      app.locals.db.sqlite
	        .prepare(
	          "SELECT source_epoch AS sourceEpoch, target_epoch AS targetEpoch FROM note_epoch_links WHERE note_id = ?"
	        )
	        .get(payload.id)
	    ).toEqual({ sourceEpoch: 1, targetEpoch: 2 });
	    const links = await owner
	      .get(`/api/notes/${payload.id}/epoch-links`)
	      .expect(200);
	    expect(links.body.links).toEqual([
	      expect.objectContaining({
	        sourceEpoch: 1,
	        targetEpoch: 2,
	        previousKeyCipher: rotationPayload.previousKeyCipher,
	        formatVersion: 2
	      })
	    ]);
	    await remaining
	      .get(`/api/notes/${payload.id}/epoch-links`)
	      .expect(200);
	    await revoked
	      .get(`/api/notes/${payload.id}/epoch-links`)
	      .expect(404);
	    expect(
	      app.locals.db.sqlite
	        .prepare(
	          "SELECT status FROM note_memberships WHERE note_id = ? AND user_id = ?"
	        )
	        .get(payload.id, revokedUser.body.id)
	    ).toEqual({ status: "revoked" });
	    expect(
	      app.locals.db.sqlite
	        .prepare(
	          "SELECT encrypted_note_key AS encryptedNoteKey FROM note_key_shares WHERE note_id = ? AND recipient_user_id = ?"
	        )
	        .get(payload.id, remainingUser.body.id)
	    ).toEqual({ encryptedNoteKey: "new_remaining_share_abcdefghijklmnopqrstuvwxyz" });
	  });

	  it("rolls back linked rotations when event writes fail", async () => {
	    const app = createTestApp();
	    const owner = await registerAgent(app, "linked_rollback_owner");
	    const revoked = await registerAgent(app, "linked_rollback_revoked");
	    const remaining = await registerAgent(app, "linked_rollback_remaining");
	    const revokedUser = await revoked.get("/api/auth/me").expect(200);
	    const remainingUser = await remaining.get("/api/auth/me").expect(200);
	    await revoked
	      .put("/api/sharing-keys/current")
	      .set(csrfHeaders())
	      .send({ ...sharingKeyPayload(2), formatVersion: 2 })
	      .expect(201);
	    await remaining
	      .put("/api/sharing-keys/current")
	      .set(csrfHeaders())
	      .send({ ...sharingKeyPayload(2), formatVersion: 2 })
	      .expect(201);
	    const payload = protectedNotePayload();
	    await owner.post("/api/notes").set(csrfHeaders()).send(payload).expect(201);
	    for (const username of ["linked_rollback_revoked", "linked_rollback_remaining"]) {
	      await owner
	        .post(`/api/notes/${payload.id}/memberships`)
	        .set(csrfHeaders())
	        .send({
	          username,
	          role: "editor",
	          sharingKeyVersion: 2,
	          encryptedNoteKey: `initial_share_${username}_abcdefghijklmnopqrstuvwxyz`,
	          formatVersion: 2
	        })
	        .expect(201);
	    }

	    failNoteEventWrites(app);
	    await owner
	      .post(`/api/notes/${payload.id}/key-rotation`)
	      .set(csrfHeaders())
	      .send({
	        mode: "linked",
	        revokedUserId: revokedUser.body.id,
	        rootVersion: 1,
	        sourceEpoch: 1,
	        targetEpoch: 2,
	        encryptedNoteKey: "failed_linked_note_key_abcdefghijklmnopqrstuvwxyz",
	        noteKeyNonce: "failed_linked_note_nonce_abcdefghijklmnopqrstuvwxyz",
	        noteKeyFormatVersion: 2,
	        titleCipher: "failed_linked_title_cipher_abcdefghijklmnopqrstuvwxyz",
	        titleNonce: "failed_linked_title_nonce_abcdefghijklmnopqrstuvwxyz",
	        titleFormatVersion: 2,
	        previousKeyCipher: "failed_linked_previous_key_abcdefghijklmnopqrstuvwxyz",
	        previousKeyNonce: "failed_linked_previous_nonce_abcdefghijklmnopqrstuvwxyz",
	        linkFormatVersion: 2,
	        shares: [
	          {
	            recipientUserId: remainingUser.body.id,
	            sharingKeyVersion: 2,
	            encryptedNoteKey: "failed_linked_remaining_share_abcdefghijklmnopqrstuvwxyz",
	            formatVersion: 2
	          }
	        ]
	      })
	      .expect(500);

	    expect(
	      app.locals.db.sqlite
	        .prepare(
	          `SELECT key_epoch AS keyEpoch, root_version AS rootVersion,
	                  rotation_fenced AS rotationFenced, title_cipher AS titleCipher
	           FROM notes WHERE id = ?`
	        )
	        .get(payload.id)
	    ).toEqual({
	      keyEpoch: 1,
	      rootVersion: 1,
	      rotationFenced: 0,
	      titleCipher: payload.titleCipher
	    });
	    expect(
	      app.locals.db.sqlite
	        .prepare(
	          "SELECT status FROM note_memberships WHERE note_id = ? AND user_id = ?"
	        )
	        .get(payload.id, revokedUser.body.id)
	    ).toEqual({ status: "active" });
	    expect(
	      app.locals.db.sqlite
	        .prepare(
	          "SELECT target_epoch AS targetEpoch FROM note_epoch_links WHERE note_id = ?"
	        )
	        .get(payload.id)
	    ).toBeUndefined();
	    expect(
	      app.locals.db.sqlite
	        .prepare(
	          "SELECT encrypted_note_key AS encryptedNoteKey FROM note_key_shares WHERE note_id = ? AND recipient_user_id = ?"
	        )
	        .get(payload.id, remainingUser.body.id)
	    ).toEqual({
	      encryptedNoteKey:
	        "initial_share_linked_rollback_remaining_abcdefghijklmnopqrstuvwxyz"
	    });
	  });

	  it("creates folder and note, then updates with optimistic version", async () => {
	    const app = createTestApp();
	    const agent = await registerAgent(app, "notes_user");

    const folder = await agent
      .post("/api/folders")
      .set(csrfHeaders())
      .send({ name: "Work" })
      .expect(201);

    const note = await agent
      .post("/api/notes")
      .set(csrfHeaders())
      .send(notePayload(folder.body.id as string))
      .expect(201);

	    const updated = await agent
      .put(`/api/notes/${String(note.body.id)}`)
      .set(csrfHeaders())
      .send({
        title: "Updated",
        contentCipher: "updated_content_cipher_abcdefghijklmnopqrstuvwxyz",
        contentNonce: "updated_content_nonce_abcdefghijklmnopqrstuvwxyz",
        contentLength: 256,
        version: 1
      })
      .expect(200);

    const storedUpdate = app.locals.db.sqlite
      .prepare("SELECT updated_at AS updatedAt FROM notes WHERE id = ?")
      .get(note.body.id) as { updatedAt: string };
    expect(updated.body).toMatchObject({
      version: 2,
      updatedAt: `${storedUpdate.updatedAt.replace(" ", "T")}Z`
    });
    const membership = app.locals.db.sqlite
      .prepare(
        `SELECT role, status
         FROM note_memberships
	         WHERE note_id = ?`
	      )
      .get(note.body.id) as { role: string; status: string } | undefined;
    expect(membership).toEqual({ role: "owner", status: "active" });

    const events = app.locals.db.sqlite
      .prepare(
        `SELECT event_type AS eventType, note_version AS noteVersion
         FROM note_events
         WHERE note_id = ?
         ORDER BY cursor`
      )
      .all(note.body.id) as { eventType: string; noteVersion: number }[];
    expect(events).toEqual([
      { eventType: "note.created", noteVersion: 1 },
      { eventType: "note.updated", noteVersion: 2 }
    ]);
  });

});
