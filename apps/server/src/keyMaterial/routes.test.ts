import request from "supertest";
import { describe, expect, it } from "vitest";
import { createTestApp, csrfHeaders, registerAgent } from "../test/http.js";

describe("key material routes", () => {
  it("returns encrypted key material for current user", async () => {
    const app = createTestApp();
    const agent = await registerAgent(app, "key_user");

    const response = await agent.get("/api/key-material").expect(200);

    expect(response.body).toMatchObject({
      encryptedRootKey: "encrypted_root_key_key_user_abcdefghijklmnopqrstuvwxyz",
      keyMaterialVersion: 1
    });
  });

  it("updates encrypted vault envelope with optimistic concurrency", async () => {
    const app = createTestApp();
    const agent = await registerAgent(app, "rewrap_user");

    const updated = await agent
      .put("/api/key-material")
      .set(csrfHeaders())
      .send({
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

    expect(updated.body).toEqual({ keyMaterialVersion: 2 });

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

  it("requires authentication", async () => {
    const app = createTestApp();

    await request(app).get("/api/key-material").expect(401);
  });
});
