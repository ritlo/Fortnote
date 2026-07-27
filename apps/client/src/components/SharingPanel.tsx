import { useEffect, useRef, useState } from "react";
import { Share2, UserPlus } from "lucide-react";
import { fromBase64 } from "@fortnote/shared";
import {
  inviteNoteMember,
  listNoteMemberships,
  lookupSharingKey,
  rotateNoteKey,
  updateNoteMemberRole,
  type NoteMembership,
  type PresenceUser,
  type PublicSharingKey
} from "../api";
import {
  encryptNoteKeyShareV2,
} from "../cryptoClient";
import type { DecryptedNote } from "../store/appStore";
import { useAppStore } from "../store/appStore";
import {
  getSharingKeyTrustDecision,
  trustSharingKey
} from "../lib/sharingKeyTrust";
import {
  linkedEpochPreparationMatches,
  prepareLinkedEpochRotation,
  type LinkedEpochRotationPreparation
} from "../lib/keyMaterial";
import { ensureCrdtHistoryReadable } from "../realtime/crdt";
import { loadDecryptedNotes } from "../hooks/useAppData";

interface SharingPanelProps {
  selectedNote: DecryptedNote | null;
  disabled: boolean;
}

const EMPTY_PRESENCE: PresenceUser[] = [];

interface PendingSharingTrust {
  publicKey: PublicSharingKey;
  fingerprint: string;
  noteId: string;
  noteKeyBase64: string;
  role: "editor" | "viewer";
  username: string;
}

export function SharingPanel({ selectedNote, disabled }: SharingPanelProps) {
  const [memberships, setMemberships] = useState<NoteMembership[]>([]);
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<"editor" | "viewer">("editor");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pendingTrust, setPendingTrust] = useState<PendingSharingTrust | null>(null);
  const [isTrustConfirmed, setIsTrustConfirmed] = useState(false);
  const shareButtonRef = useRef<HTMLButtonElement>(null);
  const trustCheckboxRef = useRef<HTMLInputElement>(null);
  const user = useAppStore((state) => state.user);
  const rootKey = useAppStore((state) => state.rootKey);
  const setError = useAppStore((state) => state.setError);
  const setNotes = useAppStore((state) => state.setNotes);
  const setRevocationRotationFailure = useAppStore(
    (state) => state.setRevocationRotationFailure
  );
  const setRevocationRotationPendingNoteId = useAppStore(
    (state) => state.setRevocationRotationPendingNoteId
  );
  const setStatus = useAppStore((state) => state.setStatus);
  const selectedRotationFailure = useAppStore((state) =>
    selectedNote ? state.revocationRotationFailures[selectedNote.id] : undefined
  );
  const presence = useAppStore((state) =>
    selectedNote ? (state.presenceByNote[selectedNote.id] ?? EMPTY_PRESENCE) : EMPTY_PRESENCE
  );

  useEffect(() => {
    let isActive = true;
    if (!selectedNote) {
      setMemberships([]);
      return;
    }

    void listNoteMemberships(selectedNote.id)
      .then((payload) => {
        if (isActive) {
          setMemberships(payload.memberships);
        }
      })
      .catch(() => {
        if (isActive) {
          setMemberships([]);
        }
      });

    return () => {
      isActive = false;
    };
  }, [selectedNote]);

  useEffect(() => {
    setPendingTrust(null);
    setIsTrustConfirmed(false);
  }, [selectedNote?.id]);

  useEffect(() => {
    if (pendingTrust) {
      trustCheckboxRef.current?.focus();
    }
  }, [pendingTrust]);

  function closePendingTrust(): void {
    setPendingTrust(null);
    setIsTrustConfirmed(false);
    window.setTimeout(() => shareButtonRef.current?.focus());
  }

  async function submitInvite() {
    if (selectedNote?.role !== "owner" || !username.trim()) {
      return;
    }
    const note = selectedNote;

    setIsSubmitting(true);
    setError(null);
    try {
      const publicKey = await lookupSharingKey(username.trim());
      if (!user || !rootKey) {
        throw new Error("Vault is locked");
      }
      const trust = await getSharingKeyTrustDecision({
        ownerUserId: user.id,
        rootKey,
        publicKey
      });
      if (trust.status === "mismatch") {
        setStatus("Share blocked");
        setError(
          `Sharing key changed for ${publicKey.username}. Previously trusted ${trust.trustedFingerprint}; server returned ${trust.fingerprint}.`
        );
        return;
      }
      if (trust.status === "untrusted") {
        setIsTrustConfirmed(false);
        setPendingTrust({
          publicKey,
          fingerprint: trust.fingerprint,
          noteId: note.id,
          noteKeyBase64: note.noteKeyBase64,
          role,
          username: username.trim()
        });
        setStatus("Confirm collaborator key");
        return;
      }
      await shareWithPublicKey(note, publicKey, role, username.trim());
    } catch (inviteError) {
      setStatus("Share failed");
      setError(inviteError instanceof Error ? inviteError.message : "Unable to share note");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function confirmPendingTrust() {
    if (!pendingTrust || !user || !rootKey) {
      return;
    }
    if (!canConfirmSharingKeyTrust(isTrustConfirmed)) {
      setError("Confirm that you independently verified this exact sharing key");
      return;
    }
    if (!pendingTrustMatchesNote(pendingTrust, selectedNote)) {
      setPendingTrust(null);
      setStatus("Share cancelled");
      setError("Selected note or note key changed. Start sharing again.");
      return;
    }
    const note = selectedNote;

    setIsSubmitting(true);
    setError(null);
    try {
      await trustSharingKey({
        ownerUserId: user.id,
        rootKey,
        publicKey: pendingTrust.publicKey,
        fingerprint: pendingTrust.fingerprint
      });
      await shareWithPublicKey(
        note,
        pendingTrust.publicKey,
        pendingTrust.role,
        pendingTrust.username
      );
      setPendingTrust(null);
      setIsTrustConfirmed(false);
    } catch (trustError) {
      setStatus("Share failed");
      setError(trustError instanceof Error ? trustError.message : "Unable to trust key");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function shareWithPublicKey(
    note: DecryptedNote,
    publicKey: PublicSharingKey,
    memberRole: "editor" | "viewer",
    collaboratorUsername: string
  ) {
    if (note.role !== "owner" || !user) {
      return;
    }

    const encryptedNoteKey = await encryptNoteKeyShareV2({
      cryptoOwnerId: note.cryptoOwnerId,
      noteId: note.id,
      keyEpoch: note.keyEpoch,
      recipientUserId: publicKey.userId,
      recipientSharingKeyVersion: publicKey.sharingKeyVersion,
      senderUserId: user.id,
      noteKey: fromBase64(note.noteKeyBase64),
      recipientPublicKey: publicKey.publicKey
    });
    await inviteNoteMember(note.id, {
      username: collaboratorUsername,
      role: memberRole,
      sharingKeyVersion: publicKey.sharingKeyVersion,
      encryptedNoteKey,
      formatVersion: 2
    });
    const payload = await listNoteMemberships(note.id);
    setMemberships(payload.memberships);
    setUsername("");
    setStatus("Note shared");
  }

  async function changeMemberRole(member: NoteMembership, nextRole: "editor" | "viewer") {
    if (selectedNote?.role !== "owner" || member.role === "owner") {
      return;
    }

    setError(null);
    try {
      await updateNoteMemberRole(selectedNote.id, member.userId, nextRole);
      const payload = await listNoteMemberships(selectedNote.id);
      setMemberships(payload.memberships);
      setStatus("Collaborator role updated");
    } catch (roleError) {
      setStatus("Share update failed");
      setError(roleError instanceof Error ? roleError.message : "Unable to update role");
    }
  }

  async function revokeMember(member: NoteMembership) {
    if (selectedNote?.role !== "owner" || member.role === "owner" || !rootKey) {
      return;
    }
    if (
      !window.confirm(
        `Revoke access for ${member.username}? They will lose access after encrypted keys rotate.`
      )
    ) {
      return;
    }
    const note = selectedNote;
    const vaultRootKey = rootKey;

    setIsSubmitting(true);
    setRevocationRotationPendingNoteId(note.id);
    setError(null);
    try {
      const payload = await listNoteMemberships(note.id);
      setMemberships(payload.memberships);
      await finishRevocationRotation(note, member, payload.memberships, vaultRootKey);
    } catch (revokeError) {
      setStatus("Revoke failed");
      setError(revokeError instanceof Error ? revokeError.message : "Unable to revoke");
    } finally {
      setRevocationRotationPendingNoteId(null);
      setIsSubmitting(false);
    }
  }

  async function finishRevocationRotation(
    note: DecryptedNote,
    member: NoteMembership,
    nextMemberships: NoteMembership[],
    vaultRootKey: Uint8Array,
    retryPreparation?: LinkedEpochRotationPreparation
  ) {
    let preparation = retryPreparation;
    try {
      if (
        !preparation ||
        !linkedEpochPreparationMatches({
          preparation,
          note,
          revokedUserId: member.userId
        })
      ) {
        preparation = await prepareLinkedEpochRotation({
          note,
          revokedUserId: member.userId,
          rootKey: vaultRootKey
        });
      }
      await rotateAfterRevoke(note, member, nextMemberships, vaultRootKey, preparation);
      const currentMemberships = await listNoteMemberships(note.id);
      setMemberships(currentMemberships.memberships);
      setRevocationRotationFailure(note.id, null);
      setStatus("Collaborator revoked and keys rotated");
      return true;
    } catch (rotationError) {
      const message =
        rotationError instanceof Error ? rotationError.message : "Key rotation failed";
      setRevocationRotationFailure(note.id, {
        noteId: note.id,
        revokedUserId: member.userId,
        revokedUsername: member.username,
        message,
        failedAt: new Date().toISOString(),
        ...(preparation ? { preparation } : {})
      });
      setStatus("Revocation pending");
      setError(`Revocation and key rotation failed: ${message}`);
      return false;
    }
  }

  async function retryRevocationRotation() {
    if (
      selectedNote?.role !== "owner" ||
      !rootKey ||
      !selectedRotationFailure
    ) {
      return;
    }

    setIsSubmitting(true);
    setRevocationRotationPendingNoteId(selectedNote.id);
    setError(null);
    setStatus("Retrying key rotation");
    try {
      const payload = await listNoteMemberships(selectedNote.id);
      setMemberships(payload.memberships);
      const revokedMember = payload.memberships.find(
        (membership) => membership.userId === selectedRotationFailure.revokedUserId
      );
      if (revokedMember?.status === "revoked") {
        if (user) {
          await loadDecryptedNotes(user, rootKey, false, { preserveSelection: true });
        }
      } else {
        const succeeded = await finishRevocationRotation(
          selectedNote,
          revokedMember ?? {
            createdAt: selectedRotationFailure.failedAt,
            role: "editor",
            status: "active",
            updatedAt: selectedRotationFailure.failedAt,
            userId: selectedRotationFailure.revokedUserId,
            username: selectedRotationFailure.revokedUsername
          },
          payload.memberships,
          rootKey,
          selectedRotationFailure.preparation
        );
        if (!succeeded) {
          return;
        }
      }
      setRevocationRotationFailure(selectedNote.id, null);
      setStatus("Keys rotated after revoke");
    } catch (rotationError) {
      const message =
        rotationError instanceof Error ? rotationError.message : "Key rotation failed";
      setRevocationRotationFailure(selectedNote.id, {
        ...selectedRotationFailure,
        message,
        failedAt: new Date().toISOString()
      });
      setStatus("Key rotation failed");
      setError(`Key rotation failed: ${message}`);
    } finally {
      setRevocationRotationPendingNoteId(null);
      setIsSubmitting(false);
    }
  }

  async function rotateAfterRevoke(
    note: DecryptedNote,
    revokedMember: NoteMembership,
    nextMemberships: NoteMembership[],
    vaultRootKey: Uint8Array,
    preparation: LinkedEpochRotationPreparation
  ) {
    await ensureCrdtHistoryReadable(note.id);
    const remainingMembers = nextMemberships.filter(
      (membership) =>
        membership.status === "active" &&
        membership.role !== "owner" &&
        membership.userId !== revokedMember.userId
    );
    const shares = await Promise.all(
      remainingMembers.map(async (membership) => {
        if (!user) {
          throw new Error("Vault is locked");
        }
        const publicKey = await lookupSharingKey(membership.username);
        if (publicKey.userId !== membership.userId) {
          throw new Error(`Sharing identity changed for ${membership.username}`);
        }
        const trust = await getSharingKeyTrustDecision({
          ownerUserId: user.id,
          rootKey: vaultRootKey,
          publicKey
        });
        if (trust.status === "mismatch") {
          throw new Error(`Sharing key changed for ${membership.username}`);
        }
        if (trust.status === "untrusted") {
          throw new Error(`Trust sharing key for ${membership.username} before rotating keys`);
        }
        return {
          recipientUserId: membership.userId,
          sharingKeyVersion: publicKey.sharingKeyVersion,
          encryptedNoteKey: await encryptNoteKeyShareV2({
            cryptoOwnerId: note.cryptoOwnerId,
            noteId: note.id,
            keyEpoch: preparation.targetEpoch,
            recipientUserId: membership.userId,
            recipientSharingKeyVersion: publicKey.sharingKeyVersion,
            senderUserId: user.id,
            noteKey: fromBase64(preparation.targetNoteKeyBase64),
            recipientPublicKey: publicKey.publicKey
          }),
          formatVersion: 2 as const
        };
      })
    );
    await ensureCrdtHistoryReadable(note.id);
    const rotated = await rotateNoteKey(note.id, {
      mode: "linked",
      revokedUserId: revokedMember.userId,
      rootVersion: preparation.rootVersion,
      sourceEpoch: preparation.sourceEpoch,
      targetEpoch: preparation.targetEpoch,
      encryptedNoteKey: preparation.encryptedNoteKey,
      noteKeyNonce: preparation.noteKeyNonce,
      noteKeyFormatVersion: 2,
      titleCipher: preparation.titleCipher,
      titleNonce: preparation.titleNonce,
      titleFormatVersion: 2,
      previousKeyCipher: preparation.previousKeyCipher,
      previousKeyNonce: preparation.previousKeyNonce,
      linkFormatVersion: 2,
      shares
    });
    const rotationPatch = {
      noteKeyBase64: preparation.targetNoteKeyBase64,
      keyEpoch: rotated.keyEpoch,
      rootVersion: rotated.rootVersion ?? preparation.rootVersion + 1,
      updatedAt: new Date().toISOString(),
      version: rotated.version
    };
    setNotes((current) =>
      current.map((currentNote) =>
        currentNote.id === note.id
          ? { ...currentNote, ...rotationPatch }
          : currentNote
      )
    );
  }

  const canInvite = selectedNote?.role === "owner" && !disabled;
  return (
    <section className="sharing-panel">
      <div className="section-title">
        <Share2 size={16} />
        <h3>Sharing</h3>
      </div>
      {canInvite ? (
        <>
          <div className="share-form">
            <input
              aria-label="Collaborator username"
              placeholder="Username"
              value={username}
              onChange={(event) => {
                setUsername(event.target.value);
                setPendingTrust(null);
                setIsTrustConfirmed(false);
              }}
            />
            <select
              aria-label="Collaborator role"
              value={role}
              onChange={(event) => {
                setRole(event.target.value as "editor" | "viewer");
                setPendingTrust(null);
                setIsTrustConfirmed(false);
              }}
            >
              <option value="editor">Editor</option>
              <option value="viewer">Viewer</option>
            </select>
            <button
              ref={shareButtonRef}
              className="icon-button"
              type="button"
              aria-label="Share note"
              disabled={!username.trim() || isSubmitting}
              onClick={() => {
                void submitInvite();
              }}
            >
              <UserPlus size={16} />
            </button>
          </div>
          {pendingTrust ? (
            <div
              className="trust-confirmation"
              role="dialog"
              aria-modal="true"
              aria-label="Confirm collaborator key"
            >
              <span>
                <strong>{pendingTrust.publicKey.username}</strong>
                <small>
                  Sharing key version {pendingTrust.publicKey.sharingKeyVersion}
                </small>
                <code>{pendingTrust.fingerprint}</code>
              </span>
              <p>{sharingKeyTrustInstruction(pendingTrust.publicKey.username)}</p>
              <label>
                <input
                  ref={trustCheckboxRef}
                  type="checkbox"
                  checked={isTrustConfirmed}
                  onChange={(event) => {
                    setIsTrustConfirmed(event.target.checked);
                  }}
                />
                I independently verified this exact key
              </label>
              <div>
                <button
                  className="text-button"
                  type="button"
                  disabled={isSubmitting || !canConfirmSharingKeyTrust(isTrustConfirmed)}
                  onClick={() => {
                    void confirmPendingTrust();
                  }}
                >
                  Trust key
                </button>
                <button
                  className="text-button"
                  type="button"
                  disabled={isSubmitting}
                  onClick={() => {
                    closePendingTrust();
                    setStatus("Share cancelled");
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
          {selectedRotationFailure ? (
            <div className="rotation-retry">
              <span>
                <strong>Key rotation incomplete</strong>
                <small>
                  {selectedRotationFailure.revokedUsername}: {selectedRotationFailure.message}
                </small>
              </span>
              <button
                className="text-button"
                type="button"
                disabled={isSubmitting}
                onClick={() => {
                  void retryRevocationRotation();
                }}
              >
                Retry rotation
              </button>
            </div>
          ) : null}
        </>
      ) : null}
      <ul className="membership-list">
        {memberships.map((membership) => (
          <li key={membership.userId}>
            <span>
              <strong>{membership.username}</strong>
              <small>
                {membership.status}
                {presence.some((user) => user.userId === membership.userId)
                  ? ` · ${
                      presence.find((user) => user.userId === membership.userId)?.state ??
                      "online"
                    }`
                  : ""}
              </small>
            </span>
            {canInvite && membership.role !== "owner" ? (
              <div className="membership-actions">
                <select
                  aria-label={`Role for ${membership.username}`}
                  value={membership.role}
                  disabled={membership.status !== "active"}
                  onChange={(event) => {
                    void changeMemberRole(
                      membership,
                      event.target.value as "editor" | "viewer"
                    );
                  }}
                >
                  <option value="editor">Editor</option>
                  <option value="viewer">Viewer</option>
                </select>
                <button
                  className="text-button danger"
                  type="button"
                  disabled={membership.status === "revoked" || isSubmitting}
                  onClick={() => {
                    void revokeMember(membership);
                  }}
                >
                  Revoke
                </button>
              </div>
            ) : (
              <small>{membership.role}</small>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function pendingTrustMatchesNote(
  pendingTrust: Pick<PendingSharingTrust, "noteId" | "noteKeyBase64">,
  note: DecryptedNote | null
): note is DecryptedNote {
  return (
    note?.id === pendingTrust.noteId &&
    note.noteKeyBase64 === pendingTrust.noteKeyBase64
  );
}

export function canConfirmSharingKeyTrust(isConfirmed: boolean): boolean {
  return isConfirmed;
}

export function sharingKeyTrustInstruction(username: string): string {
  return `Compare this exact fingerprint with ${username} through an independent channel before trusting it.`;
}
