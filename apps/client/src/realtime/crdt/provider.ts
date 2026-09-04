import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

export class CrdtProvider {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  isSynced = false;
  private listeners = new Map<string, Set<(data?: unknown) => void>>();

  constructor(doc: Y.Doc) {
    this.doc = doc;
    this.awareness = new Awareness(doc);
  }

  on(event: string, callback: (data?: unknown) => void): void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(callback);
    this.listeners.set(event, set);
  }

  off(event: string, callback: (data?: unknown) => void): void {
    this.listeners.get(event)?.delete(callback);
  }

  emit(event: string, data?: unknown): void {
    if (event === "synced") {
      this.isSynced = true;
    }
    this.listeners.get(event)?.forEach((callback) => {
      callback(data);
    });
  }
}
