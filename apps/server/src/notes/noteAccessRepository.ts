import type { NoteAccess } from "./access.js";

export interface NoteAccessRepository {
  find(noteId: string, userId: string): Promise<NoteAccess | undefined>;
}
