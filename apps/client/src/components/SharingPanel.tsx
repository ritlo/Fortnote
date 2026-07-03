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
  type PresenceUser
} from "../api";
import {
  encryptNoteKeyShare,
  rewrapAttachmentKey,
  rotateNoteKeyMaterial
} from "../cryptoClient";
import type { DecryptedNote } from "../store/appStore";
import { useAppStore } from "../store/appStore";

interface SharingPanelProps {
  selectedNote: DecryptedNote | null;
  disabled: boolean;
}

const EMPTY_PRESENCE: PresenceUser[] = [];

export function SharingPanel({ selectedNote, disabled }: SharingPanelProps) {
  const [memberships, setMemberships] = useState<NoteMembership[]>([]);
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<"editor" | "viewer">("editor");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const rootKey = useAppStore((state) => state.rootKey);
  const setAttachmentsByNote = useAppStore((state) => state.setAttachmentsByNote);
  const setError = useAppStore((state) => state.setError);
  const setNotes = useAppStore((state) => state.setNotes);
  const setStatus = useAppStore((state) => state.setStatus);
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
      const encryptedNoteKey = await encryptNoteKeyShare({
        noteKeyBase64: selectedNote.noteKeyBase64,
        recipientPublicKey: publicKey.publicKey
      });
      await inviteNoteMember(selectedNote.id, {
        username: username.trim(),
        role,
        sharingKeyVersion: publicKey.sharingKeyVersion,
        encryptedNoteKey,
        formatVersion: 1
      });
      const payload = await listNoteMemberships(selectedNote.id);
      setMemberships(payload.memberships);
      setUsername("");
      setStatus("Note shared");
    } catch (inviteError) {
      setStatus("Share failed");
      setError(inviteError instanceof Error ? inviteError.message : "Unable to share note");
    } finally {
      setIsSubmitting(false);
    }
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
        setStatus("Collaborator revoked and keys rotated");
      } catch (rotationError) {
        setStatus("Collaborator revoked");
        setError(
          rotationError instanceof Error
            ? `Key rotation failed: ${rotationError.message}`
            : "Key rotation failed"
        );
      }
    } catch (revokeError) {
      setStatus("Revoke failed");
      setError(revokeError instanceof Error ? revokeError.message : "Unable to revoke");
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
        const publicKey = await lookupSharingKey(membership.username);
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

  return (
    <section className="sharing-panel">
      <div className="section-title">
        <Share2 size={16} />
        <h3>Sharing</h3>
      </div>
      {canInvite ? (
        <div className="share-form">
          <input
            aria-label="Collaborator username"
            placeholder="Username"
            value={username}
            onChange={(event) => {
              setUsername(event.target.value);
            }}
          />
          <select
            aria-label="Collaborator role"
            value={role}
            onChange={(event) => {
              setRole(event.target.value as "editor" | "viewer");
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
