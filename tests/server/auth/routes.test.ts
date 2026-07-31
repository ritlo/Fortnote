import request from "supertest";
import { describe, expect, it } from "vitest";
import { createTestApp, csrfHeaders, registerPayload } from "../support/http.js";

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

  it("uses one canonical handle for registration, login, and sharing lookup", async () => {
    const app = createTestApp();
    const owner = request.agent(app);
    const ownerRegistration = await owner
      .post("/api/auth/register")
      .set(csrfHeaders())
      .send(registerPayload("  Alice.Example  "))
      .expect(201)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          username: "alice.example",
          canonicalHandle: "alice.example",
          displayName: "Alice.Example",
          handleState: "active"
        });
      });
    await owner
      .put("/api/sharing-keys/current")
      .set(csrfHeaders())
      .send({
        sharingKeyVersion: 1,
        publicKey: "public_key_abcdefghijklmnopqrstuvwxyz0123456789",
        encryptedPrivateKey: "encrypted_private_key_abcdefghijklmnopqrstuvwxyz",
        privateKeyNonce: "private_key_nonce_abcdefghijklmnopqrstuvwxyz",
        formatVersion: 2
      })
      .expect(201);

    await request(app)
      .post("/api/auth/register")
      .set(csrfHeaders())
      .send(registerPayload("ALICE.EXAMPLE"))
      .expect(409);

    const collaborator = await request(app)
      .post("/api/auth/register")
      .set(csrfHeaders())
      .send(registerPayload("collaborator"))
      .expect(201);
    const collaboratorAgent = request.agent(app);
    await collaboratorAgent
      .post("/api/auth/login")
      .set(csrfHeaders())
      .send({
        username: " COLLABORATOR ",
        authVerifier: registerPayload("collaborator").authVerifier
      })
      .expect(200);
    await collaboratorAgent
      .get("/api/sharing-keys/lookup")
      .query({ username: " ALICE.EXAMPLE " })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          userId: ownerRegistration.body.id,
          username: "alice.example"
        });
      });
    const invalidLookup = await collaboratorAgent
      .get("/api/sharing-keys/lookup")
      .query({ username: "invalid handle" })
      .expect(404);
    const missingLookup = await collaboratorAgent
      .get("/api/sharing-keys/lookup")
      .query({ username: "missing.handle" })
      .expect(404);
    expect(invalidLookup.body.error).toMatchObject({
      code: missingLookup.body.error.code,
      message: missingLookup.body.error.message
    });
    expect(collaborator.body.canonicalHandle).toBe("collaborator");
  });

  it("keeps colliding legacy identities exact until handle repair", async () => {
    const app = createTestApp();
    const first = request.agent(app);
    const second = request.agent(app);
    await first
      .post("/api/auth/register")
      .set(csrfHeaders())
      .send(registerPayload("legacy_one"))
      .expect(201);
    await second
      .post("/api/auth/register")
      .set(csrfHeaders())
      .send(registerPayload("legacy_two"))
      .expect(201);
    app.locals.db.sqlite
      .prepare(
        "UPDATE users SET username = ?, display_name = ?, canonical_handle = NULL, handle_state = 'repair-required' WHERE username = ?"
      )
      .run(" Legacy Name ", "Legacy Name", "legacy_one");
    app.locals.db.sqlite
      .prepare(
        "UPDATE users SET username = ?, display_name = ?, canonical_handle = NULL, handle_state = 'repair-required' WHERE username = ?"
      )
      .run("legacy name", "legacy name", "legacy_two");

    await first.get("/api/auth/me").expect(200).expect(({ body }) => {
      expect(body).toMatchObject({
        username: " Legacy Name ",
        canonicalHandle: null,
        handleState: "repair-required"
      });
    });
    await second
      .put("/api/auth/handle")
      .set(csrfHeaders())
      .send({ handle: "repaired.handle" })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          canonicalHandle: "repaired.handle",
          username: "repaired.handle",
          handleState: "active"
        });
      });
  });

  it("uses the configured absolute session lifetime", async () => {
    const app = createTestApp({ sessionAbsoluteTimeoutMs: 2_000 });
    const before = Date.now();
    await request(app)
      .post("/api/auth/register")
      .set(csrfHeaders())
      .send(registerPayload("short_session"))
      .expect(201);

    const session = app.locals.db.sqlite
      .prepare("SELECT absolute_expires_at AS absoluteExpiresAt FROM sessions")
      .get() as { absoluteExpiresAt: string };
    expect(Date.parse(session.absoluteExpiresAt)).toBeGreaterThanOrEqual(before + 1_900);
    expect(Date.parse(session.absoluteExpiresAt)).toBeLessThanOrEqual(Date.now() + 2_100);
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
