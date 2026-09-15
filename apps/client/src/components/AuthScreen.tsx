import { useState } from "react";
import { normalizeAccountHandle } from "../api";
import { useAuthActions } from "../hooks/useAuthActions";
import { useAppStore, type AuthMode } from "../store/appStore";

interface AccountHandleFieldProps {
  username: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  showHint?: boolean;
}

function AccountHandleField({
  username,
  onChange,
  onBlur,
  showHint = false
}: AccountHandleFieldProps) {
  return (
    <>
      <label>
        Account handle
        <input
          autoCapitalize="none"
          autoComplete="username"
          value={username}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          onBlur={onBlur}
        />
      </label>
      {showHint ? (
        <p className="muted">
          Use 3–64 lowercase letters, numbers, dots, underscores, or hyphens.
        </p>
      ) : null}
    </>
  );
}

interface AuthNavigationProps {
  authMode: AuthMode;
  onSelect: (mode: AuthMode) => void;
}

function AuthNavigation({ authMode, onSelect }: AuthNavigationProps) {
  return (
    <nav className="auth-nav" aria-label="Authentication">
      <button
        className={authMode === "login" ? "current" : ""}
        type="button"
        aria-current={authMode === "login" ? "page" : undefined}
        onClick={() => {
          onSelect("login");
        }}
      >
        Sign in
      </button>
      <button
        className={authMode === "register" ? "current" : ""}
        type="button"
        aria-current={authMode === "register" ? "page" : undefined}
        onClick={() => {
          onSelect("register");
        }}
      >
        Create an account
      </button>
      <button
        className={authMode === "recover" ? "current" : ""}
        type="button"
        aria-current={authMode === "recover" ? "page" : undefined}
        onClick={() => {
          onSelect("recover");
        }}
      >
        Recover access
      </button>
    </nav>
  );
}

function LoginForm() {
  const username = useAppStore((state) => state.username);
  const password = useAppStore((state) => state.password);
  const setUsername = useAppStore((state) => state.setUsername);
  const setPassword = useAppStore((state) => state.setPassword);
  const { submitAuth } = useAuthActions();

  return (
    <form
      className="auth-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submitAuth();
      }}
    >
      <div className="auth-form-heading">
        <h2>Sign in</h2>
        <p>Unlock your encrypted vault with your account password.</p>
      </div>
      <AccountHandleField
        username={username}
        onChange={setUsername}
        onBlur={() => {
          setUsername(normalizeAccountHandle(username));
        }}
      />
      <label>
        Account password
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
        />
      </label>
      <button className="primary" type="submit">
        Sign in and decrypt
      </button>
    </form>
  );
}

function RegisterForm() {
  const username = useAppStore((state) => state.username);
  const password = useAppStore((state) => state.password);
  const setUsername = useAppStore((state) => state.setUsername);
  const setPassword = useAppStore((state) => state.setPassword);
  const { submitAuth } = useAuthActions();
  const [confirmPassword, setConfirmPassword] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  return (
    <form
      className="auth-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (password !== confirmPassword) {
          setValidationError("Passwords do not match");
          return;
        }
        setValidationError(null);
        void submitAuth();
      }}
    >
      <div className="auth-form-heading">
        <h2>Register</h2>
        <p>Create a new encrypted vault.</p>
      </div>
      <AccountHandleField
        username={username}
        onChange={setUsername}
        onBlur={() => {
          setUsername(normalizeAccountHandle(username));
        }}
        showHint
      />
      <label>
        Account password
        <input
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
        />
      </label>
      <label>
        Confirm password
        <input
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(event) => {
            setConfirmPassword(event.target.value);
            setValidationError(null);
          }}
        />
      </label>
      {validationError ? (
        <p className="error" role="alert">
          {validationError}
        </p>
      ) : null}
      <button className="primary" type="submit">
        Create encrypted vault
      </button>
    </form>
  );
}

function RecoverForm() {
  const username = useAppStore((state) => state.username);
  const recoveryInput = useAppStore((state) => state.recoveryInput);
  const recoveryNewPassword = useAppStore((state) => state.recoveryNewPassword);
  const setUsername = useAppStore((state) => state.setUsername);
  const setRecoveryInput = useAppStore((state) => state.setRecoveryInput);
  const setRecoveryNewPassword = useAppStore((state) => state.setRecoveryNewPassword);
  const { submitAuth } = useAuthActions();
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  return (
    <form
      className="auth-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (recoveryNewPassword !== confirmNewPassword) {
          setValidationError("Passwords do not match");
          return;
        }
        setValidationError(null);
        void submitAuth();
      }}
    >
      <div className="auth-form-heading">
        <h2>Recover account</h2>
        <p>Use your recovery key to set a new account password.</p>
      </div>
      <AccountHandleField
        username={username}
        onChange={setUsername}
        onBlur={() => {
          setUsername(normalizeAccountHandle(username));
        }}
      />
      <label>
        Recovery key
        <input
          autoComplete="one-time-code"
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
          autoComplete="new-password"
          value={recoveryNewPassword}
          onChange={(event) => {
            setRecoveryNewPassword(event.target.value);
          }}
        />
      </label>
      <label>
        Confirm new password
        <input
          type="password"
          autoComplete="new-password"
          value={confirmNewPassword}
          onChange={(event) => {
            setConfirmNewPassword(event.target.value);
            setValidationError(null);
          }}
        />
      </label>
      {validationError ? (
        <p className="error" role="alert">
          {validationError}
        </p>
      ) : null}
      <button className="primary" type="submit">
        Recover and decrypt
      </button>
    </form>
  );
}

export function AuthScreen() {
  const authMode = useAppStore((state) => state.authMode);
  const recoverySecret = useAppStore((state) => state.recoverySecret);
  const error = useAppStore((state) => state.error);
  const status = useAppStore((state) => state.status);
  const setAuthMode = useAppStore((state) => state.setAuthMode);
  const setError = useAppStore((state) => state.setError);
  const setStatus = useAppStore((state) => state.setStatus);
  const { copyRecoverySecret } = useAuthActions();

  function selectAuthMode(mode: AuthMode) {
    setAuthMode(mode);
    setError(null);
    setStatus("Signed out");
  }

  return (
    <main className="auth-screen">
      <section className="auth-panel">
        <div className="brand-row">
          <div className="brand-mark">FN</div>
          <div>
            <h1>Fortnote</h1>
            <p>One password signs in and decrypts your vault locally.</p>
          </div>
        </div>

        <AuthNavigation authMode={authMode} onSelect={selectAuthMode} />
        {authMode === "login" ? (
          <LoginForm />
        ) : authMode === "register" ? (
          <RegisterForm />
        ) : (
          <RecoverForm />
        )}

        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        <p
          className="muted"
          role={status.toLowerCase().includes("handle repair") ? "alert" : undefined}
        >
          {status}
        </p>
        {recoverySecret ? (
          <div className="recovery-code">
            <output aria-label="Recovery key">{recoverySecret}</output>
            <button
              type="button"
              onClick={() => {
                void copyRecoverySecret();
              }}
            >
              Copy recovery key
            </button>
          </div>
        ) : null}
      </section>
    </main>
  );
}
