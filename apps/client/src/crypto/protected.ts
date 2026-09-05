import {
  associatedDataV2,
  decryptBytes,
  encryptBytesV2,
  epochLinkAssociatedData,
  fromBase64,
  openSealedBytes,
  sealBytes,
  toBase64,
  utf8,
  type EncryptedPayload
} from "@fortnote/shared";

export * from "./content";

export type ProtectedEnvelopeV2 = EncryptedPayload & { formatVersion: 2 };

export interface EncryptedAttachmentMetadataV2 extends ProtectedEnvelopeV2 {
  attachmentId: string;
  keyEpoch: number;
}

export interface EncryptedEpochLinkV2 extends ProtectedEnvelopeV2 {
  sourceEpoch: number;
  targetEpoch: number;
}

export function encryptNoteTitleV2(input: {
  cryptoOwnerId: string;
  noteId: string;
  keyEpoch: number;
  noteKey: Uint8Array;
  title: string;
}): Promise<ProtectedEnvelopeV2> {
  return encryptProtectedTextV2(
    input.title,
    input.noteKey,
    "note-title",
    protectedContext(input, ["cryptoOwnerId", "noteId", "keyEpoch"])
  );
}

export function decryptNoteTitleV2(input: {
  cryptoOwnerId: string;
  noteId: string;
  keyEpoch: number;
  noteKey: Uint8Array;
  envelope: EncryptedPayload;
}): Promise<string> {
  return decryptProtectedTextV2(
    input.envelope,
    input.noteKey,
    "note-title",
    protectedContext(input, ["cryptoOwnerId", "noteId", "keyEpoch"])
  );
}

export function encryptFolderNameV2(input: {
  userId: string;
  folderId: string;
  rootKey: Uint8Array;
  name: string;
}): Promise<ProtectedEnvelopeV2> {
  return encryptProtectedTextV2(
    input.name,
    input.rootKey,
    "folder-name",
    protectedContext(input, ["userId", "folderId"])
  );
}

export function decryptFolderNameV2(input: {
  userId: string;
  folderId: string;
  rootKey: Uint8Array;
  envelope: EncryptedPayload;
}): Promise<string> {
  return decryptProtectedTextV2(
    input.envelope,
    input.rootKey,
    "folder-name",
    protectedContext(input, ["userId", "folderId"])
  );
}

export async function encryptAttachmentMetadataV2(input: {
  cryptoOwnerId: string;
  noteId: string;
  attachmentId: string;
  keyEpoch: number;
  noteKey: Uint8Array;
  filename: string;
  mimeType: string;
}): Promise<EncryptedAttachmentMetadataV2> {
  const envelope = await encryptProtectedJsonV2(
    { filename: input.filename, mimeType: input.mimeType },
    input.noteKey,
    "attachment-metadata",
    protectedContext(input, ["cryptoOwnerId", "noteId", "attachmentId", "keyEpoch"])
  );
  return { ...envelope, attachmentId: input.attachmentId, keyEpoch: input.keyEpoch };
}

export async function decryptAttachmentMetadataV2(input: {
  cryptoOwnerId: string;
  noteId: string;
  attachmentId: string;
  keyEpoch: number;
  noteKey: Uint8Array;
  envelope: EncryptedPayload;
}): Promise<{ filename: string; mimeType: string }> {
  const value = await decryptProtectedJsonV2(
    input.envelope,
    input.noteKey,
    "attachment-metadata",
    protectedContext(input, ["cryptoOwnerId", "noteId", "attachmentId", "keyEpoch"])
  );
  if (
    !isRecord(value) ||
    typeof value.filename !== "string" ||
    typeof value.mimeType !== "string"
  ) {
    throw new Error("Invalid protected attachment metadata");
  }
  return { filename: value.filename, mimeType: value.mimeType };
}

export function encryptRootKeyEnvelopeV2(input: {
  userId: string;
  keyMaterialVersion: number;
  rootKey: Uint8Array;
  wrappingKey: Uint8Array;
}): Promise<ProtectedEnvelopeV2> {
  return encryptProtectedBytesV2(
    input.rootKey,
    input.wrappingKey,
    "root-key",
    protectedContext(input, ["userId", "keyMaterialVersion"])
  );
}

export function decryptRootKeyEnvelopeV2(input: {
  userId: string;
  keyMaterialVersion: number;
  wrappingKey: Uint8Array;
  envelope: EncryptedPayload;
}): Promise<Uint8Array> {
  return decryptProtectedBytesV2(
    input.envelope,
    input.wrappingKey,
    "root-key",
    protectedContext(input, ["userId", "keyMaterialVersion"])
  );
}

export function encryptSharingPrivateKeyEnvelopeV2(input: {
  userId: string;
  sharingKeyVersion: number;
  publicKey: string;
  rootKey: Uint8Array;
  privateKey: Uint8Array;
}): Promise<ProtectedEnvelopeV2> {
  return encryptProtectedBytesV2(
    input.privateKey,
    input.rootKey,
    "sharing-private-key",
    protectedContext(input, ["userId", "sharingKeyVersion", "publicKey"])
  );
}

export function decryptSharingPrivateKeyEnvelopeV2(input: {
  userId: string;
  sharingKeyVersion: number;
  publicKey: string;
  rootKey: Uint8Array;
  envelope: EncryptedPayload;
}): Promise<Uint8Array> {
  return decryptProtectedBytesV2(
    input.envelope,
    input.rootKey,
    "sharing-private-key",
    protectedContext(input, ["userId", "sharingKeyVersion", "publicKey"])
  );
}

export function encryptNoteKeyEnvelopeV2(input: {
  cryptoOwnerId: string;
  noteId: string;
  keyEpoch: number;
  rootKey: Uint8Array;
  noteKey: Uint8Array;
}): Promise<ProtectedEnvelopeV2> {
  return encryptProtectedBytesV2(
    input.noteKey,
    input.rootKey,
    "note-key",
    protectedContext(input, ["cryptoOwnerId", "noteId", "keyEpoch"])
  );
}

export function decryptNoteKeyEnvelopeV2(input: {
  cryptoOwnerId: string;
  noteId: string;
  keyEpoch: number;
  rootKey: Uint8Array;
  envelope: EncryptedPayload;
}): Promise<Uint8Array> {
  return decryptProtectedBytesV2(
    input.envelope,
    input.rootKey,
    "note-key",
    protectedContext(input, ["cryptoOwnerId", "noteId", "keyEpoch"])
  );
}

interface NoteShareContextV2 {
  cryptoOwnerId: string;
  noteId: string;
  keyEpoch: number;
  recipientUserId: string;
  recipientSharingKeyVersion: number;
  senderUserId: string;
}

export function encryptNoteKeyShareV2(
  input: NoteShareContextV2 & {
    noteKey: Uint8Array;
    recipientPublicKey: string;
  }
): Promise<string> {
  return sealBytes(
    utf8(
      JSON.stringify({
        formatVersion: 2,
        ...protectedContext(input, [
          "cryptoOwnerId",
          "noteId",
          "keyEpoch",
          "recipientUserId",
          "recipientSharingKeyVersion",
          "senderUserId"
        ]),
        noteKey: toBase64(input.noteKey)
      })
    ),
    input.recipientPublicKey
  );
}

export async function decryptNoteKeyShareV2(
  input: NoteShareContextV2 & {
    encryptedNoteKey: string;
    publicKey: string;
    privateKey: string;
  }
): Promise<Uint8Array> {
  const bytes = await openSealedBytes({
    cipher: input.encryptedNoteKey,
    publicKey: input.publicKey,
    privateKey: input.privateKey
  });
  const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  if (
    !isRecord(value) ||
    value.formatVersion !== 2 ||
    value.cryptoOwnerId !== input.cryptoOwnerId ||
    value.noteId !== input.noteId ||
    value.keyEpoch !== input.keyEpoch ||
    value.recipientUserId !== input.recipientUserId ||
    value.recipientSharingKeyVersion !== input.recipientSharingKeyVersion ||
    value.senderUserId !== input.senderUserId ||
    typeof value.noteKey !== "string"
  ) {
    throw new Error("Protected note share context mismatch");
  }
  return fromBase64(value.noteKey);
}

export async function createEpochLinkV2(input: {
  cryptoOwnerId: string;
  noteId: string;
  sourceEpoch: number;
  targetEpoch: number;
  sourceNoteKey: Uint8Array;
  targetNoteKey: Uint8Array;
}): Promise<EncryptedEpochLinkV2> {
  const context = epochContext(input);
  const envelope = await encryptBytesV2(
    input.sourceNoteKey,
    input.targetNoteKey,
    epochLinkAssociatedData({ ...context, formatVersion: 2 })
  );
  return {
    ...requireV2(envelope),
    sourceEpoch: input.sourceEpoch,
    targetEpoch: input.targetEpoch
  };
}

export async function traverseEpochLinksBackward(input: {
  cryptoOwnerId: string;
  noteId: string;
  currentEpoch: number;
  targetEpoch: number;
  currentNoteKey: Uint8Array;
  links: EncryptedEpochLinkV2[];
}): Promise<Uint8Array> {
  if (input.targetEpoch <= 0 || input.targetEpoch > input.currentEpoch) {
    throw new Error("Invalid target note epoch");
  }
  let epoch = input.currentEpoch;
  let noteKey = input.currentNoteKey;
  while (epoch > input.targetEpoch) {
    const link = input.links.find((candidate) => candidate.targetEpoch === epoch);
    if (link?.sourceEpoch !== epoch - 1) {
      throw new Error("Missing adjacent note epoch link");
    }
    requireV2(link);
    noteKey = await decryptBytes(
      link,
      noteKey,
      epochLinkAssociatedData({
        cryptoOwnerId: input.cryptoOwnerId,
        noteId: input.noteId,
        sourceEpoch: link.sourceEpoch,
        targetEpoch: link.targetEpoch,
        formatVersion: 2
      })
    );
    epoch = link.sourceEpoch;
  }
  return noteKey;
}

function epochContext(input: {
  cryptoOwnerId: string;
  noteId: string;
  sourceEpoch: number;
  targetEpoch: number;
}) {
  return protectedContext(input, [
    "cryptoOwnerId",
    "noteId",
    "sourceEpoch",
    "targetEpoch"
  ]) as {
    cryptoOwnerId: string;
    noteId: string;
    sourceEpoch: number;
    targetEpoch: number;
  };
}

async function encryptProtectedTextV2(
  value: string,
  key: Uint8Array,
  kind: string,
  context: Record<string, string | number | boolean>
): Promise<ProtectedEnvelopeV2> {
  return encryptProtectedBytesV2(utf8(value), key, kind, context);
}

async function decryptProtectedTextV2(
  envelope: EncryptedPayload,
  key: Uint8Array,
  kind: string,
  context: Record<string, string | number | boolean>
): Promise<string> {
  return new TextDecoder().decode(
    await decryptProtectedBytesV2(envelope, key, kind, context)
  );
}

async function encryptProtectedJsonV2(
  value: unknown,
  key: Uint8Array,
  kind: string,
  context: Record<string, string | number | boolean>
): Promise<ProtectedEnvelopeV2> {
  return encryptProtectedTextV2(JSON.stringify(value), key, kind, context);
}

async function decryptProtectedJsonV2(
  envelope: EncryptedPayload,
  key: Uint8Array,
  kind: string,
  context: Record<string, string | number | boolean>
): Promise<unknown> {
  return JSON.parse(await decryptProtectedTextV2(envelope, key, kind, context)) as unknown;
}

async function encryptProtectedBytesV2(
  value: Uint8Array,
  key: Uint8Array,
  kind: string,
  context: Record<string, string | number | boolean>
): Promise<ProtectedEnvelopeV2> {
  const envelope = await encryptBytesV2(value, key, associatedDataV2(kind, context));
  return requireV2(envelope);
}

async function decryptProtectedBytesV2(
  envelope: EncryptedPayload,
  key: Uint8Array,
  kind: string,
  context: Record<string, string | number | boolean>
): Promise<Uint8Array> {
  requireV2(envelope);
  return await decryptBytes(envelope, key, associatedDataV2(kind, context));
}

function requireV2(envelope: EncryptedPayload): ProtectedEnvelopeV2 {
  if (envelope.formatVersion !== 2) {
    throw new Error("Protected envelope downgrade rejected");
  }
  return envelope as ProtectedEnvelopeV2;
}

function protectedContext<T extends object>(
  input: T,
  keys: (keyof T)[]
): Record<string, string | number | boolean> {
  return Object.fromEntries(
    keys.map((key) => {
      const value = input[key];
      if (
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean"
      ) {
        throw new Error("Invalid protected context");
      }
      return [String(key), value];
    })
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
