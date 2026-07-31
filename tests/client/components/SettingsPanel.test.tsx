// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fingerprintPublicSharingKey } from "@client/lib/sharingKeyTrust";
import { useAppStore } from "@client/store/appStore";
import { SettingsPanel } from "@client/components/SettingsPanel";

beforeEach(() => {
  useAppStore.setState({
    openedSharingKey: {
      publicKey: "AQIDBA==",
      privateKey: "private-key",
      sharingKeyVersion: 3
    },
    error: null,
    status: "Ready"
  });
});

afterEach(cleanup);

describe("SettingsPanel sharing fingerprint", () => {
  it("displays and copies the current account fingerprint", async () => {
    const fingerprint = await fingerprintPublicSharingKey("AQIDBA==");
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });

    render(
      <SettingsPanel
        changePassword={vi.fn()}
        cleanupSharingKeys={vi.fn()}
        newPassword=""
        recoverySecret={null}
        rotateRecoveryKey={vi.fn()}
        rotateSharingKey={vi.fn()}
        setNewPassword={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText(fingerprint)).not.toBeNull();
    });
    fireEvent.click(screen.getByRole("button", { name: "Copy sharing fingerprint" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(fingerprint);
    });
    expect(screen.getByText(/independent channel/i)).not.toBeNull();
    expect(screen.getByText(/key version 3/i)).not.toBeNull();
  });
});

describe("SettingsPanel password change", () => {
  it("does not submit when password confirmation does not match", () => {
    const changePassword = vi.fn();
    render(
      <SettingsPanel
        changePassword={changePassword}
        cleanupSharingKeys={vi.fn()}
        newPassword="new-secret"
        recoverySecret={null}
        rotateRecoveryKey={vi.fn()}
        rotateSharingKey={vi.fn()}
        setNewPassword={vi.fn()}
      />
    );

    fireEvent.change(screen.getByLabelText("Confirm new password"), {
      target: { value: "different-secret" }
    });

    expect(screen.getByText("Passwords do not match")).not.toBeNull();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Change password" }).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(changePassword).not.toHaveBeenCalled();
  });

  it("submits when password confirmation matches", () => {
    const changePassword = vi.fn();
    render(
      <SettingsPanel
        changePassword={changePassword}
        cleanupSharingKeys={vi.fn()}
        newPassword="new-secret"
        recoverySecret={null}
        rotateRecoveryKey={vi.fn()}
        rotateSharingKey={vi.fn()}
        setNewPassword={vi.fn()}
      />
    );

    fireEvent.change(screen.getByLabelText("Confirm new password"), {
      target: { value: "new-secret" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));

    expect(changePassword).toHaveBeenCalledOnce();
  });
});
