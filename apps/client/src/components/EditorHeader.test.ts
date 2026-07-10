import { describe, expect, it } from "vitest";
import type { PresenceUser } from "../api";
import { formatPresenceSummary } from "./EditorHeader";

describe("EditorHeader presence summary", () => {
  it("formats active collaborator states", () => {
    expect(
      formatPresenceSummary([
        presence({ username: "bob", state: "editing" }),
        presence({ username: "carol", state: "idle" })
      ])
    ).toBe("bob editing, carol idle");
  });

  it("returns an empty summary without collaborators", () => {
    expect(formatPresenceSummary([])).toBe("");
  });
});

function presence(overrides: Partial<PresenceUser>): PresenceUser {
  return {
    state: "idle",
    updatedAt: "2026-07-03T00:00:00.000Z",
    userId: "user_1",
    username: "alice",
    ...overrides
  };
}
