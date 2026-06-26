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

  it("returns generic KDF parameters for unknown users", async () => {
    const app = createTestApp();

    const response = await request(app)
      .get("/api/auth/kdf-params")
      .query({ username: "missing_user" })
      .expect(200);

    expect(response.body).toMatchObject({
      authKdfVersion: 1,
      vaultKdfVersion: 1
    });
  });

  it("returns recovery parameters for registered users", async () => {
    const app = createTestApp();

    await request(app)
      .post("/api/auth/register")
      .set(csrfHeaders())
      .send(registerPayload("recovery_params_user"))
      .expect(201);

    const response = await request(app)
      .get("/api/auth/recovery-params")
      .query({ username: "recovery_params_user" })
      .expect(200);

    expect(response.body).toMatchObject({
      recoveryKdfVersion: 1,
      keyMaterialVersion: 1
    });
    expect(response.body.recoveryEncryptedRootKey).toContain(
      "recovery_encrypted_root_key"
    );
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

  it("rate limits repeated login attempts", async () => {
    const app = createTestApp();

    for (let index = 0; index < 20; index += 1) {
      await request(app)
        .post("/api/auth/login")
        .set(csrfHeaders())
        .send({
          username: "missing",
          authVerifier: "wrong_verifier_value_abcdefghijklmnopqrstuvwxyz"
        })
        .expect(401);
    }

    await request(app)
      .post("/api/auth/login")
      .set(csrfHeaders())
      .send({
        username: "missing",
        authVerifier: "wrong_verifier_value_abcdefghijklmnopqrstuvwxyz"
      })
      .expect(429);
  });
});
