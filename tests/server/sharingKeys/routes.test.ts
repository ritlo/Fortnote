import { describe, expect, it } from "vitest";
import {
  createTestApp,
  csrfHeaders,
  notePayload,
  registerAgent
} from "../support/http.js";
import { testSql } from "../support/database.js";

const sharingKeyPayload = buildSharingKeyPayload(1);

describe("sharing key routes", () => {
  it("stores and returns the signed-in user's current sharing key", async () => {
    const app = await createTestApp();
    const agent = await registerAgent(app, "sharing_owner");

    await agent.get("/api/sharing-keys/current").expect(404);

    const stored = await agent
      .put("/api/sharing-keys/current")
      .set(csrfHeaders())
      .send(sharingKeyPayload)
      .expect(201);
    expect(stored.body).toEqual({ sharingKeyVersion: 1 });

    const current = await agent.get("/api/sharing-keys/current").expect(200);
    expect(current.body).toMatchObject(sharingKeyPayload);

    await agent
      .put("/api/sharing-keys/current")
      .set(csrfHeaders())
      .send(sharingKeyPayload)
      .expect(409);
  });

  it("upgrades a private-key envelope without replacing its public identity", async () => {
    const app = await createTestApp();
    const agent = await registerAgent(app, "sharing_migration");
    const legacy = buildSharingKeyPayload(1);
    const upgraded = {
      ...legacy,
      encryptedPrivateKey: "protected_private_key_v2_abcdefghijklmnopqrstuvwxyz",
      privateKeyNonce: "protected_private_nonce_v2_abcdefghijklmnopqrstuvwxyz",
      formatVersion: 2
    };

    await agent
      .put("/api/sharing-keys/current")
      .set(csrfHeaders())
      .send(legacy)
      .expect(201);
    await agent
      .put("/api/sharing-keys/current")
      .set(csrfHeaders())
      .send(upgraded)
      .expect(200);

    const current = await agent.get("/api/sharing-keys/current").expect(200);
    expect(current.body).toMatchObject(upgraded);

    await agent
      .put("/api/sharing-keys/current")
      .set(csrfHeaders())
      .send({ ...upgraded, publicKey: `${upgraded.publicKey}_changed` })
      .expect(409);
  });

  it("looks up only another user's public sharing key", async () => {
    const app = await createTestApp();
    const alice = await registerAgent(app, "sharing_alice");
    const bob = await registerAgent(app, "sharing_bob");

    await alice
      .put("/api/sharing-keys/current")
      .set(csrfHeaders())
      .send(sharingKeyPayload)
      .expect(201);

    const lookup = await bob
      .get("/api/sharing-keys/lookup")
      .query({ username: "sharing_alice" })
      .expect(200);

    expect(lookup.body).toMatchObject({
      username: "sharing_alice",
      sharingKeyVersion: 1,
      publicKey: sharingKeyPayload.publicKey,
      formatVersion: 1
    });
    expect(lookup.body.userId).toEqual(expect.any(String));
    expect(lookup.body.encryptedPrivateKey).toBeUndefined();
    expect(lookup.body.privateKeyNonce).toBeUndefined();
  });

  it("requires a published sharing key for lookups", async () => {
    const app = await createTestApp();
    await registerAgent(app, "sharing_no_key");
    const viewer = await registerAgent(app, "sharing_viewer");

    await viewer
      .get("/api/sharing-keys/lookup")
      .query({ username: "sharing_no_key" })
      .expect(404);
  });

  it("cleans up retired sharing keys that no shares reference", async () => {
    const app = await createTestApp();
    const agent = await registerAgent(app, "cleanup_unused");
    const user = await agent.get("/api/auth/me").expect(200);

    await agent
      .put("/api/sharing-keys/current")
      .set(csrfHeaders())
      .send(buildSharingKeyPayload(1))
      .expect(201);
    await agent
      .put("/api/sharing-keys/current")
      .set(csrfHeaders())
      .send(buildSharingKeyPayload(2))
      .expect(201);

    const cleanup = await agent
      .post("/api/sharing-keys/cleanup")
      .set(csrfHeaders())
      .expect(200);

    expect(cleanup.body).toEqual({ deleted: 1 });
    expect(await sharingKeyVersions(app, String(user.body.id))).toEqual([2]);
  });

  it("keeps retired sharing keys that existing shares still reference", async () => {
    const app = await createTestApp();
    const owner = await registerAgent(app, "cleanup_owner");
    const recipient = await registerAgent(app, "cleanup_recipient");
    const recipientUser = await recipient.get("/api/auth/me").expect(200);

    await recipient
      .put("/api/sharing-keys/current")
      .set(csrfHeaders())
      .send(buildSharingKeyPayload(1))
      .expect(201);
    await recipient
      .put("/api/sharing-keys/current")
      .set(csrfHeaders())
      .send(buildSharingKeyPayload(2))
      .expect(201);

    const note = await owner
      .post("/api/notes")
      .set(csrfHeaders())
      .send(notePayload())
      .expect(201);
    await owner
      .post(`/api/notes/${String(note.body.id)}/memberships`)
      .set(csrfHeaders())
      .send({
        username: "cleanup_recipient",
        role: "viewer",
        sharingKeyVersion: 1,
        encryptedNoteKey: "encrypted_share_for_cleanup_abcdefghijklmnopqrstuvwxyz",
        formatVersion: 1
      })
      .expect(201);

    const cleanup = await recipient
      .post("/api/sharing-keys/cleanup")
      .set(csrfHeaders())
      .expect(200);

    expect(cleanup.body).toEqual({ deleted: 0 });
    expect(await sharingKeyVersions(app, String(recipientUser.body.id))).toEqual([1, 2]);
  });
});

function buildSharingKeyPayload(version: number) {
  return {
    sharingKeyVersion: version,
    publicKey: `public_sharing_key_${String(version)}_abcdefghijklmnopqrstuvwxyz`,
    encryptedPrivateKey: `encrypted_private_key_${String(version)}_abcdefghijklmnopqrstuvwxyz`,
    privateKeyNonce: `private_key_nonce_${String(version)}_abcdefghijklmnopqrstuvwxyz`,
    formatVersion: 1
  };
}

async function sharingKeyVersions(
  app: Awaited<ReturnType<typeof createTestApp>>,
  userId: string
): Promise<number[]> {
  const rows = await testSql(app.locals.db).all<{ sharingKeyVersion: number }>(
    `SELECT sharing_key_version AS sharingKeyVersion
       FROM user_sharing_keys
       WHERE user_id = ?
       ORDER BY sharing_key_version`,
    userId
  );

  return rows.map((row) => row.sharingKeyVersion);
}
