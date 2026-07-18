import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { getConfig, type ServerConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { createApp } from "../http/app.js";
import { csrfHeaders, registerPayload } from "./http.js";

export function safeAssuranceCanary(label: string): string {
  return `fortnote-assurance-${label}-${crypto.randomUUID()}`;
}

export function createAssuranceServerFixture(overrides: Partial<ServerConfig> = {}) {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "fortnote-assurance-"));
  const config: ServerConfig = {
    ...getConfig({}),
    port: 0,
    host: "127.0.0.1",
    databasePath: path.join(fixtureDir, "assurance.sqlite"),
    dataDir: path.join(fixtureDir, "ciphertext"),
    cookieSecure: false,
    allowedOrigin: "http://localhost:5173",
    ...overrides
  };
  const db = createDb(config);
  const app = createApp({ config, db });

  return {
    app,
    config,
    db,
    async register(username: string) {
      const agent = request.agent(app);
      await agent
        .post("/api/auth/register")
        .set(csrfHeaders())
        .send(registerPayload(username))
        .expect(201);
      return agent;
    },
    cleanup() {
      db.sqlite.close();
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  };
}
