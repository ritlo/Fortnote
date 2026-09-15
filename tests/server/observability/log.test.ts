import { describe, expect, it, vi } from "vitest";
import { createOperationalLogRecord, logError } from "@server/observability/log.js";

describe("operational logging", () => {
  it("creates one-line structured records", () => {
    expect(
      createOperationalLogRecord(
        "info",
        "server.started",
        { port: 3001, provider: "postgres" },
        new Date("2026-09-03T00:00:00.000Z")
      )
    ).toEqual({
      event: "server.started",
      level: "info",
      port: 3001,
      provider: "postgres",
      timestamp: "2026-09-03T00:00:00.000Z"
    });
  });

  it("classifies failures without logging error messages", () => {
    const secret = "postgresql://user:secret@database/fortnote";
    const error = Object.assign(new Error(secret), { code: "ECONNREFUSED" });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    logError("database.connection.failed", { provider: "postgres" }, error);

    const output = String(consoleError.mock.calls[0]?.[0]);
    expect(JSON.parse(output)).toMatchObject({
      errorCode: "ECONNREFUSED",
      errorName: "Error",
      event: "database.connection.failed",
      level: "error",
      provider: "postgres"
    });
    expect(output).not.toContain(secret);
    consoleError.mockRestore();
  });

  it("omits untrusted error codes", () => {
    const secret = "postgresql://user:secret@database/fortnote";
    const error = Object.assign(new Error("failed"), { code: secret });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    logError("database.connection.failed", {}, error);

    expect(String(consoleError.mock.calls[0]?.[0])).not.toContain(secret);
    consoleError.mockRestore();
  });
});
