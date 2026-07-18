// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../store/appStore";

const mocks = vi.hoisted(() => ({
  getAuthKdfParams: vi.fn(),
  getKeyMaterial: vi.fn(),
  getMe: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  openVault: vi.fn(),
  openFortnoteIndexedDb: vi.fn(),
  createLoginAuthVerifier: vi.fn(),
  ensureSharingKey: vi.fn(),
  loadFolders: vi.fn(),
  loadNotes: vi.fn(),
  removeSharingKeyTrustRecords: vi.fn(),
  repairAccountHandle: vi.fn()
}));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  cleanupRetiredSharingKeys: vi.fn(),
  getAuthKdfParams: mocks.getAuthKdfParams,
  getCurrentSharingKey: vi.fn(),
  getKeyMaterial: mocks.getKeyMaterial,
  getMe: mocks.getMe,
  getRecoveryParams: vi.fn(),
  login: mocks.login,
  logout: mocks.logout,
  recover: vi.fn(),
  register: vi.fn(),
  repairAccountHandle: mocks.repairAccountHandle,
  storeCurrentSharingKey: vi.fn(),
  updateKeyMaterial: vi.fn()
}));

vi.mock("../lib/indexedDb", () => ({
  openFortnoteIndexedDb: mocks.openFortnoteIndexedDb
}));

vi.mock("../lib/sharingKeyTrust", () => ({
  removeSharingKeyTrustRecords: mocks.removeSharingKeyTrustRecords
}));

vi.mock("../cryptoClient", () => ({
  createAccountRecoveryCrypto: vi.fn(),
  createLoginAuthVerifier: mocks.createLoginAuthVerifier,
  createPasswordChangeCrypto: vi.fn(),
  createRegistrationCrypto: vi.fn(),
  createRecoveryRotationCrypto: vi.fn(),
  createUserSharingKey: vi.fn(),
  openVault: mocks.openVault
}));

vi.mock("./useAppData", () => ({
  ensureSharingKey: mocks.ensureSharingKey,
  loadDecryptedNotes: mocks.loadNotes,
  loadFolders: mocks.loadFolders
}));

import { useAuthActions, useSessionBootstrap } from "./useAuthActions";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAuthKdfParams.mockResolvedValue({
    authKdfSalt: "salt",
    authKdfOpsLimit: 4,
    authKdfMemLimit: 67_108_864,
    authKdfVersion: 1,
    vaultKdfSalt: "salt",
    vaultKdfOpsLimit: 4,
    vaultKdfMemLimit: 67_108_864,
    vaultKdfVersion: 1
  });
  mocks.createLoginAuthVerifier.mockResolvedValue("verifier");
  mocks.login.mockResolvedValue({
    id: "user-a",
    username: "alice.example",
    handleState: "active"
  });
  mocks.getKeyMaterial.mockResolvedValue({
    encryptedRootKey: "cipher",
    rootKeyNonce: "nonce",
    keyMaterialVersion: 1,
    kdfSalt: "salt",
    kdfOpsLimit: 4,
    kdfMemLimit: 67_108_864,
    kdfVersion: 1
  });
  mocks.openVault.mockResolvedValue({ rootKey: new Uint8Array([1]) });
  mocks.ensureSharingKey.mockResolvedValue(undefined);
  mocks.loadFolders.mockResolvedValue(undefined);
  mocks.loadNotes.mockResolvedValue(undefined);
  mocks.logout.mockResolvedValue(undefined);
  mocks.openFortnoteIndexedDb.mockResolvedValue({
    clearAccount: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    listOutbox: vi.fn().mockResolvedValue([]),
    listSectionCache: vi.fn().mockResolvedValue([])
  });
  useAppStore.setState({
    authMode: "login",
    error: null,
    password: "password",
    recoverySecret: null,
    rootKey: null,
    status: "Signed out",
    user: null,
    username: "  ALICE.EXAMPLE  "
  });
});

describe("useAuthActions identity lifecycle", () => {
  it("renews login using the normalized canonical handle", async () => {
    const { result } = renderHook(() => useAuthActions());

    await act(async () => {
      await result.current.submitAuth();
    });

    expect(mocks.getAuthKdfParams).toHaveBeenCalledWith("alice.example");
    expect(mocks.login).toHaveBeenCalledWith("alice.example", "verifier");
    expect(useAppStore.getState().status).toBe("Signed in and decrypted");
  });

  it("preserves a visible repair prompt for a legacy account", async () => {
    mocks.login.mockResolvedValue({
      id: "legacy",
      username: " Legacy Name ",
      canonicalHandle: null,
      handleState: "repair-required"
    });
    useAppStore.setState({ username: " Legacy Name " });
    const { result } = renderHook(() => useAuthActions());

    await act(async () => {
      await result.current.submitAuth();
    });

    expect(mocks.login).toHaveBeenCalledWith(" Legacy Name ", "verifier");
    expect(useAppStore.getState().status).toContain("Handle repair required");
  });

  it("asks an active session for fresh login renewal before decryption", async () => {
    mocks.getMe.mockResolvedValue({
      id: "user-a",
      username: "alice.example",
      handleState: "active"
    });
    renderHook(() => {
      useSessionBootstrap();
    });

    await waitFor(() => {
      expect(useAppStore.getState().status).toContain("renew and decrypt");
    });
  });

  it("copies only the recovery secret and reports a safe status", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });
    useAppStore.setState({ recoverySecret: "private-recovery-secret" });
    const { result } = renderHook(() => useAuthActions());

    await act(async () => {
      await result.current.copyRecoverySecret();
    });

    expect(writeText).toHaveBeenCalledWith("private-recovery-secret");
    expect(useAppStore.getState().status).not.toContain("private-recovery-secret");
    expect(useAppStore.getState().status).toContain("somewhere private and offline");
  });

  it("warns before discarding recoverable offline work on logout", async () => {
    const database = {
      clearAccount: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      listOutbox: vi.fn().mockResolvedValue([{ updateId: "pending-update" }]),
      listSectionCache: vi.fn().mockResolvedValue([])
    };
    mocks.openFortnoteIndexedDb.mockResolvedValue(database);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    useAppStore.setState({
      user: { id: "user-a", username: "alice.example" },
      rootKey: new Uint8Array([1]),
      notes: [{ id: "decrypted-note" }] as never
    });
    const { result } = renderHook(() => useAuthActions());

    await act(async () => {
      await result.current.submitLogout();
    });

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("recoverable offline"));
    expect(mocks.logout).not.toHaveBeenCalled();
    expect(database.clearAccount).not.toHaveBeenCalled();
    expect(useAppStore.getState().rootKey).not.toBeNull();
    confirm.mockRestore();
  });

  it("clears account-scoped browser data and decrypted state after confirmation", async () => {
    const database = {
      clearAccount: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      listOutbox: vi.fn().mockResolvedValue([]),
      listSectionCache: vi.fn().mockResolvedValue([
        { manifestId: "pending-cache", pending: true }
      ])
    };
    mocks.openFortnoteIndexedDb.mockResolvedValue(database);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    useAppStore.setState({
      user: { id: "user-a", username: "alice.example" },
      rootKey: new Uint8Array([1]),
      notes: [{ id: "decrypted-note" }] as never,
      search: "decrypted title"
    });
    const { result } = renderHook(() => useAuthActions());

    await act(async () => {
      await result.current.submitLogout();
    });

    expect(mocks.logout).toHaveBeenCalledOnce();
    expect(database.clearAccount).toHaveBeenCalledWith("user-a");
    expect(mocks.removeSharingKeyTrustRecords).toHaveBeenCalledWith("user-a");
    expect(database.close).toHaveBeenCalledOnce();
    expect(useAppStore.getState()).toMatchObject({
      rootKey: null,
      notes: [],
      search: "",
      user: null,
      status: "Signed out"
    });
    confirm.mockRestore();
  });
});
