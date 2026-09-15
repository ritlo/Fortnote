import { describe, expect, it } from "vitest";
import { canonicalTimestamp, withCanonicalTimestamps } from "@server/db/timestamps.js";

describe("canonical timestamps", () => {
  it.each([
    ["2026-09-14 17:01:53", "2026-09-14T17:01:53.000Z"],
    ["2026-09-14 17:01:53.344647+00", "2026-09-14T17:01:53.344Z"],
    ["2026-09-14 19:01:53.344647+02", "2026-09-14T17:01:53.344Z"],
    ["2026-09-14 11:31:53.344647-05:30", "2026-09-14T17:01:53.344Z"],
    ["2026-09-14T17:01:53.344Z", "2026-09-14T17:01:53.344Z"]
  ])("serializes %s as canonical UTC", (stored, expected) => {
    expect(canonicalTimestamp(stored)).toBe(expected);
  });

  it("serializes Date values", () => {
    expect(canonicalTimestamp(new Date("2026-09-14T17:01:53.344Z"))).toBe(
      "2026-09-14T17:01:53.344Z"
    );
  });

  it("normalizes timestamp fields only and keeps nulls", () => {
    expect(withCanonicalTimestamps({
      id: "note",
      title: "2026-09-14 17:01:53",
      createdAt: "2026-09-14 17:01:53",
      updatedAt: "2026-09-14 19:01:53.5+02",
      deletedAt: null,
      expiresAt: new Date("2026-09-15T00:00:00.000Z")
    })).toEqual({
      id: "note",
      title: "2026-09-14 17:01:53",
      createdAt: "2026-09-14T17:01:53.000Z",
      updatedAt: "2026-09-14T17:01:53.500Z",
      deletedAt: null,
      expiresAt: "2026-09-15T00:00:00.000Z"
    });
  });
});
