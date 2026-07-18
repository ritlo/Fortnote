export interface RealtimePublisher {
  closeNoteAccess: (noteId: string, userId: string) => void;
  closeSession: (sessionId: string) => void;
  publishEvents: (cursors: number[]) => void;
}
