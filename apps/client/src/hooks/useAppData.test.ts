import { beforeEach, describe, expect, it, vi } from "vitest";
import { createUserSharingKey } from "../cryptoClient";
import {
  getCurrentSharingKey,
  listFolders,
  listNotes,
  storeCurrentSharingKey
} from "../api";
import { useAppStore } from "../store/appStore";
import { ensureSharingKey } from "./useAppData";

vi.mock("../api", () => ({
  getCurrentSharingKey: vi.fn(),
  listFolders: vi.fn(),
  listNotes: vi.fn(),
  storeCurrentSharingKey: vi.fn()
}));

const mockedGetCurrentSharingKey = vi.mocked(getCurrentSharingKey);
const mockedStoreCurrentSharingKey = vi.mocked(storeCurrentSharingKey);
vi.mocked(listFolders).mockResolvedValue({ folders: [] });
vi.mocked(listNotes).mockResolvedValue({ notes: [] });

describe("app data collaboration bootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.getState().resetVaultState("test reset");
  });

  it("opens an existing sharing key envelope", async () => {
    const rootKey = crypto.getRandomValues(new Uint8Array(32));
    const created = await createUserSharingKey(rootKey);
    mockedGetCurrentSharingKey.mockResolvedValue({
      ...created.payload,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    const opened = await ensureSharingKey(rootKey);

    expect(opened).toEqual(created.opened);
    expect(useAppStore.getState().openedSharingKey).toEqual(created.opened);
    expect(mockedStoreCurrentSharingKey).not.toHaveBeenCalled();
  });

  it("creates and stores a sharing key when none exists", async () => {
    const rootKey = crypto.getRandomValues(new Uint8Array(32));
    mockedGetCurrentSharingKey.mockRejectedValue(new Error("Sharing key not found"));
    mockedStoreCurrentSharingKey.mockResolvedValue({ sharingKeyVersion: 1 });

    const opened = await ensureSharingKey(rootKey);

    expect(opened.sharingKeyVersion).toBe(1);
    expect(opened.privateKey).toEqual(expect.any(String));
    expect(opened.publicKey).toEqual(expect.any(String));
    expect(mockedStoreCurrentSharingKey).toHaveBeenCalledWith(
      expect.objectContaining({
        sharingKeyVersion: 1,
        publicKey: opened.publicKey,
        encryptedPrivateKey: expect.any(String),
        privateKeyNonce: expect.any(String),
        formatVersion: 1
      })
    );
    expect(useAppStore.getState().openedSharingKey).toEqual(opened);
  });
});
