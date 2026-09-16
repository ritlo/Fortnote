import { describe, expect, it } from "vitest";
import { fromBase64, toBase64 } from "@fortnote/shared";
import {
  decryptAttachmentBytes,
  decryptAttachmentMetadataV2,
  decryptContentChunkV2,
  decryptCrdtMessage,
  decryptFolderNameV2,
  decryptNoteKeyEnvelopeV2,
  decryptNoteKeyShareV2,
  decryptNoteTitleV2,
  decryptRootKeyEnvelopeV2,
  decryptSharingPrivateKeyEnvelopeV2,
  traverseEpochLinksBackward
} from "@client/cryptoClient";

// Ciphertext produced by the v2 envelope helpers. Each purpose string and
// context shape is bound into the ciphertext, so these must keep decrypting;
// regenerate them only as part of a deliberate format migration.
const OWNER = "00000000-0000-4000-8000-0000000000a1";
const NOTE = "00000000-0000-4000-8000-0000000000b1";
const SECTION = "00000000-0000-4000-8000-0000000000c1";
const UPDATE = "00000000-0000-4000-8000-0000000000d1";
const UPLOAD = "00000000-0000-4000-8000-0000000000e1";
const FOLDER = "00000000-0000-4000-8000-0000000000f1";
const ATTACHMENT = "00000000-0000-4000-8000-000000000011";
const RECIPIENT = "00000000-0000-4000-8000-000000000021";
const SHARING_PUBLIC_KEY = "nkd/sJylD1UwtUO27MmVKT2PE5jeeRKCI0vdxknUNXw=";
const SHARING_PRIVATE_KEY = "m1YsmO8ZNTaz3uOfJGtd1sfcmrD1q7iVfZmYhgR0yhg=";

const VECTORS = {
  title: {
    cipher: "8yTLdmZUBxjUxe86B5yt+Uqr4gGc1mk6ba8Dzg==",
    nonce: "cP8KQFCw30lizPpYrCbiNieG+HORgMdL",
    formatVersion: 2
  },
  folderName: {
    cipher: "9uX1WpmcC7ZZKR85t8XtzQ5bNojreD1qo9n7+58=",
    nonce: "qy3SeQmLh9LGt1+3PXffvGnAADadqEj0",
    formatVersion: 2
  },
  attachmentMetadata: {
    cipher:
      "XZ/CMwTrtddPkxa9blHXlNkIwPKGjPW0fCmIHWiG7/7IdfSRsvTdi8q3elKpXgH4dhw/7DdiKzL6//0oMWwXVb5S74/bgg==",
    nonce: "3CM+mtz22cDs4/XHjZkzQq1h6sfUv+wu",
    formatVersion: 2,
    attachmentId: "00000000-0000-4000-8000-000000000011",
    keyEpoch: 3
  },
  attachmentKey: {
    cipher: "ebfvs+S2moXTXnnpQm4cPOHZKYthB/O6Tj1wDgcKrFJ0WuBV6+7azZf29q4s/Fht",
    nonce: "F61JpVEpk4NffhsaPiXkYy4IoQ7NE/un"
  },
  attachmentFile: {
    cipher: "jbA87KpASXtuyH1j7Lw2Yts6JHd+69cQkmAU6X1AqHzo",
    nonce: "6gWHUn9RDrDpg1oNLjR7HPIHk/OOwbTJ"
  },
  rootKey: {
    cipher: "lGo/Hy+YbD52fuTZNbVYcXCb6M1U/hJ1FdIlQVx0e9ukYA6RXbT1y34PMsSreeg/",
    nonce: "vzOORSBWOsjN5E0SrncEh6aNC59xS5Uj",
    formatVersion: 2
  },
  sharingPrivateKey: {
    cipher: "7oj3ls8ZD33asnUlY9Lcqx33wX2O6vL63lY/UoIsZxuHmcg8z10JipUfG2F68dpI",
    nonce: "3eu96xrtoRrSgllSoBLAGIJRzx9gEPP+",
    formatVersion: 2
  },
  noteKey: {
    cipher: "FovccrQ0VjXptZ6lQhsBNDrkTeAwne5ZV3sPuw0qSAtDI6RNRxSO6t4cQh2ct4kj",
    nonce: "vI/cANZloJmTggiy2iNIolPInk3U8OIy",
    formatVersion: 2
  },
  noteKeyShare:
    "ebSUxlHQZc2awfSvJDRowYiAdA/VbNiu+XnwbrsyaUrVPez0wXzjmGdRM0y8U0L2p79xzEvbZFFNo6yT+LJqGw9v+9R+q1EUWfN8aIWuDWXLy+rLJYztvK4ErFTMd/r/TZ3lGfCQG42FcKUiwp2O9ZiuJYm4j0PQ9Lmg9y3ujtz4Dc+QJ6F3vaqA+74xmfH3p0FvnVy5aJdES2pgkVMOsMJcOT4ofV8koRxcVOXM02RSUgQqo3tlAb+aEkhV1aYXp873b+zkt8rUlUw+0zYNC0OPG0RRVzMc3zrKgNpUuN30cjTu5Wc8xk/hgGj1rSdXrxTwd8jdEu0TmwoovEhOSRJnPxbSw7dBZTHTLWnrwu3aebPtrkoe8joqnWXW/FAEY7xxKKptqaKfvNQHB4NjODBuEADOtp2NVlM8U9cFMp3gwpF4TdeDUmJrGihJNdRK3Lbb3eygiPWU1W5XMZeZhwQpl3idFSOApMbjsf7cmgXOKqkIcC8GmE3eb6hoEQ==",
  epochLink: {
    cipher: "oqVw8F2F2pDlp09PIJj8xStpTdqejEO+jUkzoFYaEUTszm3fmsSDYClGYDiRzOyD",
    nonce: "crX5SemXHMbF8eKGzQWtQ6wRHi3zX5MB",
    formatVersion: 2,
    sourceEpoch: 3,
    targetEpoch: 4
  },
  contentChunk: {
    cipher: "EK0cM3wIdSwnJIbpLqfC3xWH04uoXfnQUTh5kA==",
    nonce: "jCY1tnDAGTUMoU2T0cWnyUhQqhNaETiW",
    formatVersion: 2
  },
  crdtMessage: {
    cipher: "vGxM2PDr6wh9JcPPWMCEq3a0AffuID8/AlwHM/s=",
    nonce: "UndjCZ519YU+74YUsy2GuIzsa8gf4mAy",
    formatVersion: 2
  }
} as const;

function key(seed: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, index) => (seed * 7 + index) % 256);
}

const encode = (value: string) => new TextEncoder().encode(value);

describe("v2 envelope golden vectors", () => {
  it("decrypts note titles, folder names, and attachment metadata", async () => {
    await expect(
      decryptNoteTitleV2({
        cryptoOwnerId: OWNER,
        noteId: NOTE,
        keyEpoch: 3,
        noteKey: key(1),
        envelope: VECTORS.title
      })
    ).resolves.toBe("Golden title");
    await expect(
      decryptFolderNameV2({
        userId: OWNER,
        folderId: FOLDER,
        rootKey: key(2),
        envelope: VECTORS.folderName
      })
    ).resolves.toBe("Golden folder");
    await expect(
      decryptAttachmentMetadataV2({
        cryptoOwnerId: OWNER,
        noteId: NOTE,
        attachmentId: ATTACHMENT,
        keyEpoch: 3,
        noteKey: key(1),
        envelope: VECTORS.attachmentMetadata
      })
    ).resolves.toEqual({ filename: "golden.pdf", mimeType: "application/pdf" });
  });

  it("decrypts attachment keys and file bytes", async () => {
    await expect(
      decryptAttachmentBytes({
        cryptoOwnerId: OWNER,
        noteId: NOTE,
        attachmentId: ATTACHMENT,
        keyEpoch: 3,
        noteKeyBase64: toBase64(key(1)),
        encryptedAttachmentKey: VECTORS.attachmentKey.cipher,
        attachmentKeyNonce: VECTORS.attachmentKey.nonce,
        encryptedBytes: VECTORS.attachmentFile.cipher,
        fileNonce: VECTORS.attachmentFile.nonce
      })
    ).resolves.toEqual(new TextEncoder().encode("Golden attachment"));
  });

  it("decrypts root, sharing private, and note key envelopes", async () => {
    await expect(
      decryptRootKeyEnvelopeV2({
        userId: OWNER,
        keyMaterialVersion: 5,
        wrappingKey: key(3),
        envelope: VECTORS.rootKey
      })
    ).resolves.toEqual(key(2));
    await expect(
      decryptSharingPrivateKeyEnvelopeV2({
        userId: OWNER,
        sharingKeyVersion: 6,
        publicKey: SHARING_PUBLIC_KEY,
        rootKey: key(2),
        envelope: VECTORS.sharingPrivateKey
      })
    ).resolves.toEqual(fromBase64(SHARING_PRIVATE_KEY));
    await expect(
      decryptNoteKeyEnvelopeV2({
        cryptoOwnerId: OWNER,
        noteId: NOTE,
        keyEpoch: 3,
        rootKey: key(2),
        envelope: VECTORS.noteKey
      })
    ).resolves.toEqual(key(1));
  });

  it("opens note key shares and traverses epoch links", async () => {
    await expect(
      decryptNoteKeyShareV2({
        cryptoOwnerId: OWNER,
        noteId: NOTE,
        keyEpoch: 3,
        recipientUserId: RECIPIENT,
        recipientSharingKeyVersion: 6,
        senderUserId: OWNER,
        encryptedNoteKey: VECTORS.noteKeyShare,
        publicKey: SHARING_PUBLIC_KEY,
        privateKey: SHARING_PRIVATE_KEY
      })
    ).resolves.toEqual(key(1));
    await expect(
      traverseEpochLinksBackward({
        cryptoOwnerId: OWNER,
        noteId: NOTE,
        currentEpoch: 4,
        targetEpoch: 3,
        currentNoteKey: key(4),
        links: [VECTORS.epochLink]
      })
    ).resolves.toEqual(key(1));
  });

  it("decrypts content chunks and binary CRDT updates", async () => {
    await expect(
      decryptContentChunkV2({
        cryptoOwnerId: OWNER,
        noteId: NOTE,
        sectionId: SECTION,
        keyEpoch: 3,
        updateId: UPDATE,
        uploadId: UPLOAD,
        chunkIndex: 1,
        chunkCount: 2,
        totalCipherBytes: 64,
        kind: "checkpoint",
        checkpointSequenceCutoff: 9,
        noteKey: key(1),
        envelope: VECTORS.contentChunk
      })
    ).resolves.toEqual(encode("golden chunk"));
    await expect(
      decryptCrdtMessage({
        type: "crdt-update",
        formatVersion: 2,
        cryptoOwnerId: OWNER,
        noteId: NOTE,
        sectionId: SECTION,
        keyEpoch: 3,
        updateId: UPDATE,
        kind: "update",
        noteKeyBase64: toBase64(key(1)),
        cipher: VECTORS.crdtMessage.cipher,
        nonce: VECTORS.crdtMessage.nonce
      })
    ).resolves.toEqual(encode("golden update"));
  });
});
