export interface SetNoteDeletedInput {
  noteId: string;
  ownerUserId: string;
  actorUserId: string;
  noteVersion: number;
  deleted: boolean;
  clientInstanceId?: string;
}

export interface PermanentlyDeleteNoteInput {
  noteId: string;
  ownerUserId: string;
  actorUserId: string;
  noteVersion: number;
  clientInstanceId?: string;
}

export interface PermanentlyDeleteNoteOutcome {
  cursor: number;
  storageKeys: string[];
}

export interface NoteLifecycleRepository {
  setDeleted(input: SetNoteDeletedInput): Promise<number | null>;
  permanentlyDelete(
    input: PermanentlyDeleteNoteInput
  ): Promise<PermanentlyDeleteNoteOutcome | null>;
}
