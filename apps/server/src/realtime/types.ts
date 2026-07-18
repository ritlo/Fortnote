import type { CrdtManifestReferenceV2 } from "@fortnote/shared";

export interface RealtimePublisher {
  closeNoteAccess: (noteId: string, userId: string) => void;
  closeSession: (sessionId: string) => void;
  publishEvents: (cursors: number[]) => void;
  publishContentManifest: (reference: CrdtManifestReferenceV2) => void;
}
