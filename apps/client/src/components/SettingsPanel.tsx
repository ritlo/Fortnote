import { useEffect, useState } from "react";
import { fingerprintPublicSharingKey } from "../lib/sharingKeyTrust";
import { useAppStore } from "../store/appStore";

interface SettingsPanelProps {
  newPassword: string;
  recoverySecret: string | null;
  changePassword: () => Promise<void>;
  cleanupSharingKeys: () => Promise<void>;
  rotateRecoveryKey: () => Promise<void>;
  rotateSharingKey: () => Promise<void>;
  setNewPassword: (value: string) => void;
}

export function SettingsPanel({
  newPassword,
  recoverySecret,
  changePassword,
  cleanupSharingKeys,
  rotateRecoveryKey,
  rotateSharingKey,
  setNewPassword
}: SettingsPanelProps) {
  const openedSharingKey = useAppStore((state) => state.openedSharingKey);
  const setError = useAppStore((state) => state.setError);
  const setStatus = useAppStore((state) => state.setStatus);
  const [sharingFingerprint, setSharingFingerprint] = useState<string | null>(null);
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const passwordsMismatch =
    passwordConfirmation.length > 0 && newPassword !== passwordConfirmation;

  useEffect(() => {
    if (!newPassword) {
      setPasswordConfirmation("");
    }
  }, [newPassword]);

  useEffect(() => {
    let isActive = true;
    setSharingFingerprint(null);
    if (!openedSharingKey) {
      return;
    }
    void fingerprintPublicSharingKey(openedSharingKey.publicKey)
      .then((fingerprint) => {
        if (isActive) {
          setSharingFingerprint(fingerprint);
        }
      })
      .catch(() => {
        if (isActive) {
          setError("Unable to calculate the sharing fingerprint");
        }
      });
    return () => {
      isActive = false;
    };
  }, [openedSharingKey, setError]);

  async function copySharingFingerprint() {
    if (!sharingFingerprint) {
      return;
    }
    try {
      await navigator.clipboard.writeText(sharingFingerprint);
      setStatus("Sharing fingerprint copied");
    } catch {
      setError("Unable to copy the sharing fingerprint. Select and copy it manually");
    }
  }

  return (
    <div className="settings-panel">
      <section>
        <h3>Account password</h3>
        <label>
          New password
          <input
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => {
              setNewPassword(event.target.value);
            }}
          />
        </label>
        <label>
          Confirm new password
          <input
            type="password"
            autoComplete="new-password"
            value={passwordConfirmation}
            onChange={(event) => {
              setPasswordConfirmation(event.target.value);
            }}
            aria-invalid={passwordsMismatch}
          />
        </label>
        {passwordsMismatch ? (
          <p className="error" role="alert">
            Passwords do not match
          </p>
        ) : null}
        <button
          className="primary"
          type="button"
          disabled={!newPassword.trim() || newPassword !== passwordConfirmation}
          onClick={() => {
            void changePassword();
          }}
        >
          Change password
        </button>
      </section>
      <section>
        <h3>Recovery key</h3>
        <button
          className="text-button"
          type="button"
          onClick={() => {
            void rotateRecoveryKey();
          }}
        >
          Rotate recovery key
        </button>
        {recoverySecret ? (
          <p className="recovery-code">Recovery key: {recoverySecret}</p>
        ) : null}
      </section>
      <section>
        <h3>Sharing key</h3>
        {openedSharingKey && sharingFingerprint ? (
          <div className="sharing-fingerprint">
            <small>Sharing key version {openedSharingKey.sharingKeyVersion}</small>
            <code>{sharingFingerprint}</code>
            <p>
              Ask collaborators to compare this exact fingerprint through an independent
              channel.
            </p>
            <button
              className="text-button"
              type="button"
              aria-label="Copy sharing fingerprint"
              onClick={() => {
                void copySharingFingerprint();
              }}
            >
              Copy fingerprint
            </button>
          </div>
        ) : null}
        <button
          className="text-button"
          type="button"
          onClick={() => {
            void rotateSharingKey();
          }}
        >
          Rotate sharing key
        </button>
        <button
          className="text-button"
          type="button"
          onClick={() => {
            void cleanupSharingKeys();
          }}
        >
          Clean up old sharing keys
        </button>
      </section>
    </div>
  );
}
