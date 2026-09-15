import type { DecryptedNote } from "../../store/appStore";
import { bindings } from "./state";
import type { CrdtTransport } from "./transport";

let transport: CrdtTransport | null = null;
const transportWaiters: {
  reject: (error: Error) => void;
  resolve: (next: CrdtTransport) => void;
}[] = [];

export function getCrdtTransport(): CrdtTransport | null {
  return transport;
}

export function waitForCrdtTransport(): Promise<CrdtTransport> {
  return transport
    ? Promise.resolve(transport)
    : new Promise((resolve, reject) => transportWaiters.push({ reject, resolve }));
}

export function setCrdtTransport(next: CrdtTransport | null): void {
  transport = next;
  for (const binding of bindings.values()) {
    binding.ready = false;
    binding.provider.isSynced = false;
  }
  if (next) {
    transportWaiters.splice(0).forEach(({ resolve }) => {
      resolve(next);
    });
    for (const binding of bindings.values()) {
      const note = binding.note as DecryptedNote | undefined;
      if (note) {
        next.subscribe(
          note.id,
          binding.sectionId,
          note.keyEpoch,
          binding.observedServerSequence
        );
      }
    }
  }
}

export function rejectCrdtTransportWaiters(error: Error): void {
  transportWaiters.splice(0).forEach(({ reject }) => {
    reject(error);
  });
}
