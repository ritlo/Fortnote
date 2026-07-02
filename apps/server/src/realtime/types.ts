export interface RealtimePublisher {
  publishEvents: (cursors: number[]) => void;
}
