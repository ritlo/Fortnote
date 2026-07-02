import { useEffect, useState } from "react";
import { Share2, UserPlus } from "lucide-react";
import {
  inviteNoteMember,
  listNoteMemberships,
  lookupSharingKey,
  type NoteMembership
} from "../api";
import { encryptNoteKeyShare } from "../cryptoClient";
import type { DecryptedNote } from "../store/appStore";
import { useAppStore } from "../store/appStore";

interface SharingPanelProps {
  selectedNote: DecryptedNote | null;
  disabled: boolean;
}

export function SharingPanel({ selectedNote, disabled }: SharingPanelProps) {
  const [memberships, setMemberships] = useState<NoteMembership[]>([]);
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<"editor" | "viewer">("editor");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const setError = useAppStore((state) => state.setError);
  const setStatus = useAppStore((state) => state.setStatus);

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
              <small>{membership.status}</small>
            </span>
            <small>{membership.role}</small>
          </li>
        ))}
      </ul>
    </section>
  );
}
