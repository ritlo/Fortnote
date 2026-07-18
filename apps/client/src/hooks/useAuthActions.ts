import { useEffect } from "react";
import {
  cleanupRetiredSharingKeys,
  getAuthKdfParams,
  getCurrentSharingKey,
  getKeyMaterial,
  getMe,
  getRecoveryParams,
  login,
  logout,
  normalizeAccountHandle,
  repairAccountHandle,
  recover,
  register,
  storeCurrentSharingKey,
  updateKeyMaterial
} from "../api";
import {
  createAccountRecoveryCrypto,
  createLoginAuthVerifier,
  createPasswordChangeCrypto,
  createRegistrationCrypto,
  createRecoveryRotationCrypto,
  createUserSharingKey,
  openVault
} from "../cryptoClient";
import { authKdf, recoveryKdf, vaultKdf } from "../lib/keyMaterial";
import { useAppStore } from "../store/appStore";
import { ensureSharingKey, loadDecryptedNotes, loadFolders } from "./useAppData";

export function useSessionBootstrap() {
  const setUsername = useAppStore((state) => state.setUsername);
  const setStatus = useAppStore((state) => state.setStatus);

  useEffect(() => {
    void getMe()
      .then((currentUser) => {
        setUsername(currentUser.username);
        setStatus(
          currentUser.handleState === "repair-required"
            ? "Handle repair required. Sign in again, then choose a unique handle before sharing"
            : "Session active. Sign in again to renew and decrypt"
        );
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
  const recoverySecret = useAppStore((state) => state.recoverySecret);
  const rootKey = useAppStore((state) => state.rootKey);
  const setUsername = useAppStore((state) => state.setUsername);
  const setUser = useAppStore((state) => state.setUser);
  const setRootKey = useAppStore((state) => state.setRootKey);
  const setKeyMaterialVersion = useAppStore((state) => state.setKeyMaterialVersion);
  const setPassword = useAppStore((state) => state.setPassword);
  const setNewPassword = useAppStore((state) => state.setNewPassword);
  const setRecoveryInput = useAppStore((state) => state.setRecoveryInput);
  const setRecoveryNewPassword = useAppStore((state) => state.setRecoveryNewPassword);
  const setRecoverySecret = useAppStore((state) => state.setRecoverySecret);
  const setOpenedSharingKey = useAppStore((state) => state.setOpenedSharingKey);
  const setError = useAppStore((state) => state.setError);
  const setStatus = useAppStore((state) => state.setStatus);
  const resetVaultState = useAppStore((state) => state.resetVaultState);

  async function submitAuth() {
    setError(null);
    setRecoverySecret(null);
    setStatus("Deriving keys");
    try {
      const accountHandle = normalizeAccountHandle(username);
      if (authMode === "register") {
        const registration = await createRegistrationCrypto(accountHandle, password);
        const currentUser = await register(registration.payload);
        setUser(currentUser);
        setRootKey(registration.rootKey);
        setKeyMaterialVersion(1);
        setRecoverySecret(registration.recoverySecret);
        setStatus("Loading vault");
        await ensureSharingKey(registration.rootKey);
        await loadFolders();
        await loadDecryptedNotes(currentUser, registration.rootKey);
        setPassword("");
        setStatus(authenticatedStatus(currentUser, "Signed in and decrypted"));
        return;
      }

      if (authMode === "recover") {
        const recoveryParams = await getRecoveryParams(accountHandle);
        const recovery = await createAccountRecoveryCrypto({
          recoverySecret: recoveryInput,
          recoveryKdf: recoveryKdf(recoveryParams),
          recoveryEncryptedRootKey: recoveryParams.recoveryEncryptedRootKey,
          recoveryRootKeyNonce: recoveryParams.recoveryRootKeyNonce,
          newPassword: recoveryNewPassword
        });
        const currentUser = await recover({
          username: accountHandle,
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
        setPassword("");
        setRecoveryInput("");
        setRecoveryNewPassword("");
        setStatus("Loading vault");
        await ensureSharingKey(recovery.rootKey);
        await loadFolders();
        await loadDecryptedNotes(currentUser, recovery.rootKey);
        setStatus(authenticatedStatus(currentUser, "Recovered and decrypted"));
        return;
      }

      const kdf = await getAuthKdfParams(accountHandle);
      const authVerifier = await createLoginAuthVerifier(password, authKdf(kdf));
      const currentUser = await login(accountHandle, authVerifier);
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
      setStatus("Loading vault");
      await ensureSharingKey(openedVault.rootKey);
      await loadFolders();
      await loadDecryptedNotes(currentUser, openedVault.rootKey);
      setPassword("");
      setStatus(authenticatedStatus(currentUser, "Signed in and decrypted"));
    } catch (authError) {
      setStatus("Auth failed");
      setError(authError instanceof Error ? authError.message : "Unable to sign in");
    }
  }

  async function submitLogout() {
    await logout();
    resetVaultState("Signed out");
  }

  async function repairLegacyHandle(handle: string) {
    setError(null);
    setStatus("Repairing account handle");
    try {
      const currentUser = await repairAccountHandle(handle);
      setUser(currentUser);
      setUsername(currentUser.username);
      setStatus("Account handle repaired");
    } catch (repairError) {
      setStatus("Handle repair failed");
      setError(
        repairError instanceof Error ? repairError.message : "Unable to repair account handle"
      );
    }
  }

  async function copyRecoverySecret() {
    if (!recoverySecret) {
      return;
    }
    try {
      await navigator.clipboard.writeText(recoverySecret);
      setStatus("Recovery key copied. Store it somewhere private and offline");
    } catch {
      setError("Unable to copy the recovery key. Select and copy it manually");
    }
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
      setPassword("");
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

  async function rotateSharingKey() {
    if (!rootKey) {
      return;
    }

    setError(null);
    setStatus("Rotating sharing key");
    try {
      const current = await getCurrentSharingKey();
      const created = await createUserSharingKey(rootKey, current.sharingKeyVersion + 1);
      await storeCurrentSharingKey(created.payload);
      setOpenedSharingKey(created.opened);
      setStatus("Sharing key rotated");
    } catch (rotateError) {
      setStatus("Sharing key rotation failed");
      setError(
        rotateError instanceof Error ? rotateError.message : "Unable to rotate sharing key"
      );
    }
  }

  async function cleanupSharingKeys() {
    setError(null);
    setStatus("Cleaning up sharing keys");
    try {
      const result = await cleanupRetiredSharingKeys();
      setStatus(
        result.deleted > 0
          ? `Cleaned up ${String(result.deleted)} sharing key${result.deleted === 1 ? "" : "s"}`
          : "No retired sharing keys to clean up"
      );
    } catch (cleanupError) {
      setStatus("Sharing key cleanup failed");
      setError(
        cleanupError instanceof Error ? cleanupError.message : "Unable to clean up sharing keys"
      );
    }
  }

  return {
    changePassword,
    cleanupSharingKeys,
    copyRecoverySecret,
    lockVault,
    repairLegacyHandle,
    rotateRecoveryKey,
    rotateSharingKey,
    submitAuth,
    submitLogout
  };
}

function authenticatedStatus(user: { handleState?: string }, ready: string): string {
  return user.handleState === "repair-required"
    ? "Handle repair required before sharing. Open settings to choose a unique handle"
    : ready;
}
