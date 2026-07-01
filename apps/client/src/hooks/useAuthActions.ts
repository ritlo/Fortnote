import { useEffect } from "react";
import {
  getAuthKdfParams,
  getKeyMaterial,
  getMe,
  getRecoveryParams,
  login,
  logout,
  recover,
  register,
  updateKeyMaterial
} from "../api";
import {
  createAccountRecoveryCrypto,
  createLoginAuthVerifier,
  createPasswordChangeCrypto,
  createRegistrationCrypto,
  createRecoveryRotationCrypto,
  openVault
} from "../cryptoClient";
import { authKdf, recoveryKdf, vaultKdf } from "../lib/keyMaterial";
import { useAppStore } from "../store/appStore";
import { loadDecryptedNotes, loadFolders } from "./useAppData";

export function useSessionBootstrap() {
  const setUsername = useAppStore((state) => state.setUsername);
  const setStatus = useAppStore((state) => state.setStatus);

  useEffect(() => {
    void getMe()
      .then((currentUser) => {
        setUsername(currentUser.username);
        setStatus("Session active. Sign in again to decrypt");
      })
      .catch(() => {
        setStatus("Signed out");
      });
  }, [setStatus, setUsername]);
}

export function useAuthActions() {
  const authMode = useAppStore((state) => state.authMode);
  const username = useAppStore((state) => state.username);
  const password = useAppStore((state) => state.password);
  const newPassword = useAppStore((state) => state.newPassword);
  const recoveryInput = useAppStore((state) => state.recoveryInput);
  const recoveryNewPassword = useAppStore((state) => state.recoveryNewPassword);
  const rootKey = useAppStore((state) => state.rootKey);
  const setUser = useAppStore((state) => state.setUser);
  const setRootKey = useAppStore((state) => state.setRootKey);
  const setKeyMaterialVersion = useAppStore((state) => state.setKeyMaterialVersion);
  const setPassword = useAppStore((state) => state.setPassword);
  const setNewPassword = useAppStore((state) => state.setNewPassword);
  const setRecoveryInput = useAppStore((state) => state.setRecoveryInput);
  const setRecoveryNewPassword = useAppStore((state) => state.setRecoveryNewPassword);
  const setRecoverySecret = useAppStore((state) => state.setRecoverySecret);
  const setError = useAppStore((state) => state.setError);
  const setStatus = useAppStore((state) => state.setStatus);
  const resetVaultState = useAppStore((state) => state.resetVaultState);

  async function submitAuth() {
    setError(null);
    setRecoverySecret(null);
    setStatus("Deriving keys");
    try {
      if (authMode === "register") {
        const registration = await createRegistrationCrypto(username, password);
        const currentUser = await register(registration.payload);
        setUser(currentUser);
        setRootKey(registration.rootKey);
        setKeyMaterialVersion(1);
        setRecoverySecret(registration.recoverySecret);
        setStatus("Signed in and decrypted");
        await loadFolders();
        await loadDecryptedNotes(currentUser, registration.rootKey);
        return;
      }

      if (authMode === "recover") {
        const recoveryParams = await getRecoveryParams(username);
        const recovery = await createAccountRecoveryCrypto({
          recoverySecret: recoveryInput,
          recoveryKdf: recoveryKdf(recoveryParams),
          recoveryEncryptedRootKey: recoveryParams.recoveryEncryptedRootKey,
          recoveryRootKeyNonce: recoveryParams.recoveryRootKeyNonce,
          newPassword: recoveryNewPassword
        });
        const currentUser = await recover({
          username,
          recoveryAuthVerifier: recovery.recoveryAuthVerifier,
          newAuthVerifier: recovery.passwordChange.authVerifier,
          authKdf: recovery.passwordChange.authKdf,
          vaultKdf: recovery.passwordChange.vaultKdf,
          encryptedRootKey: recovery.passwordChange.encryptedRootKey,
          rootKeyNonce: recovery.passwordChange.rootKeyNonce,
          keyMaterialVersion: recoveryParams.keyMaterialVersion
        });
        setUser(currentUser);
        setRootKey(recovery.rootKey);
        setKeyMaterialVersion(recoveryParams.keyMaterialVersion + 1);
        setPassword(recoveryNewPassword);
        setRecoveryInput("");
        setRecoveryNewPassword("");
        setStatus("Recovered and decrypted");
        await loadFolders();
        await loadDecryptedNotes(currentUser, recovery.rootKey);
        return;
      }

      const kdf = await getAuthKdfParams(username);
      const authVerifier = await createLoginAuthVerifier(password, authKdf(kdf));
      const currentUser = await login(username, authVerifier);
      const keyMaterial = await getKeyMaterial();
      const openedVault = await openVault(
        password,
        authKdf(kdf),
        vaultKdf(keyMaterial),
        keyMaterial.encryptedRootKey,
        keyMaterial.rootKeyNonce
      );
      setUser(currentUser);
      setRootKey(openedVault.rootKey);
      setKeyMaterialVersion(keyMaterial.keyMaterialVersion);
      setStatus("Signed in and decrypted");
      await loadFolders();
      await loadDecryptedNotes(currentUser, openedVault.rootKey);
    } catch (authError) {
      setStatus("Auth failed");
      setError(authError instanceof Error ? authError.message : "Unable to sign in");
    }
  }

  async function submitLogout() {
    await logout();
    resetVaultState("Signed out");
  }

  function lockVault() {
    resetVaultState("Vault locked. Sign in again to decrypt");
  }

  async function changePassword() {
    if (!rootKey || !newPassword.trim()) {
      return;
    }

    setError(null);
    setStatus("Rewrapping vault");
    try {
      const current = await getKeyMaterial();
      const rewrapped = await createPasswordChangeCrypto(rootKey, newPassword);
      const updated = await updateKeyMaterial({
        newAuthVerifier: rewrapped.authVerifier,
        authKdf: rewrapped.authKdf,
        encryptedRootKey: rewrapped.encryptedRootKey,
        rootKeyNonce: rewrapped.rootKeyNonce,
        vaultKdf: rewrapped.vaultKdf,
        keyMaterialVersion: current.keyMaterialVersion
      });
      setKeyMaterialVersion(updated.keyMaterialVersion);
      setPassword(newPassword);
      setNewPassword("");
      setStatus("Password changed and vault rewrapped");
    } catch (changeError) {
      setStatus("Password change failed");
      setError(
        changeError instanceof Error ? changeError.message : "Unable to change password"
      );
    }
  }

  async function rotateRecoveryKey() {
    if (!rootKey) {
      return;
    }

    setError(null);
    setStatus("Rotating recovery key");
    try {
      const current = await getKeyMaterial();
      const rotated = await createRecoveryRotationCrypto(rootKey);
      const updated = await updateKeyMaterial({
        encryptedRootKey: current.encryptedRootKey,
        rootKeyNonce: current.rootKeyNonce,
        vaultKdf: vaultKdf(current),
        recoveryAuthVerifier: rotated.recoveryAuthVerifier,
        recoveryKdf: rotated.recoveryKdf,
        recoveryEncryptedRootKey: rotated.recoveryEncryptedRootKey,
        recoveryRootKeyNonce: rotated.recoveryRootKeyNonce,
        keyMaterialVersion: current.keyMaterialVersion
      });
      setKeyMaterialVersion(updated.keyMaterialVersion);
      setRecoverySecret(rotated.recoverySecret);
      setStatus("Recovery key rotated");
    } catch (rotateError) {
      setStatus("Recovery rotation failed");
      setError(
        rotateError instanceof Error ? rotateError.message : "Unable to rotate recovery key"
      );
    }
  }

  return {
    changePassword,
    lockVault,
    rotateRecoveryKey,
    submitAuth,
    submitLogout
  };
}
