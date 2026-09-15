// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  deriveCollaborationState,
  defaultCollaborationDimensions
} from "@client/lib/collaborationState";
import { CollaborationStatus } from "@client/components/CollaborationStatus";

afterEach(cleanup);

describe("CollaborationStatus", () => {
  it.each([
    ["saving", "Saving encrypted note…"],
    ["pending", "Synchronizing…"],
    ["uploading", "Uploading encrypted changes…"]
  ] as const)("announces %s progress politely", (durability, label) => {
    render(<CollaborationStatus state={state({ durability })} />);
    const status = screen.getByRole("status");
    expect(status.textContent).toBe(label);
    expect(status.getAttribute("aria-live")).toBe("polite");
  });

  it("uses an assertive status for offline work without claiming synchronization", () => {
    render(
      <CollaborationStatus
        state={state({ connection: "offline", durability: "pending" })}
      />
    );
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Offline — changes kept on this device");
    expect(status.getAttribute("aria-live")).toBe("assertive");
    expect(screen.queryByText(/synchronized/iu)).toBeNull();
  });

  it.each([
    [{ durability: "local-full" }, "Local storage full — changes need attention"],
    [{ durability: "server-full" }, "Server storage full — changes kept on this device"],
    [{ recovery: "divergent" }, "Changes need review"],
    [{ protection: "aborted" }, "Access change not completed"],
    [{ recovery: "error" }, "Operation failed"]
  ] as const)("renders intervention state %o as an alert", (overrides, label) => {
    render(<CollaborationStatus state={state(overrides)} />);
    expect(screen.getByRole("alert").textContent).toBe(label);
  });

  it("renders bounded transfer progress with an accessible name", () => {
    render(
      <CollaborationStatus
        state={state({ durability: "uploading" })}
        progress={{ completed: 2, total: 5 }}
      />
    );
    const progress = screen.getByRole("progressbar", {
      name: "Encrypted synchronization progress"
    });
    expect(progress.getAttribute("value")).toBe("2");
    expect(progress.getAttribute("max")).toBe("5");
  });
});

function state(overrides: Partial<typeof defaultCollaborationDimensions>) {
  return deriveCollaborationState({ ...defaultCollaborationDimensions, ...overrides });
}
