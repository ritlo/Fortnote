import { describe, expect, it } from "vitest";
import { roleLabel } from "./NotesPane";

describe("NotesPane role labels", () => {
  it("formats note roles for list badges", () => {
    expect(roleLabel("owner")).toBe("Owner");
    expect(roleLabel("editor")).toBe("Editor");
    expect(roleLabel("viewer")).toBe("Viewer");
  });
});
