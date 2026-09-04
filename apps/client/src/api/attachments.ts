import { randomUuid } from "@fortnote/shared";
import type {
  AttachmentDownload,
  BinaryTransferProgress,
  EncryptedAttachmentSummary,
  UploadAttachmentPayload
} from "./contracts";
import {
  apiRequest,
  ApiRequestError,
  applyXhrHeaders,
  requestHeaders,
  transferProgress,
  xhrRequestError
} from "./http";

export function listAttachments(
  noteId: string
): Promise<{ attachments: EncryptedAttachmentSummary[] }> {
  return apiRequest<{ attachments: EncryptedAttachmentSummary[] }>(
    `/notes/${noteId}/attachments`
  );
}

export function uploadAttachment(
  noteId: string,
  payload: UploadAttachmentPayload,
  onProgress?: (progress: BinaryTransferProgress) => void
): Promise<{ id: string; keyEpoch: number }> {
  const requestId = randomUuid();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/notes/${noteId}/attachments`);
    xhr.withCredentials = true;
    xhr.responseType = "json";
    applyXhrHeaders(
      xhr,
      requestHeaders(
        {
          headers: {
            "content-type": "application/octet-stream",
            "x-fortnote-attachment-id": payload.id,
            "x-fortnote-size": String(payload.size),
            "x-fortnote-expected-key-epoch": String(payload.expectedKeyEpoch),
            "x-fortnote-metadata-cipher": payload.metadataCipher,
            "x-fortnote-metadata-nonce": payload.metadataNonce,
            "x-fortnote-metadata-format-version": String(
              payload.metadataFormatVersion
            ),
            "x-fortnote-encrypted-attachment-key": payload.encryptedAttachmentKey,
            "x-fortnote-attachment-key-nonce": payload.attachmentKeyNonce,
            "x-fortnote-file-nonce": payload.fileNonce
          }
        },
        requestId,
        false
      )
    );
    xhr.upload.addEventListener("progress", (event) => {
      transferProgress(event, payload.size, onProgress);
    });
    xhr.addEventListener("load", () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(xhrRequestError(xhr, requestId));
        return;
      }
      const result = xhr.response as unknown;
      if (
        !result ||
        typeof result !== "object" ||
        typeof (result as Record<string, unknown>).id !== "string" ||
        typeof (result as Record<string, unknown>).keyEpoch !== "number"
      ) {
        reject(
          new ApiRequestError(
            xhr.status,
            "invalid_response",
            "Invalid attachment upload response",
            requestId
          )
        );
        return;
      }
      resolve(result as { id: string; keyEpoch: number });
    });
    xhr.addEventListener("error", () => {
      reject(new ApiRequestError(0, "network_error", "Attachment upload failed", requestId));
    });
    xhr.addEventListener("abort", () => {
      reject(new ApiRequestError(0, "request_aborted", "Attachment upload canceled", requestId));
    });
    xhr.send(payload.encryptedBytes.slice().buffer);
  });
}

export function downloadAttachment(
  attachmentId: string,
  onProgress?: (progress: BinaryTransferProgress) => void
): Promise<AttachmentDownload> {
  const requestId = randomUuid();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", `/api/attachments/${attachmentId}`);
    xhr.withCredentials = true;
    xhr.responseType = "arraybuffer";
    applyXhrHeaders(xhr, requestHeaders({}, requestId, false));
    xhr.addEventListener("progress", (event) => {
      transferProgress(event, 0, onProgress);
    });
    xhr.addEventListener("load", () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(xhrRequestError(xhr, requestId));
        return;
      }
      const id = xhr.getResponseHeader("x-fortnote-attachment-id");
      const noteId = xhr.getResponseHeader("x-fortnote-note-id");
      const keyEpoch = Number(xhr.getResponseHeader("x-fortnote-key-epoch"));
      const bytes = xhr.response as unknown;
      if (
        id !== attachmentId ||
        !noteId ||
        !Number.isSafeInteger(keyEpoch) ||
        keyEpoch <= 0 ||
        !(bytes instanceof ArrayBuffer)
      ) {
        reject(
          new ApiRequestError(
            xhr.status,
            "invalid_response",
            "Invalid attachment download response",
            requestId
          )
        );
        return;
      }
      resolve({
        id,
        noteId,
        keyEpoch,
        encryptedBytes: new Uint8Array(bytes)
      });
    });
    xhr.addEventListener("error", () => {
      reject(new ApiRequestError(0, "network_error", "Attachment download failed", requestId));
    });
    xhr.addEventListener("abort", () => {
      reject(
        new ApiRequestError(0, "request_aborted", "Attachment download canceled", requestId)
      );
    });
    xhr.send();
  });
}

export function deleteAttachment(attachmentId: string): Promise<undefined> {
  return apiRequest<undefined>(`/attachments/${attachmentId}`, { method: "DELETE" });
}
