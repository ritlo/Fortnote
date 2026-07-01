import { describe, expect, it } from "vitest";
import { createTestApp, csrfHeaders, registerAgent } from "../test/http.js";

const sharingKeyPayload = {
  sharingKeyVersion: 1,
  publicKey: "public_sharing_key_abcdefghijklmnopqrstuvwxyz",
  encryptedPrivateKey: "encrypted_private_key_abcdefghijklmnopqrstuvwxyz",
  privateKeyNonce: "private_key_nonce_abcdefghijklmnopqrstuvwxyz",
  formatVersion: 1
};

describe("sharing key routes", () => {
  it("stores and returns the signed-in user's current sharing key", async () => {
    const app = createTestApp();
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

  it("looks up only another user's public sharing key", async () => {
    const app = createTestApp();
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
    const app = createTestApp();
    await registerAgent(app, "sharing_no_key");
    const viewer = await registerAgent(app, "sharing_viewer");

    await viewer
      .get("/api/sharing-keys/lookup")
      .query({ username: "sharing_no_key" })
      .expect(404);
  });
});
