export const LIMITS = {
  maxAttachmentBytes: 25 * 1024 * 1024,
  maxUserStorageBytes: 250 * 1024 * 1024
} as const;

export * from "./crypto.js";
