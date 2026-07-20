import { describe, expect, it } from "vitest";
import { canEditNote, canOwnNote, canReadNote } from "./access.js";

describe("note access predicates", () => {
  it("conceals a missing membership without dereferencing it", () => {
    expect(canReadNote(undefined)).toBe(false);
    expect(canEditNote(undefined)).toBe(false);
    expect(canOwnNote(undefined)).toBe(false);
  });
});
