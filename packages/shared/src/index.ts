export const APP_NAME = "Fortnote";

export const CRYPTO_FORMAT_VERSION = 1;

export const LIMITS = {
  maxAttachmentBytes: 25 * 1024 * 1024,
  maxUserStorageBytes: 250 * 1024 * 1024,
  maxFolderDepth: 1
} as const;

export type ApiErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "payload_too_large"
  | "quota_exceeded"
  | "rate_limited"
  | "csrf_failed";

export interface ApiError {
  code: ApiErrorCode;
  message: string;
}

export * from "./crypto.js";
