import request from "supertest";
import { describe, expect, it } from "vitest";
import { createTestApp, csrfHeaders, registerAgent } from "../support/http.js";

describe("key material routes", () => {
  it("returns encrypted key material for current user", async () => {
    const app = await createTestApp();
    const agent = await registerAgent(app, "key_user");

    const response = await agent.get("/api/key-material").expect(200);

    expect(response.body).toMatchObject({
      encryptedRootKey: "encrypted_root_key_key_user_abcdefghijklmnopqrstuvwxyz",
      rootKeyFormatVersion: 1,
      rootKeyContextVersion: 1,
      recoveryRootKeyFormatVersion: 1,
      recoveryRootKeyContextVersion: 1,
      keyMaterialVersion: 1
    });
  });

  it("updates encrypted vault envelope with optimistic concurrency", async () => {
    const app = await createTestApp();
    const agent = await registerAgent(app, "rewrap_user");

    const updated = await agent
      .put("/api/key-material")
      .set(csrfHeaders())
      .send({
        encryptedRootKey: "new_encrypted_root_key_abcdefghijklmnopqrstuvwxyz",
        rootKeyNonce: "new_root_key_nonce_abcdefghijklmnopqrstuvwxyz",
        rootKeyFormatVersion: 2,
        rootKeyContextVersion: 2,
        vaultKdf: {
          salt: "new_vault_salt_abcdefghijklmnopqrstuvwxyz",
          opsLimit: 4,
          memLimit: 67108864,
          version: 1
        },
        keyMaterialVersion: 1
      })
      .expect(200);

    expect(updated.body).toEqual({ keyMaterialVersion: 2 });
    await expect(agent.get("/api/key-material")).resolves.toMatchObject({
      body: expect.objectContaining({
        rootKeyFormatVersion: 2,
        rootKeyContextVersion: 2
      })
    });

    await agent
      .put("/api/key-material")
      .set(csrfHeaders())
      .send({
        encryptedRootKey: "stale_encrypted_root_key_abcdefghijklmnopqrstuvwxyz",
        rootKeyNonce: "stale_root_key_nonce_abcdefghijklmnopqrstuvwxyz",
        vaultKdf: {
          salt: "stale_vault_salt_abcdefghijklmnopqrstuvwxyz",
          opsLimit: 4,
          memLimit: 67108864,
          version: 1
        },
        keyMaterialVersion: 1
      })
      .expect(409);
  });

  it("updates account auth verifier with vault envelope", async () => {
    const app = await createTestApp();
    const agent = await registerAgent(app, "password_user");

    await agent
      .put("/api/key-material")
      .set(csrfHeaders())
      .send({
        newAuthVerifier: "new_auth_verifier_password_user_abcdefghijklmnopqrstuvwxyz",
        authKdf: {
          salt: "new_auth_salt_password_user_abcdefghijklmnopqrstuvwxyz",
          opsLimit: 4,
          memLimit: 67108864,
          version: 1
        },
        encryptedRootKey: "new_encrypted_root_key_abcdefghijklmnopqrstuvwxyz",
        rootKeyNonce: "new_root_key_nonce_abcdefghijklmnopqrstuvwxyz",
        vaultKdf: {
          salt: "new_vault_salt_abcdefghijklmnopqrstuvwxyz",
          opsLimit: 4,
          memLimit: 67108864,
          version: 1
        },
        keyMaterialVersion: 1
      })
      .expect(200);

    await agent.post("/api/auth/logout").set(csrfHeaders()).expect(204);

    await request(app)
      .post("/api/auth/login")
      .set(csrfHeaders())
      .send({
        username: "password_user",
        authVerifier: "auth_verifier_password_user_abcdefghijklmnopqrstuvwxyz"
      })
      .expect(401);

    await request(app)
      .post("/api/auth/login")
      .set(csrfHeaders())
      .send({
        username: "password_user",
        authVerifier: "new_auth_verifier_password_user_abcdefghijklmnopqrstuvwxyz"
      })
      .expect(200);
  });

  it("requires authentication", async () => {
    const app = await createTestApp();

    await request(app).get("/api/key-material").expect(401);
  });
});
