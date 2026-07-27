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
  it("shows only the login form initially", () => {
    render(<AuthScreen />);

    expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(screen.getByLabelText("Account password")).toBeTruthy();
    expect(screen.queryByLabelText("Recovery key")).toBeNull();
    expect(screen.queryByLabelText("New account password")).toBeNull();
    expect(screen.queryByLabelText("Confirm password")).toBeNull();
  });

  it("switches between separate login, register, and recover forms", () => {
    render(<AuthScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Create an account" }));
    expect(screen.getByRole("heading", { name: "Register" })).toBeTruthy();
    expect(screen.getByLabelText("Confirm password")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Recover access" }));
    expect(screen.getByRole("heading", { name: "Recover account" })).toBeTruthy();
    expect(screen.getByLabelText("Recovery key")).toBeTruthy();
    expect(screen.getByLabelText("Confirm new password")).toBeTruthy();
  });

  it("clears stale auth feedback when switching forms", () => {
    useAppStore.setState({
      error: "Invalid username or password",
      status: "Auth failed"
    });
    render(<AuthScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Create an account" }));

    expect(screen.queryByText("Invalid username or password")).toBeNull();
    expect(screen.getByText("Signed out")).toBeTruthy();
  });

  it("rejects registration when passwords do not match", () => {
    render(<AuthScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Create an account" }));

    fireEvent.change(screen.getByLabelText("Account password"), {
      target: { value: "one-password" }
    });
    fireEvent.change(screen.getByLabelText("Confirm password"), {
      target: { value: "different-password" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Create encrypted vault" }));

    expect(screen.getByRole("alert").textContent).toContain("Passwords do not match");
    expect(mocks.submitAuth).not.toHaveBeenCalled();
  });

  it("submits registration when passwords match", () => {
    render(<AuthScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Create an account" }));

    fireEvent.change(screen.getByLabelText("Account password"), {
      target: { value: "one-password" }
    });
    fireEvent.change(screen.getByLabelText("Confirm password"), {
      target: { value: "one-password" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Create encrypted vault" }));

    expect(mocks.submitAuth).toHaveBeenCalledOnce();
  });

  it("rejects recovery when new passwords do not match", () => {
    render(<AuthScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Recover access" }));

    fireEvent.change(screen.getByLabelText("New account password"), {
      target: { value: "one-password" }
    });
    fireEvent.change(screen.getByLabelText("Confirm new password"), {
      target: { value: "different-password" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Recover and decrypt" }));

    expect(screen.getByRole("alert").textContent).toContain("Passwords do not match");
    expect(mocks.submitAuth).not.toHaveBeenCalled();
  });

  it("submits recovery when new passwords match", () => {
    render(<AuthScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Recover access" }));

    fireEvent.change(screen.getByLabelText("New account password"), {
      target: { value: "one-password" }
    });
    fireEvent.change(screen.getByLabelText("Confirm new password"), {
      target: { value: "one-password" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Recover and decrypt" }));

    expect(mocks.submitAuth).toHaveBeenCalledOnce();
  });

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
