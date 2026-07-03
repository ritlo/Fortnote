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
  return (
    <div className="settings-panel">
      <section>
        <h3>Account password</h3>
        <label>
          New password
          <input
            type="password"
            value={newPassword}
            onChange={(event) => {
              setNewPassword(event.target.value);
            }}
          />
        </label>
        <button
          className="primary"
          type="button"
          disabled={!newPassword.trim()}
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
