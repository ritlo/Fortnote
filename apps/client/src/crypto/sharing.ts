import { createSharingKeyPair, fromBase64, toBase64 } from "@fortnote/shared";
import type { SharingKeyEnvelope, StoreSharingKeyPayload } from "../api/contracts";
import {
  decryptSharingPrivateKeyEnvelopeV2,
  encryptSharingPrivateKeyEnvelopeV2
} from "./protected";

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
  sharingKeyVersion: number,
  userId: string
): Promise<CreatedSharingKey> {
  const keyPair = await createSharingKeyPair();
  const encryptedPrivateKey = await encryptSharingPrivateKeyEnvelopeV2({
    userId,
    sharingKeyVersion,
    publicKey: keyPair.publicKey,
    rootKey,
    privateKey: fromBase64(keyPair.privateKey)
  });

  return {
    payload: {
      sharingKeyVersion,
      publicKey: keyPair.publicKey,
      encryptedPrivateKey: encryptedPrivateKey.cipher,
      privateKeyNonce: encryptedPrivateKey.nonce,
      formatVersion: 2
    },
    opened: {
      publicKey: keyPair.publicKey,
      privateKey: keyPair.privateKey,
      sharingKeyVersion
    }
  };
}

export async function openUserSharingKey(input: {
  userId: string;
  rootKey: Uint8Array;
  envelope: SharingKeyEnvelope;
}): Promise<OpenedSharingKey> {
  if (input.envelope.formatVersion !== 2) {
    throw new Error("Unsupported sharing key envelope");
  }
  const privateKey = await decryptSharingPrivateKeyEnvelopeV2({
    userId: input.userId,
    sharingKeyVersion: input.envelope.sharingKeyVersion,
    publicKey: input.envelope.publicKey,
    rootKey: input.rootKey,
    envelope: {
      cipher: input.envelope.encryptedPrivateKey,
      nonce: input.envelope.privateKeyNonce,
      formatVersion: 2
    }
  });

  return {
    publicKey: input.envelope.publicKey,
    privateKey: toBase64(privateKey),
    sharingKeyVersion: input.envelope.sharingKeyVersion
  };
}
