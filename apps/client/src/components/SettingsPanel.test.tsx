// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fingerprintPublicSharingKey } from "../lib/sharingKeyTrust";
import { useAppStore } from "../store/appStore";
import { SettingsPanel } from "./SettingsPanel";

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
