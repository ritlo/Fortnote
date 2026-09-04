import type {
  AuthKdfResponse,
  KeyMaterialResponse,
  PublicSharingKey,
  RecoverPayload,
  RecoveryParamsResponse,
  RegisterPayload,
  SharingKeyEnvelope,
  StoreSharingKeyPayload,
  UpdateKeyMaterialPayload,
  User
} from "./contracts";
import { apiRequest } from "./http";

const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{1,62}[a-z0-9])$/u;

export function getMe(): Promise<User> {
  return apiRequest<User>("/auth/me");
}

export function normalizeAccountHandle(value: string): string {
  const canonical = value.trim().toLowerCase();
  return HANDLE_PATTERN.test(canonical) ? canonical : value;
}

export function getAuthKdfParams(username: string): Promise<AuthKdfResponse> {
  return apiRequest<AuthKdfResponse>(
    `/auth/kdf-params?username=${encodeURIComponent(username)}`
  );
}

export function getRecoveryParams(username: string): Promise<RecoveryParamsResponse> {
  return apiRequest<RecoveryParamsResponse>(
    `/auth/recovery-params?username=${encodeURIComponent(username)}`
  );
}

export function login(username: string, authVerifier: string): Promise<User> {
  return apiRequest<User>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, authVerifier })
  });
}

export function register(payload: RegisterPayload): Promise<User> {
  return apiRequest<User>("/auth/register", {
    method: "POST",
    body: JSON.stringify({
      ...payload,
      username: normalizeAccountHandle(payload.username)
    })
  });
}

export function recover(payload: RecoverPayload): Promise<User> {
  return apiRequest<User>("/auth/recover", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function logout(): Promise<undefined> {
  return apiRequest<undefined>("/auth/logout", { method: "POST" });
}

export function repairAccountHandle(handle: string): Promise<User> {
  return apiRequest<User>("/auth/handle", {
    method: "PUT",
    body: JSON.stringify({ handle: normalizeAccountHandle(handle) })
  });
}

export function getKeyMaterial(): Promise<KeyMaterialResponse> {
  return apiRequest<KeyMaterialResponse>("/key-material");
}

export function updateKeyMaterial(
  payload: UpdateKeyMaterialPayload
): Promise<{ keyMaterialVersion: number }> {
  return apiRequest<{ keyMaterialVersion: number }>("/key-material", {
    method: "PUT",
    body: JSON.stringify(payload)
  });
}

export function getCurrentSharingKey(): Promise<SharingKeyEnvelope> {
  return apiRequest<SharingKeyEnvelope>("/sharing-keys/current");
}

export function getSharingKeyVersion(version: number): Promise<SharingKeyEnvelope> {
  return apiRequest<SharingKeyEnvelope>(`/sharing-keys/versions/${String(version)}`);
}

export function storeCurrentSharingKey(
  payload: StoreSharingKeyPayload
): Promise<{ sharingKeyVersion: number }> {
  return apiRequest<{ sharingKeyVersion: number }>("/sharing-keys/current", {
    method: "PUT",
    body: JSON.stringify(payload)
  });
}

export function cleanupRetiredSharingKeys(): Promise<{ deleted: number }> {
  return apiRequest<{ deleted: number }>("/sharing-keys/cleanup", {
    method: "POST"
  });
}

export function lookupSharingKey(username: string): Promise<PublicSharingKey> {
  return apiRequest<PublicSharingKey>(
    `/sharing-keys/lookup?username=${encodeURIComponent(normalizeAccountHandle(username))}`
  );
}
