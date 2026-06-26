import request from "supertest";
import { describe, expect, it } from "vitest";
import { createTestApp } from "../test/http.js";

describe("createApp", () => {
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
});
