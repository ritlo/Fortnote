import { indexedDB as fakeIndexedDb } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";
import { ApiRequestError, type ContentManifestSummary } from "../api";
import { encryptContentChunksV2 } from "../cryptoClient";
import {
  IndexedDbCapacityError,
  openFortnoteIndexedDb,
  type FortnoteIndexedDb
} from "../lib/indexedDb";
import {
  downloadVerifiedContent,
  resumeContentUpload,
  uploadPreparedContent,
  type ContentTransferApi
} from "./contentTransfer";

const databases: FortnoteIndexedDb[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map(async (database) => database.deleteDatabase()));
});

describe("resumable encrypted content transfer", () => {
  it("persists before transport and uploads only server-missing chunk indexes", async () => {
    const database = await openDatabase();
    const prepared = await preparedContent();
    const uploaded: number[] = [];
    const progress: number[] = [];
    const api = fakeApi({
      async beginContentUpload(payload) {
        await expect(
          database.getContentTransfer("user-a", prepared.uploadId)
        ).resolves.toMatchObject({
          updateId: prepared.updateId,
          manifestHash: prepared.manifestHash
        });
        return status(payload.uploadId, [1]);
      },
      inspectContentUpload(uploadId) {
        return Promise.resolve(status(uploadId, [1]));
      },
      putContentChunk(_uploadId, chunkIndex) {
        uploaded.push(chunkIndex);
        return Promise.resolve();
      },
      commitContentManifest() {
        return Promise.resolve(manifest(prepared));
      }
    });

    await expect(
      uploadPreparedContent({
        userId: "user-a",
        database,
        prepared,
        api,
        onProgress: ({ completedChunks }) => progress.push(completedChunks)
      })
    ).resolves.toMatchObject({ kind: "committed", manifest: manifest(prepared) });
    expect(uploaded).toEqual([0, 2]);
    expect(progress).toEqual([1, 2, 3]);
    await expect(
      database.getContentTransfer("user-a", prepared.uploadId)
    ).resolves.toBeNull();
  });

  it("retains accepted progress after interruption and resumes with stable identities", async () => {
    const database = await openDatabase();
    const prepared = await preparedContent();
    const firstIndexes: number[] = [];
    const interruptedApi = fakeApi({
      beginContentUpload(payload) {
        return Promise.resolve(status(payload.uploadId, []));
      },
      inspectContentUpload(uploadId) {
        return Promise.resolve(status(uploadId, []));
      },
      putContentChunk(_uploadId, chunkIndex) {
        if (chunkIndex === 1) {
          return Promise.reject(new TypeError("network interrupted"));
        }
        firstIndexes.push(chunkIndex);
        return Promise.resolve();
      }
    });

    await expect(
      uploadPreparedContent({
        userId: "user-a",
        database,
        prepared,
        api: interruptedApi
      })
    ).rejects.toThrow("network interrupted");
    expect(firstIndexes).toEqual([0]);
    const persisted = await database.getContentTransfer("user-a", prepared.uploadId);
    expect(persisted).toMatchObject({
      uploadId: prepared.uploadId,
      updateId: prepared.updateId,
      requestId: prepared.requestId,
      uploadedChunkIndexes: [0]
    });
    if (!persisted) {
      throw new Error("Expected interrupted transfer to remain persisted");
    }

    const resumedIndexes: number[] = [];
    const resumedApi = fakeApi({
      beginContentUpload(payload) {
        expect(payload).toMatchObject({
          uploadId: prepared.uploadId,
          updateId: prepared.updateId
        });
        return Promise.resolve(status(payload.uploadId, [0]));
      },
      inspectContentUpload(uploadId) {
        return Promise.resolve(status(uploadId, [0]));
      },
      putContentChunk(_uploadId, chunkIndex) {
        resumedIndexes.push(chunkIndex);
        return Promise.resolve();
      },
      commitContentManifest(_uploadId, payload) {
        expect(payload.requestId).toBe(prepared.requestId);
        return Promise.resolve(manifest(prepared));
      }
    });
    await expect(
      resumeContentUpload({ database, record: persisted, api: resumedApi })
    ).resolves.toMatchObject({ kind: "committed" });
    expect(resumedIndexes).toEqual([1, 2]);
  });

  it("distinguishes protected browser capacity from server storage capacity", async () => {
    const database = await openDatabase();
    const prepared = await preparedContent();
    let began = false;
    const localCapacityDatabase: FortnoteIndexedDb = {
      ...database,
      putContentTransfer() {
        return Promise.reject(new IndexedDbCapacityError());
      }
    };
    const neverCalledApi = fakeApi({
      beginContentUpload(payload) {
        began = true;
        return Promise.resolve(status(payload.uploadId, []));
      }
    });
    await expect(
      uploadPreparedContent({
        userId: "user-a",
        database: localCapacityDatabase,
        prepared,
        api: neverCalledApi
      })
    ).resolves.toMatchObject({ kind: "local-capacity" });
    expect(began).toBe(false);

    const serverApi = fakeApi({
      beginContentUpload() {
        return Promise.reject(
          new ApiRequestError(413, "storage_limit", "Storage quota exceeded")
        );
      }
    });
    await expect(
      uploadPreparedContent({
        userId: "user-a",
        database,
        prepared,
        api: serverApi
      })
    ).resolves.toMatchObject({ kind: "server-capacity" });
    await expect(
      database.getContentTransfer("user-a", prepared.uploadId)
    ).resolves.not.toBeNull();
  });

  it("downloads and verifies the complete manifest before authenticated decryption", async () => {
    const prepared = await preparedContent();
    const contentManifest = manifest(prepared);
    const api = fakeApi({
      downloadContentChunk(_manifestId, chunkIndex) {
        const chunk = prepared.chunks[chunkIndex];
        if (!chunk) {
          throw new Error("Unexpected chunk index");
        }
        return Promise.resolve({
          bytes: chunk.cipherBytes,
          cipherHash: chunk.cipherHash,
          cipherLength: chunk.cipherBytes.byteLength,
          nonce: chunk.nonce
        });
      }
    });
    const plaintext = Uint8Array.from({ length: 37 }, (_, index) => index);
    await expect(
      downloadVerifiedContent({
        manifest: contentManifest,
        cryptoOwnerId: prepared.cryptoOwnerId,
        noteKey: noteKey(),
        api
      })
    ).resolves.toEqual(plaintext);

    const corruptApi = fakeApi({
      downloadContentChunk(_manifestId, chunkIndex) {
        const chunk = prepared.chunks[chunkIndex];
        if (!chunk) {
          throw new Error("Unexpected chunk index");
        }
        const bytes = chunk.cipherBytes.slice();
        if (chunkIndex === 1) {
          bytes[0] = (bytes[0] ?? 0) ^ 1;
        }
        return Promise.resolve({
          bytes,
          cipherHash: chunk.cipherHash,
          cipherLength: bytes.byteLength,
          nonce: chunk.nonce
        });
      }
    });
    await expect(
      downloadVerifiedContent({
        manifest: contentManifest,
        cryptoOwnerId: prepared.cryptoOwnerId,
        noteKey: noteKey(),
        api: corruptApi
      })
    ).rejects.toThrow("hash mismatch");
  });
});

async function openDatabase(): Promise<FortnoteIndexedDb> {
  const database = await openFortnoteIndexedDb({
    factory: fakeIndexedDb,
    name: `fortnote-content-transfer-${crypto.randomUUID()}`
  });
  databases.push(database);
  return database;
}

async function preparedContent() {
  return encryptContentChunksV2({
    cryptoOwnerId: "owner-a",
    noteId: crypto.randomUUID(),
    sectionId: crypto.randomUUID(),
    keyEpoch: 2,
    updateId: crypto.randomUUID(),
    uploadId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    kind: "update",
    noteKey: noteKey(),
    plaintext: Uint8Array.from({ length: 37 }, (_, index) => index),
    maxCipherChunkBytes: 32
  });
}

function noteKey(): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, index) => index + 1);
}

function status(uploadId: string, receivedChunkIndexes: number[]) {
  return {
    uploadId,
    status: "receiving" as const,
    receivedChunkIndexes,
    reservedBytes: 85,
    expiresAt: "2099-01-01T00:00:00.000Z"
  };
}

function manifest(
  prepared: Awaited<ReturnType<typeof preparedContent>>
): ContentManifestSummary {
  return {
    manifestId: prepared.requestId,
    uploadId: prepared.uploadId,
    updateId: prepared.updateId,
    noteId: prepared.noteId,
    sectionId: prepared.sectionId,
    cryptoOwnerId: prepared.cryptoOwnerId,
    keyEpoch: prepared.keyEpoch,
    kind: prepared.kind,
    firstSequence: 1,
    lastSequence: 1,
    totalCipherBytes: prepared.totalCipherBytes,
    chunkCount: prepared.chunkCount,
    manifestHash: prepared.manifestHash
  };
}

function fakeApi(overrides: Partial<ContentTransferApi>): ContentTransferApi {
  return {
    abortContentUpload() {
      return Promise.resolve(undefined);
    },
    beginContentUpload(payload) {
      return Promise.resolve(status(payload.uploadId, []));
    },
    commitContentManifest(uploadId, payload) {
      return Promise.reject(
        new Error(`Unexpected commit ${uploadId}:${payload.requestId}`)
      );
    },
    downloadContentChunk(manifestId, chunkIndex) {
      return Promise.reject(
        new Error(`Unexpected download ${manifestId}:${String(chunkIndex)}`)
      );
    },
    inspectContentUpload(uploadId) {
      return Promise.resolve(status(uploadId, []));
    },
    putContentChunk() {
      return Promise.resolve();
    },
    ...overrides
  };
}
