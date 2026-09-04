import type { EncryptedFolderSummary } from "./contracts";
import { apiRequest } from "./http";

export function listFolders(): Promise<{ folders: EncryptedFolderSummary[] }> {
  return apiRequest<{ folders: EncryptedFolderSummary[] }>("/folders");
}

export function createFolder(
  payload:
    | { name: string; parentFolderId?: string | null }
    | {
        id: string;
        nameCipher: string;
        nameNonce: string;
        nameFormatVersion: 2;
        parentFolderId?: string | null;
      }
): Promise<EncryptedFolderSummary> {
  return apiRequest<EncryptedFolderSummary>("/folders", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function updateFolder(
  folderId: string,
  payload: {
    nameCipher: string;
    nameNonce: string;
    nameFormatVersion: 2;
    parentFolderId?: string | null;
  }
): Promise<EncryptedFolderSummary> {
  return apiRequest<EncryptedFolderSummary>(`/folders/${folderId}`, {
    method: "PUT",
    body: JSON.stringify(payload)
  });
}

export function deleteFolder(folderId: string): Promise<undefined> {
  return apiRequest<undefined>(`/folders/${folderId}`, { method: "DELETE" });
}
