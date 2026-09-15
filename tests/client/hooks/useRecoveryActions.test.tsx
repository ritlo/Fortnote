// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EncryptedOutboxRecord } from "@client/lib/indexedDb";
import {
  recoverableDraftId,
  useAppStore,
  type DecryptedNote,
  type RetainedSectionDraft
} from "@client/store/appStore";
import { useRecoveryActions } from "@client/hooks/useRecoveryActions";

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  deleteOutboxFence: vi.fn(),
  downloadBytes: vi.fn(),
  evictSectionCache: vi.fn(),
  listOutbox: vi.fn(),
  writeText: vi.fn()
}));

vi.mock("@client/lib/browser", () => ({ downloadBytes: mocks.downloadBytes }));
vi.mock("@client/lib/indexedDb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@client/lib/indexedDb")>()),
  openFortnoteIndexedDb: vi.fn(() =>
    Promise.resolve({
      close: mocks.close,
      deleteOutboxFence: mocks.deleteOutboxFence,
      evictSectionCache: mocks.evictSectionCache,
      listOutbox: mocks.listOutbox
    })
  )
}));
vi.mock("@client/realtime/crdt", () => ({
  createCrdtSectionInitializationManifest: vi.fn(),
  waitForCrdtSectionDurable: vi.fn()
}));

const note = {
  id: "note-1",
  keyEpoch: 2,
  role: "editor",
  isDeleted: false
} as DecryptedNote;
const draft: RetainedSectionDraft = {
  userId: "user-1",
  noteId: note.id,
  sectionId: "section-1",
  keyEpoch: note.keyEpoch,
  reason: "forbidden",
  updateIds: ["update-1"],
  createdAt: 1,
  retainedAt: 2
};
const record = {
  ...draft,
  cryptoOwnerId: "user-1",
  updateId: "update-1",
  kind: "update",
  formatVersion: 2,
  inlineCipher: new Uint8Array([1, 2]),
  nonce: new Uint8Array([3, 4]),
  state: "terminal-rejected",
  terminalReason: "forbidden",
  attempts: 1,
  updatedAt: 2
} satisfies EncryptedOutboxRecord;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listOutbox.mockResolvedValue([record]);
  useAppStore.setState({ recoverableDrafts: {}, error: null });
  useAppStore.getState().retainRecoverableDraft(draft);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: mocks.writeText }
  });
});

describe("useRecoveryActions", () => {
  it("reviews and copies only encrypted draft records", async () => {
    const { result } = renderRecoveryActions();

    await act(async () => Promise.resolve(result.current.reviewDraft()));
    expect(currentDraft().state).toBe("reviewing");

    await act(async () => result.current.copy());
    const exported = mocks.writeText.mock.calls[0]?.[0] ?? "";
    expect(exported).toContain("fortnote-encrypted-draft-v1");
    expect(exported).toContain("AQI=");
    expect(exported).not.toContain("plaintext");
  });

  it("requires confirmation before deleting the exact rejected fence", async () => {
    vi.spyOn(globalThis, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { result } = renderRecoveryActions();
    await act(async () => Promise.resolve(result.current.reviewDraft()));

    await act(async () => result.current.discard());
    expect(mocks.deleteOutboxFence).not.toHaveBeenCalled();

    await act(async () => result.current.discard());
    expect(mocks.deleteOutboxFence).toHaveBeenCalledWith(
      expect.objectContaining({
        noteId: note.id,
        sectionId: draft.sectionId,
        keyEpoch: draft.keyEpoch
      })
    );
    expect(currentDraft().state).toBe("discarded");
  });
});

function renderRecoveryActions() {
  return renderHook(() => useRecoveryActions(note, vi.fn()));
}

function currentDraft() {
  return useAppStore.getState().recoverableDrafts[recoverableDraftId(draft)]!;
}
