import type {
  ContentManifestCommitPayload,
  ContentManifestSummary,
  ContentUploadBeginPayload,
  ContentUploadStatus,
  DownloadedContentChunk,
  LegacyNoteContent,
  LegacySectionReservation,
  LogicalNoteSectionSummary,
  SectionCreationResult,
  SectionDeletionResult,
  SectionHistoryPage,
  SectionInitializationResult,
  StorageQuotaStatus
} from "./contracts";
import { apiBinaryRequest, apiRequest, ApiRequestError } from "./http";

export function beginContentUpload(
  payload: ContentUploadBeginPayload
): Promise<ContentUploadStatus> {
  return apiRequest<ContentUploadStatus>("/content/uploads", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function inspectContentUpload(uploadId: string): Promise<ContentUploadStatus> {
  return apiRequest<ContentUploadStatus>(`/content/uploads/${uploadId}`);
}

export async function putContentChunk(
  uploadId: string,
  chunkIndex: number,
  bytes: Uint8Array,
  cipherHash: string,
  nonce: string
): Promise<void> {
  await apiBinaryRequest(`/content/uploads/${uploadId}/chunks/${String(chunkIndex)}`, {
    method: "PUT",
    headers: {
      "content-type": "application/octet-stream",
      "x-fortnote-cipher-hash": cipherHash,
      "x-fortnote-nonce": nonce
    },
    body: new Blob([bytes.slice()])
  });
}

export function abortContentUpload(uploadId: string): Promise<undefined> {
  return apiRequest<undefined>(`/content/uploads/${uploadId}`, { method: "DELETE" });
}

export function commitContentManifest(
  uploadId: string,
  payload: ContentManifestCommitPayload
): Promise<ContentManifestSummary> {
  return apiRequest<ContentManifestSummary>(`/content/uploads/${uploadId}/commit`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function downloadContentChunk(
  manifestId: string,
  chunkIndex: number
): Promise<DownloadedContentChunk> {
  return apiBinaryRequest(
    `/content/manifests/${manifestId}/chunks/${String(chunkIndex)}`
  ).then(({ bytes, headers }) => {
    const cipherHash = headers.get("x-fortnote-cipher-hash") ?? "";
    const nonce = headers.get("x-fortnote-nonce") ?? "";
    const cipherLength = Number(headers.get("content-length"));
    if (
      !/^[0-9a-f]{64}$/u.test(cipherHash) ||
      !canonicalNonce(nonce) ||
      !Number.isSafeInteger(cipherLength) ||
      cipherLength <= 0 ||
      cipherLength !== bytes.byteLength
    ) {
      throw new ApiRequestError(
        0,
        "invalid_binary_response",
        "Encrypted content response metadata is invalid"
      );
    }
    return { bytes, cipherHash, cipherLength, nonce };
  });
}

function canonicalNonce(value: string): boolean {
  try {
    const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    return bytes.byteLength === 24 && btoa(String.fromCharCode(...bytes)) === value;
  } catch {
    return false;
  }
}

export function listNoteSections(
  noteId: string
): Promise<{ sections: LogicalNoteSectionSummary[] }> {
  return apiRequest<{ sections: LogicalNoteSectionSummary[] }>(
    `/notes/${noteId}/sections`
  );
}

export function getLegacyNoteContent(noteId: string): Promise<LegacyNoteContent> {
  return apiRequest<LegacyNoteContent>(`/notes/${noteId}/legacy-content`);
}

export function reserveLegacyRootSection(
  noteId: string,
  payload: {
    sectionId: string;
    expectedKeyEpoch: number;
    expectedRootVersion: number;
  }
): Promise<LegacySectionReservation> {
  return apiRequest<LegacySectionReservation>(
    `/notes/${noteId}/sections/legacy-reservation`,
    { method: "POST", body: JSON.stringify(payload) }
  );
}

export function initializeNoteSection(
  noteId: string,
  sectionId: string,
  payload: {
    manifestId: string;
    expectedKeyEpoch: number;
    expectedRootVersion: number;
  }
): Promise<SectionInitializationResult> {
  return apiRequest<SectionInitializationResult>(
    `/notes/${noteId}/sections/${sectionId}/initialization`,
    { method: "POST", body: JSON.stringify(payload) }
  );
}

export function createNoteSection(
  noteId: string,
  payload: {
    sectionId: string;
    expectedKeyEpoch: number;
    expectedRootVersion: number;
  }
): Promise<SectionCreationResult> {
  return apiRequest<SectionCreationResult>(`/notes/${noteId}/sections`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function deleteNoteSection(
  noteId: string,
  sectionId: string,
  payload: { expectedKeyEpoch: number; expectedRootVersion: number }
): Promise<SectionDeletionResult> {
  return apiRequest<SectionDeletionResult>(`/notes/${noteId}/sections/${sectionId}`, {
    method: "DELETE",
    body: JSON.stringify(payload)
  });
}

export function getSectionHistory(
  noteId: string,
  sectionId: string,
  afterSequence: number
): Promise<SectionHistoryPage> {
  return apiRequest<SectionHistoryPage>(
    `/notes/${noteId}/sections/${sectionId}/history?after=${String(afterSequence)}`
  );
}

export function getStorageQuota(): Promise<StorageQuotaStatus> {
  return apiRequest<StorageQuotaStatus>("/content/quota");
}
