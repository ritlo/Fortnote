import request from "supertest";
import { createDb } from "../db/client.js";
import { createApp } from "../http/app.js";

export function createTestApp() {
  const config = {
    port: 0,
    databasePath: ":memory:",
    dataDir: "data/attachments",
    cookieSecure: false,
    allowedOrigin: "http://localhost:5173"
  };
  return createApp({ config, db: createDb(config) });
}

export function csrfHeaders() {
  return {
    origin: "http://localhost:5173",
    "sec-fetch-site": "same-origin"
  };
}

export function registerPayload(username = "alice") {
  return {
    username,
    authVerifier: `auth_verifier_value_${username}_abcdefghijklmnopqrstuvwxyz`,
    authKdf: {
      salt: `auth_salt_${username}_abcdefghijklmnopqrstuvwxyz`,
      opsLimit: 4,
      memLimit: 67108864,
      version: 1
    },
    vaultKdf: {
      salt: `vault_salt_${username}_abcdefghijklmnopqrstuvwxyz`,
      opsLimit: 4,
      memLimit: 67108864,
      version: 1
    },
    encryptedRootKey: `encrypted_root_key_${username}_abcdefghijklmnopqrstuvwxyz`,
    rootKeyNonce: `root_key_nonce_${username}_abcdefghijklmnopqrstuvwxyz`,
    recoveryAuthVerifier: `recovery_auth_verifier_${username}_abcdefghijklmnopqrstuvwxyz`,
    recoveryKdf: {
      salt: `recovery_salt_${username}_abcdefghijklmnopqrstuvwxyz`,
      opsLimit: 4,
      memLimit: 67108864,
      version: 1
    },
    recoveryEncryptedRootKey: `recovery_encrypted_root_key_${username}_abcdefghijklmnopqrstuvwxyz`,
    recoveryRootKeyNonce: `recovery_root_nonce_${username}_abcdefghijklmnopqrstuvwxyz`
  };
}

export async function registerAgent(app: ReturnType<typeof createApp>, username: string) {
  const agent = request.agent(app);
  await agent
    .post("/api/auth/register")
    .set(csrfHeaders())
    .send(registerPayload(username))
    .expect(201);
  return agent;
}

export function notePayload(folderId: string | null = null) {
  return {
    id: crypto.randomUUID(),
    folderId,
    title: "Encrypted note",
    encryptedNoteKey: "encrypted_note_key_abcdefghijklmnopqrstuvwxyz",
    noteKeyNonce: "note_key_nonce_abcdefghijklmnopqrstuvwxyz",
    contentCipher: "content_cipher_abcdefghijklmnopqrstuvwxyz",
    contentNonce: "content_nonce_abcdefghijklmnopqrstuvwxyz",
    contentLength: 128
  };
}
