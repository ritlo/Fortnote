export interface RealtimePublisher {
  closeSession: (sessionId: string) => void;
  publishEvents: (cursors: number[]) => void;
}
