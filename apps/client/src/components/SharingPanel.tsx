import { useEffect, useState } from "react";
import { Share2, UserPlus } from "lucide-react";
import {
  inviteNoteMember,
  listAttachments,
  listNoteMemberships,
  lookupSharingKey,
  revokeNoteMember,
  rotateNoteKey,
  updateNoteMemberRole,
  type AttachmentSummary,
  type NoteMembership,
  type PresenceUser,
  type PublicSharingKey
} from "../api";
import {
  encryptNoteKeyShare,
  rewrapAttachmentKey,
  rotateNoteKeyMaterial
} from "../cryptoClient";
import type { DecryptedNote } from "../store/appStore";
import { useAppStore } from "../store/appStore";
import {
  getSharingKeyTrustDecision,
  trustSharingKey
} from "../lib/sharingKeyTrust";

interface SharingPanelProps {
  selectedNote: DecryptedNote | null;
  disabled: boolean;
}

const EMPTY_PRESENCE: PresenceUser[] = [];

interface PendingSharingTrust {
  publicKey: PublicSharingKey;
  fingerprint: string;
  role: "editor" | "viewer";
  username: string;
}

export function SharingPanel({ selectedNote, disabled }: SharingPanelProps) {
  const [memberships, setMemberships] = useState<NoteMembership[]>([]);
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<"editor" | "viewer">("editor");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pendingTrust, setPendingTrust] = useState<PendingSharingTrust | null>(null);
  const user = useAppStore((state) => state.user);
  const rootKey = useAppStore((state) => state.rootKey);
  const setAttachmentsByNote = useAppStore((state) => state.setAttachmentsByNote);
  const setError = useAppStore((state) => state.setError);
  const setNotes = useAppStore((state) => state.setNotes);
  const setRevocationRotationFailure = useAppStore(
    (state) => state.setRevocationRotationFailure
  );
  const setStatus = useAppStore((state) => state.setStatus);
  const revocationRotationFailure = useAppStore(
    (state) => state.revocationRotationFailure
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

  async function submitInvite() {
    if (selectedNote?.role !== "owner" || !username.trim()) {
      return;
    }

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
        setPendingTrust({
          publicKey,
          fingerprint: trust.fingerprint,
          role,
          username: username.trim()
        });
        setStatus("Confirm collaborator key");
        return;
      }
      await shareWithPublicKey(publicKey, role, username.trim());
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
        pendingTrust.publicKey,
        pendingTrust.role,
        pendingTrust.username
      );
      setPendingTrust(null);
    } catch (trustError) {
      setStatus("Share failed");
      setError(trustError instanceof Error ? trustError.message : "Unable to trust key");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function shareWithPublicKey(
    publicKey: PublicSharingKey,
    memberRole: "editor" | "viewer",
    collaboratorUsername: string
  ) {
    if (selectedNote?.role !== "owner") {
      return;
    }

    const encryptedNoteKey = await encryptNoteKeyShare({
      noteKeyBase64: selectedNote.noteKeyBase64,
      recipientPublicKey: publicKey.publicKey
    });
    await inviteNoteMember(selectedNote.id, {
      username: collaboratorUsername,
      role: memberRole,
      sharingKeyVersion: publicKey.sharingKeyVersion,
      encryptedNoteKey,
      formatVersion: 1
    });
    const payload = await listNoteMemberships(selectedNote.id);
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

    setError(null);
    try {
      await revokeNoteMember(selectedNote.id, member.userId);
      const payload = await listNoteMemberships(selectedNote.id);
      setMemberships(payload.memberships);
      try {
        await rotateAfterRevoke(selectedNote, payload.memberships, rootKey);
        setRevocationRotationFailure(null);
        setStatus("Collaborator revoked and keys rotated");
      } catch (rotationError) {
        const message =
          rotationError instanceof Error ? rotationError.message : "Key rotation failed";
        setRevocationRotationFailure({
          noteId: selectedNote.id,
          revokedUserId: member.userId,
          revokedUsername: member.username,
          message,
          failedAt: new Date().toISOString()
        });
        setStatus("Collaborator revoked");
        setError(`Key rotation failed: ${message}`);
      }
    } catch (revokeError) {
      setStatus("Revoke failed");
      setError(revokeError instanceof Error ? revokeError.message : "Unable to revoke");
    }
  }

  async function retryRevocationRotation() {
    if (
      selectedNote?.role !== "owner" ||
      !rootKey ||
      revocationRotationFailure?.noteId !== selectedNote.id
    ) {
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setStatus("Retrying key rotation");
    try {
      const payload = await listNoteMemberships(selectedNote.id);
      setMemberships(payload.memberships);
      await rotateAfterRevoke(selectedNote, payload.memberships, rootKey);
      setRevocationRotationFailure(null);
      setStatus("Keys rotated after revoke");
    } catch (rotationError) {
      const message =
        rotationError instanceof Error ? rotationError.message : "Key rotation failed";
      setRevocationRotationFailure({
        ...revocationRotationFailure,
        message,
        failedAt: new Date().toISOString()
      });
      setStatus("Key rotation failed");
      setError(`Key rotation failed: ${message}`);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function rotateAfterRevoke(
    note: DecryptedNote,
    nextMemberships: NoteMembership[],
    vaultRootKey: Uint8Array
  ) {
    const remainingMembers = nextMemberships.filter(
      (membership) => membership.status === "active" && membership.role !== "owner"
    );
    const attachments = await listAttachments(note.id).then((payload) => payload.attachments);
    const rotatedKey = await rotateNoteKeyMaterial({
      body: note.body,
      cryptoOwnerId: note.cryptoOwnerId,
      noteId: note.id,
      rootKey: vaultRootKey
    });
    const shares = await Promise.all(
      remainingMembers.map(async (membership) => {
        if (!user) {
          throw new Error("Vault is locked");
        }
        const publicKey = await lookupSharingKey(membership.username);
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
          encryptedNoteKey: await encryptNoteKeyShare({
            noteKeyBase64: rotatedKey.noteKeyBase64,
            recipientPublicKey: publicKey.publicKey
          }),
          formatVersion: 1
        };
      })
    );
    const attachmentKeys = await Promise.all(
      attachments.map((attachment) =>
        rewrapAttachmentKey({
          attachmentId: attachment.id,
          attachmentKeyNonce: attachment.attachmentKeyNonce,
          cryptoOwnerId: note.cryptoOwnerId,
          encryptedAttachmentKey: attachment.encryptedAttachmentKey,
          newNoteKeyBase64: rotatedKey.noteKeyBase64,
          noteId: note.id,
          oldNoteKeyBase64: note.noteKeyBase64
        })
      )
    );
    const rotated = await rotateNoteKey(note.id, {
      encryptedNoteKey: rotatedKey.encryptedNoteKey,
      noteKeyNonce: rotatedKey.noteKeyNonce,
      contentCipher: rotatedKey.contentCipher,
      contentNonce: rotatedKey.contentNonce,
      contentLength: rotatedKey.contentLength,
      version: note.version,
      shares,
      attachmentKeys
    });
    const rotatedAttachments = applyAttachmentKeyRotation(attachments, attachmentKeys);

    setNotes((current) =>
      current.map((currentNote) =>
        currentNote.id === note.id
          ? {
              ...currentNote,
              contentLength: rotatedKey.contentLength,
              noteKeyBase64: rotatedKey.noteKeyBase64,
              updatedAt: new Date().toISOString(),
              version: rotated.version
            }
          : currentNote
      )
    );
    setAttachmentsByNote((current) => ({
      ...current,
      [note.id]: rotatedAttachments
    }));
  }

  const canInvite = selectedNote?.role === "owner" && !disabled;
  const selectedRotationFailure =
    selectedNote && revocationRotationFailure?.noteId === selectedNote.id
      ? revocationRotationFailure
      : null;

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
              }}
            />
            <select
              aria-label="Collaborator role"
              value={role}
              onChange={(event) => {
                setRole(event.target.value as "editor" | "viewer");
                setPendingTrust(null);
              }}
            >
              <option value="editor">Editor</option>
              <option value="viewer">Viewer</option>
            </select>
            <button
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
            <div className="trust-confirmation">
              <span>
                <strong>{pendingTrust.publicKey.username}</strong>
                <code>{pendingTrust.fingerprint}</code>
              </span>
              <div>
                <button
                  className="text-button"
                  type="button"
                  disabled={isSubmitting}
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
                    setPendingTrust(null);
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
                  disabled={membership.status === "revoked"}
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

function applyAttachmentKeyRotation(
  attachments: AttachmentSummary[],
  attachmentKeys: {
    attachmentId: string;
    encryptedAttachmentKey: string;
    attachmentKeyNonce: string;
  }[]
): AttachmentSummary[] {
  const keysByAttachmentId = new Map(
    attachmentKeys.map((attachmentKey) => [attachmentKey.attachmentId, attachmentKey])
  );
  return attachments.map((attachment) => {
    const rotatedKey = keysByAttachmentId.get(attachment.id);
    return rotatedKey
      ? {
          ...attachment,
          encryptedAttachmentKey: rotatedKey.encryptedAttachmentKey,
          attachmentKeyNonce: rotatedKey.attachmentKeyNonce
        }
      : attachment;
  });
}
