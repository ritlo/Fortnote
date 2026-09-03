import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createTestApp, csrfHeaders, registerAgent } from "../support/http.js";
import { createOperationalErrorRecord, logOperationalError } from "@server/http/errors.js";

describe("createApp", () => {
  it("reports process liveness and database readiness separately", async () => {
    const app = createTestApp();

    await request(app).get("/api/health").expect(200).expect({ ok: true });
    await request(app)
      .get("/api/ready")
      .expect(200)
      .expect({ ok: true, checks: { database: "up" } });

    app.locals.db.sqlite.close();
    await request(app).get("/api/health").expect(200).expect({ ok: true });
    await request(app)
      .get("/api/ready")
      .expect(503)
      .expect({ ok: false, checks: { database: "down" } });
  });

  it("serves static assets and SPA routes from the configured web root", async () => {
    const webRoot = await mkdtemp(join(tmpdir(), "fortnote-web-root-"));
    try {
      await Promise.all([
        writeFile(join(webRoot, "index.html"), "<!doctype html><title>Fortnote web</title>"),
        writeFile(join(webRoot, "asset.txt"), "encrypted client asset")
      ]);
      const app = createTestApp({ webRoot });

      await request(app).get("/").expect(200).expect(/Fortnote web/u);
      await request(app).get("/notes/example").expect(200).expect(/Fortnote web/u);
      await request(app).get("/asset.txt").expect(200).expect("encrypted client asset");
      await request(app).get("/api/missing").expect(404).expect(({ text }) => {
        expect(text).not.toContain("Fortnote web");
      });
    } finally {
      await rm(webRoot, { recursive: true, force: true });
    }
  });

  it("sets a strict content security policy", async () => {
    const app = createTestApp();

    const response = await request(app).get("/api/health").expect(200);
    const csp = response.headers["content-security-policy"]!;

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("'unsafe-inline'");
  });

  it("marks authenticated API responses no-store and returns correlation IDs", async () => {
    const app = createTestApp();
    const agent = await registerAgent(app, "no-store-user");

    const response = await agent.get("/api/auth/me").expect(200);

    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    );
  });

  it("uses the safe nested error envelope for auth and parser failures", async () => {
    const app = createTestApp();
    const unauthorized = await request(app).get("/api/key-material").expect(401);
    expect(unauthorized.headers["cache-control"]).toBe("no-store");
    expect(unauthorized.body).toEqual({
      error: {
        code: "unauthorized",
        message: "Not signed in",
        requestId: unauthorized.headers["x-request-id"]
      }
    });

    const oversized = await request(app)
      .post("/api/auth/login")
      .set(csrfHeaders())
      .set("content-type", "application/json")
      .send(JSON.stringify({ username: "x".repeat(1024 * 1024), authVerifier: "value" }))
      .expect(413);
    expect(oversized.body).toEqual({
      error: {
        code: "payload_too_large",
        message: "Payload too large",
        requestId: oversized.headers["x-request-id"]
      }
    });
  });

  it("logs only allow-listed operational fields", () => {
    const requestId = crypto.randomUUID();
    const secret = "private-note-cipher-key-token-fingerprint";
    const record = createOperationalErrorRecord({
      boundary: "http",
      code: "internal_error",
      durationMs: 12.8,
      error: new Error(secret),
      method: "POST",
      requestId,
      status: 500
    });
    expect(record).toEqual({
      boundary: "http",
      code: "internal_error",
      durationMs: 13,
      method: "POST",
      requestId,
      status: 500
    });
    expect(JSON.stringify(record)).not.toContain(secret);

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logOperationalError({
      boundary: "http",
      code: "internal_error",
      durationMs: 12.8,
      error: new Error(secret),
      method: "POST",
      requestId,
      status: 500
    });
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(secret);
    consoleError.mockRestore();
  });
});
