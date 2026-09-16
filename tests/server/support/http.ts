import request from "supertest";
import { getConfig } from "@server/config.js";
import { createApplicationDatabase } from "@server/db/client.js";
import { createApp } from "@server/http/app.js";
import type { ServerConfig } from "@server/config.js";
import type { RealtimePublisher } from "@server/realtime/types.js";
import { createTestDatabaseConfig, trackTestDatabase } from "./database.js";

/** Builds an app on a fresh test database that is dropped when the test finishes. */
export async function createTestApp(
  overrides: Partial<ServerConfig> = {},
  realtime?: RealtimePublisher
) {
  const testDatabase = await createTestDatabaseConfig();
  const config: ServerConfig = {
    ...getConfig({ DATABASE_URL: testDatabase.database.url }),
    port: 0,
    host: "127.0.0.1",
    database: testDatabase.database,
    cookieSecure: false,
    allowedOrigin: "http://localhost:5173",
    ...overrides
  };
  const db = trackTestDatabase(await createApplicationDatabase(config), testDatabase);
  const app = createApp({ config, db, ...(realtime ? { realtime } : {}) });
  app.locals.db = db;
  app.locals.config = config;
  return app;
}

export function csrfHeaders() {
  return {
    origin: "http://localhost:5173",
    "sec-fetch-site": "same-origin"
  };
}

export function registerPayload(username = "alice") {
  return {
    id: crypto.randomUUID(),
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
    rootKeyFormatVersion: 2,
    recoveryAuthVerifier: `recovery_auth_verifier_${username}_abcdefghijklmnopqrstuvwxyz`,
    recoveryKdf: {
      salt: `recovery_salt_${username}_abcdefghijklmnopqrstuvwxyz`,
      opsLimit: 4,
      memLimit: 67108864,
      version: 1
    },
    recoveryEncryptedRootKey: `recovery_encrypted_root_key_${username}_abcdefghijklmnopqrstuvwxyz`,
    recoveryRootKeyNonce: `recovery_root_nonce_${username}_abcdefghijklmnopqrstuvwxyz`,
    recoveryRootKeyFormatVersion: 2
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
    rootSectionId: crypto.randomUUID(),
    titleCipher: "encrypted_title_cipher_abcdefghijklmnopqrstuvwxyz",
    titleNonce: "encrypted_title_nonce_abcdefghijklmnopqrstuvwxyz",
    titleFormatVersion: 2,
    encryptedNoteKey: "encrypted_note_key_abcdefghijklmnopqrstuvwxyz",
    noteKeyNonce: "note_key_nonce_abcdefghijklmnopqrstuvwxyz",
    noteKeyFormatVersion: 2
  };
}

export function folderPayload(parentFolderId?: string | null) {
  return {
    nameCipher: "encrypted_folder_name_abcdefghijklmnopqrstuvwxyz",
    nameNonce: "encrypted_folder_nonce_abcdefghijklmnopqrstuvwxyz",
    nameFormatVersion: 2,
    ...(parentFolderId === undefined ? {} : { parentFolderId })
  };
}

export function noteMetadataUpdate(rootVersion: number, label = "updated") {
  return {
    titleCipher: `${label}_title_cipher_abcdefghijklmnopqrstuvwxyz`,
    titleNonce: `${label}_title_nonce_abcdefghijklmnopqrstuvwxyz`,
    titleFormatVersion: 2,
    rootVersion,
    keyEpoch: 1
  };
}
