import { describe, expect, it } from "vitest";
import { csrfGuard } from "./csrf.js";

function createResponse() {
  return {
    statusCode: 200,
    payload: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.payload = payload;
      return this;
    }
  };
}

describe("csrfGuard", () => {
  it("allows safe methods", () => {
    const guard = csrfGuard("http://localhost:5173");
    const request = {
      method: "GET",
      get: () => undefined
    };
    const response = createResponse();
    let called = false;

    guard(request as never, response as never, () => {
      called = true;
    });

    expect(called).toBe(true);
    expect(response.statusCode).toBe(200);
  });

  it("rejects mutating requests without expected origin", () => {
    const guard = csrfGuard("http://localhost:5173");
    const request = {
      method: "POST",
      get: (name: string) => (name === "origin" ? "http://evil.test" : "cross-site")
    };
    const response = createResponse();

    guard(request as never, response as never, () => undefined);

    expect(response.statusCode).toBe(403);
    expect(response.payload).toEqual({
      code: "csrf_failed",
      message: "CSRF validation failed"
    });
  });

  it("allows mutating requests with expected origin", () => {
    const guard = csrfGuard("http://localhost:5173");
    const request = {
      method: "POST",
      get: (name: string) => {
        if (name === "origin") {
          return "http://localhost:5173";
        }
        if (name === "sec-fetch-site") {
          return "same-origin";
        }
        return undefined;
      }
    };
    const response = createResponse();
    let called = false;

    guard(request as never, response as never, () => {
      called = true;
    });

    expect(called).toBe(true);
    expect(response.statusCode).toBe(200);
  });
});
