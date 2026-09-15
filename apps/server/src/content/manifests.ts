import { createHash } from "node:crypto";

export type ContentKind = "update" | "checkpoint" | "root-update";

export interface ContentManifestSummary {
  manifestId: string;
  uploadId: string;
  updateId: string;
  noteId: string;
  sectionId: string;
  cryptoOwnerId: string;
  keyEpoch: number;
  kind: ContentKind;
  firstSequence: number;
  lastSequence: number;
  totalCipherBytes: number;
  chunkCount: number;
  manifestHash: string;
  checkpointSequenceCutoff?: number;
}

export type ManifestCommitOutcome =
  | { kind: "committed"; manifest: ContentManifestSummary }
  | {
      kind:
        | "unauthorized"
        | "not-found"
        | "conflict"
        | "rotation-pending"
        | "stale-epoch"
        | "chunk-missing"
        | "manifest-mismatch"
        | "storage-limit";
    };

export interface CommitContentManifestInput {
  sessionId: string;
  userId: string;
  uploadId: string;
  requestId: string;
  updateId: string;
  expectedKeyEpoch: number;
}

export interface ContentManifestRepository {
  commit(input: CommitContentManifestInput): Promise<ManifestCommitOutcome>;
}

export interface ContentChunkDescriptor {
  chunkIndex: number;
  cipherLength: number;
  cipherHash: string;
  nonce: Buffer;
}

export function contentManifestHash(chunks: ContentChunkDescriptor[]): string {
  const hash = createHash("sha256");
  for (const chunk of [...chunks].sort(
    (left, right) => left.chunkIndex - right.chunkIndex
  )) {
    hash.update(
      `${String(chunk.chunkIndex)}:${String(chunk.cipherLength)}:${chunk.cipherHash}:${chunk.nonce.toString("base64")}\n`
    );
  }
  return hash.digest("hex");
}
