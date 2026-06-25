import request from "supertest";
import { describe, expect, it } from "vitest";
import { createTestApp, csrfHeaders, registerPayload } from "../test/http.js";

describe("auth routes", () => {
  it("registers, creates a session, and returns me", async () => {
    const app = createTestApp();
    const agent = request.agent(app);

    const register = await agent
      .post("/api/auth/register")
      .set(csrfHeaders())
      .send(registerPayload())
      .expect(201);

    expect(register.body).toMatchObject({ username: "alice" });

    const me = await agent.get("/api/auth/me").expect(200);
    expect(me.body).toMatchObject({ username: "alice" });
  });

  it("returns KDF parameters for registered users", async () => {
    const app = createTestApp();

    await request(app)
      .post("/api/auth/register")
      .set(csrfHeaders())
      .send(registerPayload("bob"))
      .expect(201);

    const response = await request(app)
      .get("/api/auth/kdf-params")
      .query({ username: "bob" })
      .expect(200);

    expect(response.body).toMatchObject({
      authKdfVersion: 1,
      vaultKdfVersion: 1
    });
  });

  it("rejects invalid login verifier", async () => {
    const app = createTestApp();

    await request(app)
      .post("/api/auth/register")
      .set(csrfHeaders())
      .send(registerPayload("cara"))
      .expect(201);

    await request(app)
      .post("/api/auth/login")
      .set(csrfHeaders())
      .send({
        username: "cara",
        authVerifier: "wrong_verifier_value_abcdefghijklmnopqrstuvwxyz"
      })
      .expect(401);
  });

  it("resets account password with recovery verifier", async () => {
    const app = createTestApp();
    const agent = request.agent(app);

    await agent
      .post("/api/auth/register")
      .set(csrfHeaders())
      .send(registerPayload("dina"))
      .expect(201);

    await agent
      .post("/api/auth/recover")
      .set(csrfHeaders())
      .send({
        username: "dina",
        recoveryAuthVerifier:
          "recovery_auth_verifier_dina_abcdefghijklmnopqrstuvwxyz",
        newAuthVerifier: "new_auth_verifier_abcdefghijklmnopqrstuvwxyz",
        authKdf: {
          salt: "new_auth_salt_abcdefghijklmnopqrstuvwxyz",
          opsLimit: 4,
          memLimit: 67108864,
          version: 1
        },
        vaultKdf: {
          salt: "new_vault_salt_abcdefghijklmnopqrstuvwxyz",
          opsLimit: 4,
          memLimit: 67108864,
          version: 1
        },
        encryptedRootKey: "new_encrypted_root_key_abcdefghijklmnopqrstuvwxyz",
        rootKeyNonce: "new_root_key_nonce_abcdefghijklmnopqrstuvwxyz",
        keyMaterialVersion: 1
      })
      .expect(200);

    await request(app)
      .post("/api/auth/login")
      .set(csrfHeaders())
      .send({
        username: "dina",
        authVerifier: "new_auth_verifier_abcdefghijklmnopqrstuvwxyz"
      })
      .expect(200);
  });

  it("logs out and invalidates the session", async () => {
    const app = createTestApp();
    const agent = request.agent(app);

    await agent
      .post("/api/auth/register")
      .set(csrfHeaders())
      .send(registerPayload("erin"))
      .expect(201);

    await agent.post("/api/auth/logout").set(csrfHeaders()).expect(204);
    await agent.get("/api/auth/me").expect(401);
  });
});
