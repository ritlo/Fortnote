// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../store/appStore";

const mocks = vi.hoisted(() => ({
  copyRecoverySecret: vi.fn(),
  submitAuth: vi.fn()
}));

vi.mock("../hooks/useAuthActions", () => ({
  useAuthActions: () => ({
    copyRecoverySecret: mocks.copyRecoverySecret,
    submitAuth: mocks.submitAuth
  })
}));

import { AuthScreen } from "./AuthScreen";

beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState({
    authMode: "login",
    error: null,
    password: "",
    recoveryInput: "",
    recoveryNewPassword: "",
    recoverySecret: null,
    status: "Signed out",
    username: ""
  });
});

afterEach(cleanup);

describe("AuthScreen account identity", () => {
  it("normalizes a valid handle when entry is complete", () => {
    render(<AuthScreen />);
    const input = screen.getByLabelText("Account handle");

    fireEvent.change(input, { target: { value: "  Alice.Example  " } });
    fireEvent.blur(input);

    expect((input as HTMLInputElement).value).toBe("alice.example");
  });

  it("shows the legacy handle repair prompt as an alert", () => {
    useAppStore.setState({
      status: "Handle repair required. Sign in again, then choose a unique handle"
    });
    render(<AuthScreen />);

    expect(screen.getByRole("alert").textContent).toContain("Handle repair required");
  });

  it("offers an explicit recovery-key copy action", () => {
    useAppStore.setState({ recoverySecret: "recovery-secret-value" });
    render(<AuthScreen />);

    expect(screen.getByLabelText("Recovery key").textContent).toContain(
      "recovery-secret-value"
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy recovery key" }));
    expect(mocks.copyRecoverySecret).toHaveBeenCalledOnce();
  });
});
