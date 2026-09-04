import {
  createSharingKeyPair,
  decryptBytes,
  encryptBytes,
  fromBase64,
  openSealedBytes,
  sealBytes,
  toBase64,
  utf8
} from "@fortnote/shared";
import type {
  SharingKeyEnvelope,
  StoreSharingKeyPayload
} from "../api/contracts";
import {
  decryptSharingPrivateKeyEnvelopeV2,
  encryptSharingPrivateKeyEnvelopeV2
} from "./protected";

const SHARING_PRIVATE_KEY_AAD = utf8("fortnote:sharing-private-key:v1");

export interface OpenedSharingKey {
  publicKey: string;
  privateKey: string;
  sharingKeyVersion: number;
}

export interface CreatedSharingKey {
  payload: StoreSharingKeyPayload;
  opened: OpenedSharingKey;
}

export async function createUserSharingKey(
  rootKey: Uint8Array,
  sharingKeyVersion = 1,
  userId?: string
): Promise<CreatedSharingKey> {
  const keyPair = await createSharingKeyPair();
  const encryptedPrivateKey = userId
    ? await encryptSharingPrivateKeyEnvelopeV2({
        userId,
        sharingKeyVersion,
        publicKey: keyPair.publicKey,
        rootKey,
        privateKey: fromBase64(keyPair.privateKey)
      })
    : await encryptBytes(
        fromBase64(keyPair.privateKey),
        rootKey,
        SHARING_PRIVATE_KEY_AAD
      );

  return {
    payload: {
      sharingKeyVersion,
      publicKey: keyPair.publicKey,
      encryptedPrivateKey: encryptedPrivateKey.cipher,
      privateKeyNonce: encryptedPrivateKey.nonce,
      formatVersion: encryptedPrivateKey.formatVersion
    },
    opened: {
      publicKey: keyPair.publicKey,
      privateKey: keyPair.privateKey,
      sharingKeyVersion
    }
  };
}

export async function openUserSharingKey(input: {
  userId?: string;
  rootKey: Uint8Array;
  envelope: SharingKeyEnvelope;
}): Promise<OpenedSharingKey> {
  const encryptedPrivateKey = {
    cipher: input.envelope.encryptedPrivateKey,
    nonce: input.envelope.privateKeyNonce,
    formatVersion: input.envelope.formatVersion
  };
  const privateKey = input.envelope.formatVersion === 2
    ? await decryptSharingPrivateKeyEnvelopeV2({
        userId: requireEnvelopeUserId(input.userId),
        sharingKeyVersion: input.envelope.sharingKeyVersion,
        publicKey: input.envelope.publicKey,
        rootKey: input.rootKey,
        envelope: encryptedPrivateKey
      })
    : await decryptBytes(
        encryptedPrivateKey,
        input.rootKey,
        SHARING_PRIVATE_KEY_AAD
      );

  return {
    publicKey: input.envelope.publicKey,
    privateKey: toBase64(privateKey),
    sharingKeyVersion: input.envelope.sharingKeyVersion
  };
}

export async function encryptNoteKeyShare(input: {
  noteKeyBase64: string;
  recipientPublicKey: string;
}): Promise<string> {
  return sealBytes(fromBase64(input.noteKeyBase64), input.recipientPublicKey);
}

export async function decryptNoteKeyShare(input: {
  encryptedNoteKey: string;
  publicKey: string;
  privateKey: string;
}): Promise<string> {
  const noteKey = await openSealedBytes({
    cipher: input.encryptedNoteKey,
    publicKey: input.publicKey,
    privateKey: input.privateKey
  });
  return toBase64(noteKey);
}

function requireEnvelopeUserId(userId: string | undefined): string {
  if (!userId) {
    throw new Error("Protected sharing key account context is missing");
  }
  return userId;
}
