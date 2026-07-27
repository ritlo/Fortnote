import { useEffect, useRef } from "react";
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
import {
  authKdf,
  migrateRootKeyEnvelopeV2,
  recoveryKdf,
  vaultKdf
} from "../lib/keyMaterial";
import { openFortnoteIndexedDb, type FortnoteIndexedDb } from "../lib/indexedDb";
import { removeSharingKeyTrustRecords } from "../lib/sharingKeyTrust";
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
  const user = useAppStore((state) => state.user);
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
  const authSubmissionRef = useRef(false);

  async function submitAuth() {
    if (authSubmissionRef.current) {
      return;
    }
    authSubmissionRef.current = true;
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
        let registeredKeyMaterialVersion = 1;
        try {
          registeredKeyMaterialVersion = await migrateRootKeyEnvelopeV2({
            userId: currentUser.id,
            rootKey: registration.rootKey,
            vaultKey: registration.vaultKey,
            vaultKdf: registration.payload.vaultKdf,
            keyMaterialVersion: 1,
            rootKeyFormatVersion: 1
          });
        } catch {
          // Registration remains usable; the next unlock retries the v2 envelope write.
        }
        setKeyMaterialVersion(registeredKeyMaterialVersion);
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
          ...(recoveryParams.recoveryRootKeyFormatVersion !== undefined
            ? {
                recoveryRootKeyFormatVersion:
                  recoveryParams.recoveryRootKeyFormatVersion
              }
            : {}),
          ...(recoveryParams.recoveryRootKeyContextVersion !== undefined
            ? {
                recoveryRootKeyContextVersion:
                  recoveryParams.recoveryRootKeyContextVersion
              }
            : {}),
          ...(recoveryParams.userId ? { userId: recoveryParams.userId } : {}),
          nextKeyMaterialVersion: recoveryParams.keyMaterialVersion + 1,
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
          rootKeyFormatVersion: recovery.passwordChange.rootKeyFormatVersion,
          rootKeyContextVersion: recovery.passwordChange.rootKeyContextVersion,
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
        keyMaterial.rootKeyNonce,
        {
          userId: currentUser.id,
          formatVersion: keyMaterial.rootKeyFormatVersion ?? 1,
          contextVersion:
            keyMaterial.rootKeyContextVersion ?? keyMaterial.keyMaterialVersion
        }
      );
      setUser(currentUser);
      setRootKey(openedVault.rootKey);
      let currentKeyMaterialVersion = keyMaterial.keyMaterialVersion;
      try {
        currentKeyMaterialVersion = await migrateRootKeyEnvelopeV2({
          userId: currentUser.id,
          rootKey: openedVault.rootKey,
          vaultKey: openedVault.vaultKey,
          vaultKdf: vaultKdf(keyMaterial),
          keyMaterialVersion: keyMaterial.keyMaterialVersion,
          rootKeyFormatVersion: keyMaterial.rootKeyFormatVersion ?? 1
        });
      } catch {
        // The v1 read succeeded; keep the vault open and retry migration next unlock.
      }
      setKeyMaterialVersion(currentKeyMaterialVersion);
      setStatus("Loading vault");
      await ensureSharingKey(openedVault.rootKey);
      await loadFolders();
      await loadDecryptedNotes(currentUser, openedVault.rootKey);
      setPassword("");
      setStatus(authenticatedStatus(currentUser, "Signed in and decrypted"));
    } catch (authError) {
      setStatus("Auth failed");
      setError(authError instanceof Error ? authError.message : "Unable to sign in");
    } finally {
      authSubmissionRef.current = false;
    }
  }

  async function submitLogout() {
    const userId = user?.id;
    let database: FortnoteIndexedDb | null = null;

    if (userId) {
      try {
        database = await openFortnoteIndexedDb();
        const [outbox, sectionCache] = await Promise.all([
          database.listOutbox(userId),
          database.listSectionCache(userId)
        ]);
        const recoverableItems =
          outbox.length + sectionCache.filter((record) => record.pending).length;
        if (
          recoverableItems > 0 &&
          !window.confirm(
            `This browser has ${String(recoverableItems)} recoverable offline change${recoverableItems === 1 ? "" : "s"}. Signing out removes that local work. Continue?`
          )
        ) {
          database.close();
          return;
        }
      } catch {
        database?.close();
        database = null;
        if (
          !window.confirm(
            "Fortnote could not inspect recoverable offline work. Sign out and clear local account data anyway?"
          )
        ) {
          return;
        }
      }
    }

    setError(null);
    setStatus("Signing out");
    let logoutFailure: unknown;
    let cleanupFailure: unknown;
    try {
      await logout();
    } catch (error) {
      logoutFailure = error;
    }

    if (userId) {
      try {
        database ??= await openFortnoteIndexedDb();
        await database.clearAccount(userId);
      } catch (error) {
        cleanupFailure = error;
      } finally {
        try {
          removeSharingKeyTrustRecords(userId);
        } catch (error) {
          cleanupFailure ??= error;
        }
        database?.close();
      }
    }

    const nextStatus = logoutFailure
      ? "Vault cleared locally; server sign-out failed"
      : cleanupFailure
        ? "Signed out; local cleanup incomplete"
        : "Signed out";
    resetVaultState(nextStatus);
    if (logoutFailure) {
      setError("The decrypted vault was cleared, but the server session may still be active");
    } else if (cleanupFailure) {
      setError("Signed out, but some encrypted browser data could not be removed");
    }
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
    if (!rootKey || !user || !newPassword.trim()) {
      return;
    }

    setError(null);
    setStatus("Rewrapping vault");
    try {
      const current = await getKeyMaterial();
      const rewrapped = await createPasswordChangeCrypto(rootKey, newPassword, {
        userId: user.id,
        keyMaterialVersion: current.keyMaterialVersion + 1
      });
      const updated = await updateKeyMaterial({
        newAuthVerifier: rewrapped.authVerifier,
        authKdf: rewrapped.authKdf,
        encryptedRootKey: rewrapped.encryptedRootKey,
        rootKeyNonce: rewrapped.rootKeyNonce,
        rootKeyFormatVersion: rewrapped.rootKeyFormatVersion,
        rootKeyContextVersion: rewrapped.rootKeyContextVersion,
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
    if (!rootKey || !user) {
      return;
    }

    setError(null);
    setStatus("Rotating recovery key");
    try {
      const current = await getKeyMaterial();
      const rotated = await createRecoveryRotationCrypto(rootKey, {
        userId: user.id,
        keyMaterialVersion: current.keyMaterialVersion + 1
      });
      const updated = await updateKeyMaterial({
        encryptedRootKey: current.encryptedRootKey,
        rootKeyNonce: current.rootKeyNonce,
        rootKeyFormatVersion: current.rootKeyFormatVersion ?? 1,
        rootKeyContextVersion:
          current.rootKeyContextVersion ?? current.keyMaterialVersion,
        vaultKdf: vaultKdf(current),
        recoveryAuthVerifier: rotated.recoveryAuthVerifier,
        recoveryKdf: rotated.recoveryKdf,
        recoveryEncryptedRootKey: rotated.recoveryEncryptedRootKey,
        recoveryRootKeyNonce: rotated.recoveryRootKeyNonce,
        recoveryRootKeyFormatVersion: rotated.recoveryRootKeyFormatVersion,
        recoveryRootKeyContextVersion: rotated.recoveryRootKeyContextVersion,
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
    if (!rootKey || !user) {
      return;
    }

    setError(null);
    setStatus("Rotating sharing key");
    try {
      const current = await getCurrentSharingKey();
      const created = await createUserSharingKey(
        rootKey,
        current.sharingKeyVersion + 1,
        user.id
      );
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
