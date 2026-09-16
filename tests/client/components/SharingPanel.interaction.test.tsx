// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecryptedNote } from "@client/store/appStore";
import { useAppStore } from "@client/store/appStore";

const mocks = vi.hoisted(() => ({
  ensureCrdtHistoryReadable: vi.fn(),
  getSharingKeyTrustDecision: vi.fn(),
  inviteNoteMember: vi.fn(),
  listNoteMemberships: vi.fn(),
  lookupSharingKey: vi.fn(),
  prepareLinkedEpochRotation: vi.fn(),
  rotateNoteKey: vi.fn(),
  trustSharingKey: vi.fn(),
  updateNoteMemberRole: vi.fn()
}));

vi.mock("@client/api", () => ({
  inviteNoteMember: mocks.inviteNoteMember,
  listNoteMemberships: mocks.listNoteMemberships,
  lookupSharingKey: mocks.lookupSharingKey,
  rotateNoteKey: mocks.rotateNoteKey,
  updateNoteMemberRole: mocks.updateNoteMemberRole
}));

vi.mock("@client/cryptoClient", () => ({
  encryptNoteKeyShareV2: vi.fn()
}));

vi.mock("@client/lib/keyMaterial", () => ({
  linkedEpochPreparationMatches: vi.fn(),
  prepareLinkedEpochRotation: mocks.prepareLinkedEpochRotation
}));

vi.mock("@client/lib/sharingKeyTrust", () => ({
  getSharingKeyTrustDecision: mocks.getSharingKeyTrustDecision,
  trustSharingKey: mocks.trustSharingKey
}));

vi.mock("@client/realtime/crdt", () => ({
  ensureCrdtHistoryReadable: mocks.ensureCrdtHistoryReadable
}));

vi.mock("@client/hooks/useAppData", () => ({
  loadDecryptedNotes: vi.fn()
}));

import { SharingPanel } from "@client/components/SharingPanel";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listNoteMemberships.mockResolvedValue({ memberships: [membership()] });
  useAppStore.setState({
    rootKey: new Uint8Array([1]),
    user: { id: "alice", username: "alice" }
  });
});

afterEach(() => {
  cleanup();
  useAppStore.getState().resetVaultState("reset");
  vi.restoreAllMocks();
});

describe("SharingPanel destructive actions", () => {
  it("requires confirmation before revoking a collaborator", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<SharingPanel selectedNote={note()} disabled={false} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Revoke" })).toBeTruthy();
    });
    const membershipLoadCount = mocks.listNoteMemberships.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));

    expect(confirm).toHaveBeenCalledWith(
      "Revoke access for bob? They will lose access after encrypted keys rotate."
    );
    expect(mocks.listNoteMemberships).toHaveBeenCalledTimes(membershipLoadCount);
    expect(mocks.rotateNoteKey).not.toHaveBeenCalled();
  });
});

function note(): DecryptedNote {
  return {
    cryptoOwnerId: "alice",
    folderId: null,
    id: "note-1",
    isDeleted: false,
    keyEpoch: 1,
    noteKeyBase64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    ownerUserId: "alice",
    role: "owner",
    rootVersion: 1,
    rootSectionId: "root",
    title: "Title",
    updatedAt: "2026-07-10T00:00:00.000Z",
    version: 1
  };
}

function membership() {
  return {
    createdAt: "2026-07-10T00:00:00.000Z",
    role: "editor" as const,
    status: "active" as const,
    updatedAt: "2026-07-10T00:00:00.000Z",
    userId: "bob",
    username: "bob"
  };
}
