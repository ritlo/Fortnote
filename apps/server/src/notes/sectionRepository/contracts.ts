export interface SectionRecord {
  id: string;
  noteId: string;
  createdEpoch: number;
  currentSequence: number;
  initializationManifestId: string | null;
  isDeleted: boolean;
}

export interface SectionWriteInput {
  sessionId: string;
  userId: string;
  noteId: string;
  sectionId: string;
  expectedKeyEpoch: number;
  expectedRootVersion: number;
  clientInstanceId?: string;
}

export type SectionRejectionCode =
  | "forbidden"
  | "last-section"
  | "rotation-pending"
  | "stale-epoch"
  | "stale-version";

type SectionFenceRejectionCode = Exclude<SectionRejectionCode, "last-section">;

export type LegacySectionReservationOutcome =
  | {
      status: "reserved" | "pending" | "complete";
      sectionId: string;
      keyEpoch: number;
      rootVersion: number;
      version: number;
      manifestId: string | null;
      changed: boolean;
      eventCursor: number | null;
    }
  | { status: "rejected"; code: SectionFenceRejectionCode };

export type SectionMutationOutcome =
  | {
      status: "created" | "already-created" | "deleted" | "already-deleted";
      rootVersion: number;
      version: number;
      eventCursor: number | null;
    }
  | { status: "rejected"; code: SectionRejectionCode };

export interface InitializeSectionInput extends SectionWriteInput {
  manifestId: string;
}

export type SectionInitializationOutcome =
  | {
      status: "installed" | "already-initialized";
      manifestId: string;
      rootVersion: number;
      version: number;
      eventCursor: number | null;
    }
  | { status: "rejected"; code: SectionFenceRejectionCode };

export interface NoteSectionRepository {
  list(noteId: string): Promise<SectionRecord[]>;
  reserveLegacy(
    input: SectionWriteInput
  ): Promise<LegacySectionReservationOutcome>;
  create(input: SectionWriteInput): Promise<SectionMutationOutcome>;
  tombstone(input: SectionWriteInput): Promise<SectionMutationOutcome>;
  initialize(
    input: InitializeSectionInput
  ): Promise<SectionInitializationOutcome>;
}
