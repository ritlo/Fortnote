import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  createTestApp,
  csrfHeaders,
  notePayload,
  registerAgent
} from "../test/http.js";

function sharingKeyPayload(version = 1) {
  return {
    sharingKeyVersion: version,
    publicKey: `public_sharing_key_${String(version)}_abcdefghijklmnopqrstuvwxyz`,
    encryptedPrivateKey: `encrypted_private_key_${String(version)}_abcdefghijklmnopqrstuvwxyz`,
    privateKeyNonce: `private_key_nonce_${String(version)}_abcdefghijklmnopqrstuvwxyz`,
    formatVersion: 1
  };
}

function protectedNotePayload() {
  return {
    id: crypto.randomUUID(),
    rootSectionId: crypto.randomUUID(),
    titleCipher: "encrypted_title_cipher_abcdefghijklmnopqrstuvwxyz",
    titleNonce: "encrypted_title_nonce_abcdefghijklmnopqrstuvwxyz",
    titleFormatVersion: 2,
    encryptedNoteKey: "encrypted_note_key_v2_abcdefghijklmnopqrstuvwxyz",
    noteKeyNonce: "encrypted_note_key_nonce_v2_abcdefghijklmnopqrstuvwxyz",
    noteKeyFormatVersion: 2
  };
}

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

  it("rejects stale note versions", async () => {
    const app = createTestApp();
    const agent = await registerAgent(app, "stale_user");
    const created = await agent
      .post("/api/notes")
      .set(csrfHeaders())
      .send(notePayload())
      .expect(201);

    await agent
      .put(`/api/notes/${String(created.body.id)}`)
      .set(csrfHeaders())
      .send({
        contentCipher: "updated_content_cipher_abcdefghijklmnopqrstuvwxyz",
        contentNonce: "updated_content_nonce_abcdefghijklmnopqrstuvwxyz",
        contentLength: 256,
        version: 2
      })
      .expect(409);
  });

  it("rolls back note updates when event writes fail", async () => {
    const app = createTestApp();
    const agent = await registerAgent(app, "rollback_update_user");
    const created = await agent
      .post("/api/notes")
      .set(csrfHeaders())
      .send(notePayload())
      .expect(201);
    const noteId = String(created.body.id);

    failNoteEventWrites(app);

    await agent
      .put(`/api/notes/${noteId}`)
      .set(csrfHeaders())
      .send({
        title: "Should roll back",
        contentCipher: "rollback_content_cipher_abcdefghijklmnopqrstuvwxyz",
        contentNonce: "rollback_content_nonce_abcdefghijklmnopqrstuvwxyz",
        contentLength: 512,
        version: 1
      })
      .expect(500);

    const note = app.locals.db.sqlite
      .prepare(
        `SELECT title,
                content_cipher AS contentCipher,
                content_length AS contentLength,
                version
         FROM notes
         WHERE id = ?`
      )
      .get(noteId) as {
      contentCipher: string;
      contentLength: number;
      title: string;
      version: number;
    };
    expect(note).toEqual({
      contentCipher: "content_cipher_abcdefghijklmnopqrstuvwxyz",
      contentLength: 128,
      title: "Encrypted note",
      version: 1
    });
  });

  it("rolls back note creates when event writes fail", async () => {
    const app = createTestApp();
    const agent = await registerAgent(app, "rollback_create_user");
    const payload = notePayload();

    failNoteEventWrites(app);

    await agent.post("/api/notes").set(csrfHeaders()).send(payload).expect(500);

    const note = app.locals.db.sqlite
      .prepare("SELECT id FROM notes WHERE id = ?")
      .get(payload.id);
    expect(note).toBeUndefined();
    const membership = app.locals.db.sqlite
      .prepare("SELECT note_id AS noteId FROM note_memberships WHERE note_id = ?")
      .get(payload.id);
    expect(membership).toBeUndefined();
  });

  it("prevents cross-user note reads and folder assignment", async () => {
    const app = createTestApp();
    const alice = await registerAgent(app, "alice_notes");
    const bob = await registerAgent(app, "bob_notes");

    const folder = await alice
      .post("/api/folders")
      .set(csrfHeaders())
      .send({ name: "Alice" })
      .expect(201);

    const created = await alice
      .post("/api/notes")
      .set(csrfHeaders())
      .send(notePayload(folder.body.id as string))
      .expect(201);

    await bob.get(`/api/notes/${String(created.body.id)}`).expect(404);

    await bob
      .post("/api/notes")
      .set(csrfHeaders())
      .send(notePayload(folder.body.id as string))
      .expect(400);
  });

  it("requires an active owner membership to read notes", async () => {
    const app = createTestApp();
    const agent = await registerAgent(app, "membership_user");
    const created = await agent
      .post("/api/notes")
      .set(csrfHeaders())
      .send(notePayload())
      .expect(201);

    await agent.get(`/api/notes/${String(created.body.id)}`).expect(200);
    app.locals.db.sqlite
      .prepare(
        `UPDATE note_memberships
         SET status = 'revoked'
         WHERE note_id = ?`
      )
      .run(created.body.id);

    await agent.get(`/api/notes/${String(created.body.id)}`).expect(404);
    const listed = await agent.get("/api/notes").expect(200);
    expect(listed.body.notes).toHaveLength(0);
  });

  it("invites, updates, and revokes note collaborators with key shares", async () => {
    const app = createTestApp();
    const alice = await registerAgent(app, "member_alice");
    const bob = await registerAgent(app, "member_bob");
    await registerAgent(app, "member_carol");

    const bobSession = await bob.get("/api/auth/me").expect(200);
    const bobUserId = String(bobSession.body.id);

    await bob
      .put("/api/sharing-keys/current")
      .set(csrfHeaders())
      .send(sharingKeyPayload())
      .expect(201);

    const created = await alice
      .post("/api/notes")
      .set(csrfHeaders())
      .send(notePayload())
      .expect(201);
    const noteId = String(created.body.id);

    await alice
      .post(`/api/notes/${noteId}/memberships`)
      .set(csrfHeaders())
      .send({
        username: "member_carol",
        role: "viewer",
        sharingKeyVersion: 1,
        encryptedNoteKey: "encrypted_share_for_carol_abcdefghijklmnopqrstuvwxyz",
        formatVersion: 1
      })
      .expect(404);

    const invited = await alice
      .post(`/api/notes/${noteId}/memberships`)
      .set(csrfHeaders())
      .send({
        username: "member_bob",
        role: "editor",
        sharingKeyVersion: 1,
        encryptedNoteKey: "encrypted_share_for_bob_abcdefghijklmnopqrstuvwxyz",
        formatVersion: 1
      })
      .expect(201);
    expect(invited.body).toMatchObject({
      userId: bobUserId,
      username: "member_bob",
      role: "editor",
      status: "active"
    });

    const keyShare = await bob.get(`/api/notes/${noteId}/key-share`).expect(200);
    expect(keyShare.body).toMatchObject({
      noteId,
      recipientUserId: bobUserId,
      senderUserId: expect.any(String),
      sharingKeyVersion: 1,
      encryptedNoteKey: "encrypted_share_for_bob_abcdefghijklmnopqrstuvwxyz",
      formatVersion: 1
    });

    const bobList = await bob.get("/api/notes").expect(200);
    expect(bobList.body.notes).toHaveLength(1);
    expect(bobList.body.notes[0]).toMatchObject({
      id: noteId,
      role: "editor",
      encryptedNoteKey: null,
      noteKeyNonce: null,
      cryptoOwnerId: expect.any(String),
      ownerUserId: expect.any(String)
    });

    const bobRead = await bob.get(`/api/notes/${noteId}`).expect(200);
    expect(bobRead.body).toMatchObject({
      id: noteId,
      role: "editor",
      encryptedNoteKey: null,
      noteKeyNonce: null
    });

    await bob
      .put(`/api/notes/${noteId}`)
      .set(csrfHeaders())
      .send({
        title: "Shared edit",
        contentCipher: "shared_updated_content_cipher_abcdefghijklmnopqrstuvwxyz",
        contentNonce: "shared_updated_content_nonce_abcdefghijklmnopqrstuvwxyz",
        contentLength: 512,
        version: 1
      })
      .expect(200);

    const aliceRead = await alice.get(`/api/notes/${noteId}`).expect(200);
    expect(aliceRead.body).toMatchObject({
      title: "Shared edit",
      version: 2,
      encryptedNoteKey: expect.any(String),
      noteKeyNonce: expect.any(String),
      role: "owner"
    });

    const memberships = await bob.get(`/api/notes/${noteId}/memberships`).expect(200);
    expect(memberships.body.memberships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ username: "member_alice", role: "owner" }),
        expect.objectContaining({ username: "member_bob", role: "editor" })
      ])
    );

    await alice
      .patch(`/api/notes/${noteId}/memberships/${bobUserId}`)
      .set(csrfHeaders())
      .send({ role: "viewer" })
      .expect(200);

    await bob
      .put(`/api/notes/${noteId}`)
      .set(csrfHeaders())
      .send({
        contentCipher: "viewer_updated_content_cipher_abcdefghijklmnopqrstuvwxyz",
        contentNonce: "viewer_updated_content_nonce_abcdefghijklmnopqrstuvwxyz",
        contentLength: 1024,
        version: 2
      })
      .expect(404);

    await alice
      .delete(`/api/notes/${noteId}/memberships/${bobUserId}`)
      .set(csrfHeaders())
      .expect(204);

    await bob.get(`/api/notes/${noteId}/key-share`).expect(404);
    await bob.get(`/api/notes/${noteId}/memberships`).expect(404);

    const events = app.locals.db.sqlite
      .prepare(
        `SELECT event_type AS eventType,
                resource_type AS resourceType,
                payload_metadata AS payloadMetadata
         FROM note_events
         WHERE note_id = ?
         ORDER BY cursor`
      )
      .all(noteId) as {
      eventType: string;
      resourceType: string;
      payloadMetadata: string | null;
    }[];

    expect(events.map((event) => event.eventType)).toEqual([
      "note.created",
      "membership.added",
      "note.updated",
      "membership.role_updated",
      "membership.revoked"
    ]);
    expect(events.slice(1).every((event) => event.resourceType === "membership")).toBe(
      false
    );
    expect(events.filter((event) => event.resourceType === "membership")).toHaveLength(
      3
    );
    expect(events.slice(3).every((event) => event.resourceType === "membership")).toBe(
      true
    );
    expect(JSON.parse(events.at(-1)?.payloadMetadata ?? "{}")).toMatchObject({
      membershipUserId: bobUserId
    });
  });

  it("rotates note keys for all active members and attachments", async () => {
    const app = createTestApp();
    const alice = await registerAgent(app, "rotate_alice");
    const bob = await registerAgent(app, "rotate_bob");
    const bobSession = await bob.get("/api/auth/me").expect(200);
    const bobUserId = String(bobSession.body.id);

    await bob
      .put("/api/sharing-keys/current")
      .set(csrfHeaders())
      .send(sharingKeyPayload(2))
      .expect(201);
    const created = await alice
      .post("/api/notes")
      .set(csrfHeaders())
      .send(notePayload())
      .expect(201);
    const noteId = String(created.body.id);
    await alice
      .post(`/api/notes/${noteId}/memberships`)
      .set(csrfHeaders())
      .send({
        username: "rotate_bob",
        role: "editor",
        sharingKeyVersion: 2,
        encryptedNoteKey: "old_share_for_bob_abcdefghijklmnopqrstuvwxyz",
        formatVersion: 1
      })
      .expect(201);
    await alice
      .post(`/api/notes/${noteId}/attachments`)
      .set(csrfHeaders())
      .set({
        "content-type": "application/octet-stream",
        "x-fortnote-attachment-id": "00000000-0000-4000-8000-000000000001",
        "x-fortnote-filename": "rotate.txt",
        "x-fortnote-mime-type": "text/plain",
        "x-fortnote-size": "8",
        "x-fortnote-encrypted-attachment-key":
          "old_attachment_key_abcdefghijklmnopqrstuvwxyz",
        "x-fortnote-attachment-key-nonce":
          "old_attachment_nonce_abcdefghijklmnopqrstuvwxyz",
        "x-fortnote-file-nonce": "file_nonce_abcdefghijklmnopqrstuvwxyz"
      })
      .send(Buffer.from("ciphered"))
      .expect(201);

    const rotated = await alice
      .post(`/api/notes/${noteId}/key-rotation`)
      .set(csrfHeaders())
      .send({
        encryptedNoteKey: "rotated_owner_note_key_abcdefghijklmnopqrstuvwxyz",
        noteKeyNonce: "rotated_owner_nonce_abcdefghijklmnopqrstuvwxyz",
        contentCipher: "rotated_content_cipher_abcdefghijklmnopqrstuvwxyz",
        contentNonce: "rotated_content_nonce_abcdefghijklmnopqrstuvwxyz",
        contentLength: 777,
        version: 1,
        shares: [
          {
            recipientUserId: bobUserId,
            sharingKeyVersion: 2,
            encryptedNoteKey: "rotated_share_for_bob_abcdefghijklmnopqrstuvwxyz",
            formatVersion: 1
          }
        ],
        attachmentKeys: [
          {
            attachmentId: "00000000-0000-4000-8000-000000000001",
            encryptedAttachmentKey: "rotated_attachment_key_abcdefghijklmnopqrstuvwxyz",
            attachmentKeyNonce: "rotated_attachment_nonce_abcdefghijklmnopqrstuvwxyz"
          }
        ]
      })
      .expect(200);
    expect(rotated.body).toMatchObject({ id: noteId, version: 2 });

    const note = app.locals.db.sqlite
      .prepare(
        `SELECT encrypted_note_key AS encryptedNoteKey,
                note_key_nonce AS noteKeyNonce,
                content_cipher AS contentCipher,
                content_length AS contentLength,
                version
         FROM notes
         WHERE id = ?`
      )
      .get(noteId) as {
      contentCipher: string;
      contentLength: number;
      encryptedNoteKey: string;
      noteKeyNonce: string;
      version: number;
    };
    expect(note).toEqual({
      contentCipher: "rotated_content_cipher_abcdefghijklmnopqrstuvwxyz",
      contentLength: 777,
      encryptedNoteKey: "rotated_owner_note_key_abcdefghijklmnopqrstuvwxyz",
      noteKeyNonce: "rotated_owner_nonce_abcdefghijklmnopqrstuvwxyz",
      version: 2
    });
    const share = app.locals.db.sqlite
      .prepare(
        `SELECT encrypted_note_key AS encryptedNoteKey,
                sharing_key_version AS sharingKeyVersion
         FROM note_key_shares
         WHERE note_id = ? AND recipient_user_id = ?`
      )
      .get(noteId, bobUserId) as {
      encryptedNoteKey: string;
      sharingKeyVersion: number;
    };
    expect(share).toEqual({
      encryptedNoteKey: "rotated_share_for_bob_abcdefghijklmnopqrstuvwxyz",
      sharingKeyVersion: 2
    });
    const attachment = app.locals.db.sqlite
      .prepare(
        `SELECT encrypted_attachment_key AS encryptedAttachmentKey,
                attachment_key_nonce AS attachmentKeyNonce
         FROM attachments
         WHERE id = ?`
      )
      .get("00000000-0000-4000-8000-000000000001") as {
      attachmentKeyNonce: string;
      encryptedAttachmentKey: string;
    };
    expect(attachment).toEqual({
      attachmentKeyNonce: "rotated_attachment_nonce_abcdefghijklmnopqrstuvwxyz",
      encryptedAttachmentKey: "rotated_attachment_key_abcdefghijklmnopqrstuvwxyz"
    });
  });

  it("rolls back key rotations when event writes fail", async () => {
    const app = createTestApp();
    const alice = await registerAgent(app, "rollback_rotation_alice");
    const bob = await registerAgent(app, "rollback_rotation_bob");
    const bobSession = await bob.get("/api/auth/me").expect(200);
    const bobUserId = String(bobSession.body.id);

    await bob
      .put("/api/sharing-keys/current")
      .set(csrfHeaders())
      .send(sharingKeyPayload(2))
      .expect(201);
    const created = await alice
      .post("/api/notes")
      .set(csrfHeaders())
      .send(notePayload())
      .expect(201);
    const noteId = String(created.body.id);
    await alice
      .post(`/api/notes/${noteId}/memberships`)
      .set(csrfHeaders())
      .send({
        username: "rollback_rotation_bob",
        role: "editor",
        sharingKeyVersion: 2,
        encryptedNoteKey: "old_rotation_share_for_bob_abcdefghijklmnopqrstuvwxyz",
        formatVersion: 1
      })
      .expect(201);
    await alice
      .post(`/api/notes/${noteId}/attachments`)
      .set(csrfHeaders())
      .set({
        "content-type": "application/octet-stream",
        "x-fortnote-attachment-id": "00000000-0000-4000-8000-000000000002",
        "x-fortnote-filename": "rollback-rotate.txt",
        "x-fortnote-mime-type": "text/plain",
        "x-fortnote-size": "8",
        "x-fortnote-encrypted-attachment-key":
          "old_rotation_attachment_key_abcdefghijklmnopqrstuvwxyz",
        "x-fortnote-attachment-key-nonce":
          "old_rotation_attachment_nonce_abcdefghijklmnopqrstuvwxyz",
        "x-fortnote-file-nonce": "file_nonce_abcdefghijklmnopqrstuvwxyz"
      })
      .send(Buffer.from("ciphered"))
      .expect(201);

    failNoteEventWrites(app);

    await alice
      .post(`/api/notes/${noteId}/key-rotation`)
      .set(csrfHeaders())
      .send({
        encryptedNoteKey: "failed_rotation_owner_note_key_abcdefghijklmnopqrstuvwxyz",
        noteKeyNonce: "failed_rotation_owner_nonce_abcdefghijklmnopqrstuvwxyz",
        contentCipher: "failed_rotation_content_cipher_abcdefghijklmnopqrstuvwxyz",
        contentNonce: "failed_rotation_content_nonce_abcdefghijklmnopqrstuvwxyz",
        contentLength: 888,
        version: 1,
        shares: [
          {
            recipientUserId: bobUserId,
            sharingKeyVersion: 2,
            encryptedNoteKey: "failed_rotation_share_for_bob_abcdefghijklmnopqrstuvwxyz",
            formatVersion: 1
          }
        ],
        attachmentKeys: [
          {
            attachmentId: "00000000-0000-4000-8000-000000000002",
            encryptedAttachmentKey:
              "failed_rotation_attachment_key_abcdefghijklmnopqrstuvwxyz",
            attachmentKeyNonce: "failed_rotation_attachment_nonce_abcdefghijklmnopqrstuvwxyz"
          }
        ]
      })
      .expect(500);

    const note = app.locals.db.sqlite
      .prepare(
        `SELECT encrypted_note_key AS encryptedNoteKey,
                note_key_nonce AS noteKeyNonce,
                content_cipher AS contentCipher,
                content_length AS contentLength,
                version
         FROM notes
         WHERE id = ?`
      )
      .get(noteId);
    expect(note).toEqual({
      contentCipher: "content_cipher_abcdefghijklmnopqrstuvwxyz",
      contentLength: 128,
      encryptedNoteKey: "encrypted_note_key_abcdefghijklmnopqrstuvwxyz",
      noteKeyNonce: "note_key_nonce_abcdefghijklmnopqrstuvwxyz",
      version: 1
    });
    const share = app.locals.db.sqlite
      .prepare(
        `SELECT encrypted_note_key AS encryptedNoteKey,
                sharing_key_version AS sharingKeyVersion
         FROM note_key_shares
         WHERE note_id = ? AND recipient_user_id = ?`
      )
      .get(noteId, bobUserId);
    expect(share).toEqual({
      encryptedNoteKey: "old_rotation_share_for_bob_abcdefghijklmnopqrstuvwxyz",
      sharingKeyVersion: 2
    });
    const attachment = app.locals.db.sqlite
      .prepare(
        `SELECT encrypted_attachment_key AS encryptedAttachmentKey,
                attachment_key_nonce AS attachmentKeyNonce
         FROM attachments
         WHERE id = ?`
      )
      .get("00000000-0000-4000-8000-000000000002");
    expect(attachment).toEqual({
      attachmentKeyNonce: "old_rotation_attachment_nonce_abcdefghijklmnopqrstuvwxyz",
      encryptedAttachmentKey: "old_rotation_attachment_key_abcdefghijklmnopqrstuvwxyz"
    });
  });

  it("rejects partial key rotations", async () => {
    const app = createTestApp();
    const alice = await registerAgent(app, "partial_rotate_alice");
    const bob = await registerAgent(app, "partial_rotate_bob");

    await bob
      .put("/api/sharing-keys/current")
      .set(csrfHeaders())
      .send(sharingKeyPayload())
      .expect(201);
    const created = await alice
      .post("/api/notes")
      .set(csrfHeaders())
      .send(notePayload())
      .expect(201);
    const noteId = String(created.body.id);
    await alice
      .post(`/api/notes/${noteId}/memberships`)
      .set(csrfHeaders())
      .send({
        username: "partial_rotate_bob",
        role: "viewer",
        sharingKeyVersion: 1,
        encryptedNoteKey: "old_share_for_bob_abcdefghijklmnopqrstuvwxyz",
        formatVersion: 1
      })
      .expect(201);

    await alice
      .post(`/api/notes/${noteId}/key-rotation`)
      .set(csrfHeaders())
      .send({
        encryptedNoteKey: "rotated_owner_note_key_abcdefghijklmnopqrstuvwxyz",
        noteKeyNonce: "rotated_owner_nonce_abcdefghijklmnopqrstuvwxyz",
        contentCipher: "rotated_content_cipher_abcdefghijklmnopqrstuvwxyz",
        contentNonce: "rotated_content_nonce_abcdefghijklmnopqrstuvwxyz",
        contentLength: 777,
        version: 1,
        shares: [],
        attachmentKeys: []
      })
      .expect(400);
  });

  it("rolls back membership invites when event writes fail", async () => {
    const app = createTestApp();
    const alice = await registerAgent(app, "rollback_member_alice");
    const bob = await registerAgent(app, "rollback_member_bob");
    const bobSession = await bob.get("/api/auth/me").expect(200);
    const bobUserId = String(bobSession.body.id);

    await bob
      .put("/api/sharing-keys/current")
      .set(csrfHeaders())
      .send(sharingKeyPayload())
      .expect(201);

    const created = await alice
      .post("/api/notes")
      .set(csrfHeaders())
      .send(notePayload())
      .expect(201);
    const noteId = String(created.body.id);

    failNoteEventWrites(app);

    await alice
      .post(`/api/notes/${noteId}/memberships`)
      .set(csrfHeaders())
      .send({
        username: "rollback_member_bob",
        role: "editor",
        sharingKeyVersion: 1,
        encryptedNoteKey: "rollback_share_for_bob_abcdefghijklmnopqrstuvwxyz",
        formatVersion: 1
      })
      .expect(500);

    const membership = app.locals.db.sqlite
      .prepare(
        `SELECT role
         FROM note_memberships
         WHERE note_id = ? AND user_id = ?`
      )
      .get(noteId, bobUserId);
    expect(membership).toBeUndefined();

    const keyShare = app.locals.db.sqlite
      .prepare(
        `SELECT encrypted_note_key AS encryptedNoteKey
         FROM note_key_shares
         WHERE note_id = ? AND recipient_user_id = ?`
      )
      .get(noteId, bobUserId);
    expect(keyShare).toBeUndefined();
  });

  it("rolls back membership role updates when event writes fail", async () => {
    const app = createTestApp();
    const alice = await registerAgent(app, "rollback_role_alice");
    const bob = await registerAgent(app, "rollback_role_bob");
    const bobSession = await bob.get("/api/auth/me").expect(200);
    const bobUserId = String(bobSession.body.id);

    await bob
      .put("/api/sharing-keys/current")
      .set(csrfHeaders())
      .send(sharingKeyPayload())
      .expect(201);

    const created = await alice
      .post("/api/notes")
      .set(csrfHeaders())
      .send(notePayload())
      .expect(201);
    const noteId = String(created.body.id);

    await alice
      .post(`/api/notes/${noteId}/memberships`)
      .set(csrfHeaders())
      .send({
        username: "rollback_role_bob",
        role: "editor",
        sharingKeyVersion: 1,
        encryptedNoteKey: "rollback_role_share_for_bob_abcdefghijklmnopqrstuvwxyz",
        formatVersion: 1
      })
      .expect(201);

    failNoteEventWrites(app);

    await alice
      .patch(`/api/notes/${noteId}/memberships/${bobUserId}`)
      .set(csrfHeaders())
      .send({ role: "viewer" })
      .expect(500);

    const membership = app.locals.db.sqlite
      .prepare(
        `SELECT role, status
         FROM note_memberships
         WHERE note_id = ? AND user_id = ?`
      )
      .get(noteId, bobUserId);
    expect(membership).toEqual({ role: "editor", status: "active" });
  });

  it("rolls back membership revokes when event writes fail", async () => {
    const app = createTestApp();
    const alice = await registerAgent(app, "rollback_revoke_alice");
    const bob = await registerAgent(app, "rollback_revoke_bob");
    const bobSession = await bob.get("/api/auth/me").expect(200);
    const bobUserId = String(bobSession.body.id);

    await bob
      .put("/api/sharing-keys/current")
      .set(csrfHeaders())
      .send(sharingKeyPayload())
      .expect(201);

    const created = await alice
      .post("/api/notes")
      .set(csrfHeaders())
      .send(notePayload())
      .expect(201);
    const noteId = String(created.body.id);

    await alice
      .post(`/api/notes/${noteId}/memberships`)
      .set(csrfHeaders())
      .send({
        username: "rollback_revoke_bob",
        role: "editor",
        sharingKeyVersion: 1,
        encryptedNoteKey: "rollback_revoke_share_for_bob_abcdefghijklmnopqrstuvwxyz",
        formatVersion: 1
      })
      .expect(201);

    failNoteEventWrites(app);

    await alice
      .delete(`/api/notes/${noteId}/memberships/${bobUserId}`)
      .set(csrfHeaders())
      .expect(500);

    const membership = app.locals.db.sqlite
      .prepare(
        `SELECT role, status
         FROM note_memberships
         WHERE note_id = ? AND user_id = ?`
      )
      .get(noteId, bobUserId);
    expect(membership).toEqual({ role: "editor", status: "active" });
    const keyShare = app.locals.db.sqlite
      .prepare(
        `SELECT encrypted_note_key AS encryptedNoteKey
         FROM note_key_shares
         WHERE note_id = ? AND recipient_user_id = ?`
      )
      .get(noteId, bobUserId);
    expect(keyShare).toEqual({
      encryptedNoteKey: "rollback_revoke_share_for_bob_abcdefghijklmnopqrstuvwxyz"
    });
  });

  it("enforces one-level folder nesting", async () => {
    const app = createTestApp();
    const agent = await registerAgent(app, "folder_user");

    const parent = await agent
      .post("/api/folders")
      .set(csrfHeaders())
      .send({ name: "Parent" })
      .expect(201);

    const child = await agent
      .post("/api/folders")
      .set(csrfHeaders())
      .send({ name: "Child", parentFolderId: parent.body.id })
      .expect(201);

    await agent
      .post("/api/folders")
      .set(csrfHeaders())
      .send({ name: "Too deep", parentFolderId: child.body.id })
      .expect(400);
  });

  it("soft deletes, restores, and permanently deletes notes", async () => {
    const app = createTestApp();
    const agent = await registerAgent(app, "trash_user");
    const created = await agent
      .post("/api/notes")
      .set(csrfHeaders())
      .send(notePayload())
      .expect(201);

    await agent
      .delete(`/api/notes/${String(created.body.id)}`)
      .set(csrfHeaders())
      .expect(204);

    const deleted = await agent.get("/api/notes").query({ deleted: "true" }).expect(200);
    expect(deleted.body.notes).toHaveLength(1);

    await agent
      .post(`/api/notes/${String(created.body.id)}/restore`)
      .set(csrfHeaders())
      .expect(200);

    await agent
      .delete(`/api/notes/${String(created.body.id)}/permanent`)
      .set(csrfHeaders())
      .expect(204);

    await agent.get(`/api/notes/${String(created.body.id)}`).expect(404);

    const events = app.locals.db.sqlite
      .prepare(
        `SELECT event_type AS eventType,
                note_version AS noteVersion,
                payload_metadata AS payloadMetadata
         FROM note_events
         WHERE note_id = ?
         ORDER BY cursor`
      )
      .all(created.body.id) as {
      eventType: string;
      noteVersion: number;
      payloadMetadata: string | null;
    }[];
    expect(events.map((event) => event.eventType)).toEqual([
      "note.created",
      "note.deleted",
      "note.restored",
      "note.permanently_deleted"
    ]);
    expect(events.at(-1)?.noteVersion).toBe(1);
    expect(JSON.parse(events.at(-1)?.payloadMetadata ?? "{}")).toMatchObject({
      visibleUserIds: [expect.any(String)]
    });
  });
});

function seedCheckpointManifest(
  app: ReturnType<typeof createTestApp>,
  input: { noteId: string; sectionId: string; cryptoOwnerId: string }
): string {
  const sqlite = app.locals.db.sqlite;
  const uploadId = crypto.randomUUID();
  const updateId = crypto.randomUUID();
  const manifestId = crypto.randomUUID();
  sqlite.prepare(`
    INSERT INTO content_uploads (
      id, update_id, note_id, section_id, crypto_owner_id, key_epoch,
      kind, format_version, total_cipher_bytes, chunk_count, manifest_hash,
      status, expires_at
    ) VALUES (?, ?, ?, ?, ?, 1, 'checkpoint', 2, 6, 1, ?, 'committed', ?)
  `).run(
    uploadId,
    updateId,
    input.noteId,
    input.sectionId,
    input.cryptoOwnerId,
    `hash-${manifestId}`,
    "2099-01-01T00:00:00.000Z"
  );
  sqlite.prepare(`
    INSERT INTO content_manifests (
      id, upload_id, update_id, note_id, section_id, key_epoch, kind,
      format_version, first_sequence, last_sequence, total_cipher_bytes,
      chunk_count, manifest_hash
    ) VALUES (?, ?, ?, ?, ?, 1, 'checkpoint', 2, 1, 1, 6, 1, ?)
  `).run(
    manifestId,
    uploadId,
    updateId,
    input.noteId,
    input.sectionId,
    `hash-${manifestId}`
  );
  return manifestId;
}

function failNoteEventWrites(app: ReturnType<typeof createTestApp>): void {
  app.locals.db.sqlite.exec(`
    CREATE TRIGGER fail_note_events_insert
    BEFORE INSERT ON note_events
    BEGIN
      SELECT RAISE(ABORT, 'note event failure');
    END;
  `);
}
