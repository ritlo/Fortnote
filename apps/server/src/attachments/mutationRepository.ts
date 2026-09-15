export type AttachmentGateError =
  | "conflict"
  | "duplicate"
  | "not-found"
  | "quota"
  | "rotation-pending"
  | "stale-epoch"
  | "unauthorized";

export type AttachmentReservationOutcome =
  | {
      kind: "reserved";
      expectedKeyEpoch: number;
      ownerUserId: string;
    }
  | { kind: AttachmentGateError };

export interface ReserveAttachmentUploadInput {
  noteId: string;
  userId: string;
  attachmentId: string;
  size: number;
  expectedKeyEpoch?: number;
  storageQuotaBytes: number;
}

export interface CommitAttachmentUploadInput {
  sessionId: string;
  actorUserId: string;
  noteId: string;
  ownerUserId: string;
  expectedKeyEpoch: number;
  storageKey: string;
  attachment: {
    id: string;
    size: number;
    filename: string;
    mimeType: string;
    metadataCipher: string | null;
    metadataNonce: string | null;
    metadataFormatVersion: number | null;
    encryptedAttachmentKey: string;
    attachmentKeyNonce: string;
    fileNonce: string;
  };
  clientInstanceId?: string;
}

export type CommitAttachmentUploadOutcome =
  { kind: "committed"; cursor: number } | { kind: AttachmentGateError };

export interface DeleteAttachmentInput {
  attachmentId: string;
  noteId: string;
  ownerUserId: string;
  size: number;
  actorUserId: string;
  noteVersion: number;
  clientInstanceId?: string;
}

export type DeleteAttachmentOutcome =
  { kind: "deleted"; cursor: number } | { kind: "not-found" };

export interface AttachmentMutationRepository {
  reserve(input: ReserveAttachmentUploadInput): Promise<AttachmentReservationOutcome>;
  commit(input: CommitAttachmentUploadInput): Promise<CommitAttachmentUploadOutcome>;
  release(ownerUserId: string, size: number): Promise<void>;
  delete(input: DeleteAttachmentInput): Promise<DeleteAttachmentOutcome>;
}
