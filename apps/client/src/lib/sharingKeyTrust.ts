import {
  decryptBytes,
  encryptBytes,
  fromBase64,
  sha256,
  utf8
} from "@fortnote/shared";
import type { PublicSharingKey } from "../api";

const TRUST_STORAGE_PREFIX = "fortnote:sharing-key-trust:v1";
const TRUST_AAD_PREFIX = "fortnote:sharing-key-trust:v1";

export interface TrustedSharingKeyRecord {
  userId: string;
  username: string;
  sharingKeyVersion: number;
  fingerprint: string;
  trustedAt: string;
}

interface SharingKeyTrustState {
  formatVersion: 1;
  records: TrustedSharingKeyRecord[];
}

interface StorageLike {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

export type SharingKeyTrustDecision =
  | {
      status: "trusted";
      fingerprint: string;
      record: TrustedSharingKeyRecord;
    }
  | {
      status: "untrusted";
      fingerprint: string;
    }
  | {
      status: "mismatch";
      fingerprint: string;
      trustedFingerprint: string;
      record: TrustedSharingKeyRecord;
    };

export async function fingerprintPublicSharingKey(publicKey: string): Promise<string> {
  const publicKeyBytes = Uint8Array.from(fromBase64(publicKey));
  const digest = await sha256(publicKeyBytes);
  return Array.from(digest.slice(0, 16))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()
    .match(/.{1,4}/g)!
    .join(" ");
}

export async function getSharingKeyTrustDecision(input: {
  ownerUserId: string;
  rootKey: Uint8Array;
  publicKey: PublicSharingKey;
  storage?: StorageLike;
}): Promise<SharingKeyTrustDecision> {
  const fingerprint = await fingerprintPublicSharingKey(input.publicKey.publicKey);
  const state = await loadSharingKeyTrustState(input);
  const record = state.records.find(
    (candidate) =>
      candidate.userId === input.publicKey.userId &&
      candidate.sharingKeyVersion === input.publicKey.sharingKeyVersion
  );

  if (!record) {
    return { status: "untrusted", fingerprint };
  }
  if (record.fingerprint !== fingerprint) {
    return {
      status: "mismatch",
      fingerprint,
      trustedFingerprint: record.fingerprint,
      record
    };
  }
  return { status: "trusted", fingerprint, record };
}

export async function trustSharingKey(input: {
  ownerUserId: string;
  rootKey: Uint8Array;
  publicKey: PublicSharingKey;
  fingerprint?: string;
  storage?: StorageLike;
}): Promise<TrustedSharingKeyRecord> {
  const fingerprint =
    input.fingerprint ?? (await fingerprintPublicSharingKey(input.publicKey.publicKey));
  const state = await loadSharingKeyTrustState(input);
  const record: TrustedSharingKeyRecord = {
    userId: input.publicKey.userId,
    username: input.publicKey.username,
    sharingKeyVersion: input.publicKey.sharingKeyVersion,
    fingerprint,
    trustedAt: new Date().toISOString()
  };
  const records = state.records.filter(
    (candidate) =>
      candidate.userId !== record.userId ||
      candidate.sharingKeyVersion !== record.sharingKeyVersion
  );
  await saveSharingKeyTrustState(
    {
      formatVersion: 1,
      records: [...records, record]
    },
    input
  );
  return record;
}

export function removeSharingKeyTrustRecords(
  ownerUserId: string,
  storage?: StorageLike
): void {
  getStorage(storage).removeItem(storageKey(ownerUserId));
}

async function loadSharingKeyTrustState(input: {
  ownerUserId: string;
  rootKey: Uint8Array;
  storage?: StorageLike;
}): Promise<SharingKeyTrustState> {
  const storage = getStorage(input.storage);
  const raw = storage.getItem(storageKey(input.ownerUserId));
  if (!raw) {
    return { formatVersion: 1, records: [] };
  }

  try {
    const envelope = JSON.parse(raw) as { cipher: string; nonce: string; formatVersion: number };
    const plaintext = await decryptBytes(
      envelope,
      input.rootKey,
      utf8(`${TRUST_AAD_PREFIX}:${input.ownerUserId}`)
    );
    return parseTrustState(new TextDecoder().decode(plaintext));
  } catch {
    throw new Error("Unable to decrypt sharing key trust records");
  }
}

async function saveSharingKeyTrustState(
  state: SharingKeyTrustState,
  input: {
    ownerUserId: string;
    rootKey: Uint8Array;
    storage?: StorageLike;
  }
): Promise<void> {
  const encrypted = await encryptBytes(
    new TextEncoder().encode(JSON.stringify(state)),
    input.rootKey,
    utf8(`${TRUST_AAD_PREFIX}:${input.ownerUserId}`)
  );
  getStorage(input.storage).setItem(storageKey(input.ownerUserId), JSON.stringify(encrypted));
}

function parseTrustState(value: string): SharingKeyTrustState {
  const parsed = JSON.parse(value) as Partial<SharingKeyTrustState>;
  if (
    parsed.formatVersion !== 1 ||
    !Array.isArray(parsed.records) ||
    !parsed.records.every(isTrustRecord)
  ) {
    throw new Error("Invalid sharing key trust records");
  }
  return {
    formatVersion: 1,
    records: parsed.records
  };
}

function isTrustRecord(value: unknown): value is TrustedSharingKeyRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.userId === "string" &&
    typeof record.username === "string" &&
    typeof record.sharingKeyVersion === "number" &&
    typeof record.fingerprint === "string" &&
    typeof record.trustedAt === "string"
  );
}

function storageKey(ownerUserId: string): string {
  return `${TRUST_STORAGE_PREFIX}:${ownerUserId}`;
}

function getStorage(storage?: StorageLike): StorageLike {
  if (storage) {
    return storage;
  }
  return globalThis.localStorage;
}
