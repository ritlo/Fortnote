import { useAuthActions } from "../hooks/useAuthActions";
import { useAppStore } from "../store/appStore";

export function AuthScreen() {
  const authMode = useAppStore((state) => state.authMode);
  const username = useAppStore((state) => state.username);
  const password = useAppStore((state) => state.password);
  const recoveryInput = useAppStore((state) => state.recoveryInput);
  const recoveryNewPassword = useAppStore((state) => state.recoveryNewPassword);
  const recoverySecret = useAppStore((state) => state.recoverySecret);
  const error = useAppStore((state) => state.error);
  const status = useAppStore((state) => state.status);
  const setAuthMode = useAppStore((state) => state.setAuthMode);
  const setUsername = useAppStore((state) => state.setUsername);
  const setPassword = useAppStore((state) => state.setPassword);
  const setRecoveryInput = useAppStore((state) => state.setRecoveryInput);
  const setRecoveryNewPassword = useAppStore((state) => state.setRecoveryNewPassword);
  const { submitAuth } = useAuthActions();

  return (
    <main className="auth-screen">
      <section className="auth-panel">
        <div className="brand-row">
          <div className="brand-mark">CN</div>
          <div>
            <h1>Fortnote</h1>
            <p>One password signs in and decrypts your vault locally.</p>
          </div>
        </div>

        <div className="segmented">
          <button
            className={authMode === "login" ? "active" : ""}
            type="button"
            onClick={() => {
              setAuthMode("login");
            }}
          >
            Sign in
          </button>
          <button
            className={authMode === "register" ? "active" : ""}
            type="button"
            onClick={() => {
              setAuthMode("register");
            }}
          >
            Register
          </button>
          <button
            className={authMode === "recover" ? "active" : ""}
            type="button"
            onClick={() => {
              setAuthMode("recover");
            }}
          >
            Recover
          </button>
        </div>

        <label>
          Username
          <input
            value={username}
            onChange={(event) => {
              setUsername(event.target.value);
            }}
          />
        </label>
        {authMode === "recover" ? (
          <>
            <label>
              Recovery key
              <input
                value={recoveryInput}
                onChange={(event) => {
                  setRecoveryInput(event.target.value);
                }}
              />
            </label>
            <label>
              New account password
              <input
                type="password"
                value={recoveryNewPassword}
                onChange={(event) => {
                  setRecoveryNewPassword(event.target.value);
                }}
              />
            </label>
          </>
        ) : (
          <label>
            Account password
            <input
              type="password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
            />
          </label>
        )}

        {error ? <p className="error">{error}</p> : null}
        <button
          className="primary"
          type="button"
          onClick={() => {
            void submitAuth();
          }}
        >
          {authMode === "register"
            ? "Create encrypted vault"
            : authMode === "recover"
              ? "Recover and decrypt"
              : "Sign in and decrypt"}
        </button>
        <p className="muted">{status}</p>
        {recoverySecret ? (
          <p className="recovery-code">Recovery key: {recoverySecret}</p>
        ) : null}
      </section>
    </main>
  );
}
