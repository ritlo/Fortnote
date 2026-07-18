import type {
  EncryptedOutboxRecord,
  FortnoteIndexedDb
} from "../lib/indexedDb";

export interface OutboxFence {
  noteId: string;
  sectionId: string;
  keyEpoch: number;
}

export type TerminalOutboxReason = "forbidden" | "stale-epoch";

export interface EncryptedSectionDraft extends OutboxFence {
  userId: string;
  reason: TerminalOutboxReason;
  updateIds: string[];
  createdAt: number;
  retainedAt: number;
}

export type EncryptedOutboxStore = Pick<
  FortnoteIndexedDb,
  | "acknowledgeOutbox"
  | "acquireLease"
  | "getAcknowledgement"
  | "listOutbox"
  | "preserveOutboxFence"
  | "putOutbox"
  | "subscribe"
>;

export type EncryptedOutboxTransport = (record: EncryptedOutboxRecord) => void | Promise<void>;

interface CreateEncryptedOutboxOptions {
  database: EncryptedOutboxStore;
  leaseDurationMs?: number;
  now?: () => number;
  ownerId: string;
  retryDelayMs?: number;
  send?: EncryptedOutboxTransport;
  userId: string;
}

export interface EncryptedOutbox {
  acknowledge(record: EncryptedOutboxRecord, serverSequence: number): Promise<void>;
  activate(fence: OutboxFence): Promise<number>;
  close(): void;
  deactivate(fence: OutboxFence): void;
  enqueue(record: EncryptedOutboxRecord): Promise<void>;
  flush(fence: OutboxFence): Promise<number>;
  listRecoverableDrafts(): Promise<EncryptedSectionDraft[]>;
  preserveTerminalRejection(
    updateId: string,
    sectionId: string,
    reason: TerminalOutboxReason
  ): Promise<EncryptedSectionDraft | null>;
  setTransport(send: EncryptedOutboxTransport | null): void;
}

const DEFAULT_LEASE_DURATION_MS = 10_000;
const DEFAULT_RETRY_DELAY_MS = 2_000;

export function createEncryptedOutbox({
  database,
  leaseDurationMs = DEFAULT_LEASE_DURATION_MS,
  now = Date.now,
  ownerId,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  send,
  userId
}: CreateEncryptedOutboxOptions): EncryptedOutbox {
  const activeFences = new Map<string, OutboxFence>();
  const flushes = new Map<string, Promise<number>>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const terminalFences = new Map<string, TerminalOutboxReason>();
  let closed = false;
  let transport = send ?? null;

  const unsubscribe = database.subscribe((change) => {
    if (change.store === "outbox" && change.userId === userId) {
      for (const fence of activeFences.values()) {
        scheduleFlush(fence, 0);
      }
    }
  });

  async function acknowledge(
    record: EncryptedOutboxRecord,
    serverSequence: number
  ): Promise<void> {
    assertAccount(record);
    try {
      await database.acknowledgeOutbox(record, serverSequence);
    } catch (error) {
      if (!(await database.getAcknowledgement(record))) {
        throw error;
      }
    }
  }

  async function activate(fence: OutboxFence): Promise<number> {
    const key = fenceKey(fence);
    const terminal = (await recordsFor(fence)).find(
      (record) => record.state === "terminal-rejected" && record.terminalReason
    );
    if (terminal?.terminalReason) {
      await preserveFence(fence, terminal.terminalReason);
      return 0;
    }
    activeFences.set(key, { ...fence });
    return flush(fence);
  }

  function close(): void {
    if (closed) {
      return;
    }
    closed = true;
    unsubscribe();
    for (const timer of retryTimers.values()) {
      clearTimeout(timer);
    }
    retryTimers.clear();
    activeFences.clear();
    terminalFences.clear();
    transport = null;
  }

  function deactivate(fence: OutboxFence): void {
    const key = fenceKey(fence);
    activeFences.delete(key);
    const timer = retryTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      retryTimers.delete(key);
    }
  }

  async function enqueue(record: EncryptedOutboxRecord): Promise<void> {
    assertAccount(record);
    const fence = fenceFor(record);
    const terminalReason = terminalFences.get(fenceKey(fence));
    await database.putOutbox(terminalReason
      ? {
          ...record,
          state: "terminal-rejected",
          terminalReason,
          terminalRejectedAt: now(),
          updatedAt: now()
        }
      : record);
    if (terminalReason) {
      return;
    }
    if (isActive(fence) && transport) {
      await flush(fence);
    }
  }

  async function listRecoverableDrafts(): Promise<EncryptedSectionDraft[]> {
    const records = (await database.listOutbox(userId)).filter(
      (record) => record.state === "terminal-rejected" && record.terminalReason
    );
    const grouped = new Map<string, EncryptedOutboxRecord[]>();
    for (const record of records) {
      const key = fenceKey(record);
      grouped.set(key, [...(grouped.get(key) ?? []), record]);
    }
    return [...grouped.values()].map(sectionDraftFor);
  }

  async function preserveTerminalRejection(
    updateId: string,
    sectionId: string,
    reason: TerminalOutboxReason
  ): Promise<EncryptedSectionDraft | null> {
    const rejected = (await database.listOutbox(userId)).find(
      (record) => record.updateId === updateId && record.sectionId === sectionId
    );
    return rejected ? preserveFence(fenceFor(rejected), reason) : null;
  }

  async function preserveFence(
    fence: OutboxFence,
    reason: TerminalOutboxReason
  ): Promise<EncryptedSectionDraft | null> {
    const key = fenceKey(fence);
    terminalFences.set(key, reason);
    deactivate(fence);
    const rejectedAt = now();
    const retained = await database.preserveOutboxFence(
      { ...fence, userId },
      reason,
      rejectedAt
    );
    if (retained.length === 0) {
      return null;
    }
    return sectionDraftFor(retained);
  }

  async function recordsFor(fence: OutboxFence): Promise<EncryptedOutboxRecord[]> {
    return (await database.listOutbox(userId)).filter((record) =>
      matchesFence(record, fence)
    );
  }

  function flush(fence: OutboxFence): Promise<number> {
    const key = fenceKey(fence);
    const current = flushes.get(key);
    if (current) {
      return current;
    }
    const pending = flushFence(fence).finally(() => {
      if (flushes.get(key) === pending) {
        flushes.delete(key);
      }
    });
    flushes.set(key, pending);
    return pending;
  }

  async function flushFence(fence: OutboxFence): Promise<number> {
    if (closed || !getTransport() || !isActive(fence)) {
      return 0;
    }

    const records = (await recordsFor(fence)).filter(
      (record) => record.state !== "terminal-rejected"
    );
    if (records.length === 0 || !isActive(fence)) {
      cancelRetry(fence);
      return 0;
    }

    const currentTime = now();
    const acquired = await database.acquireLease(
      leaseKey(userId, fence),
      ownerId,
      currentTime,
      leaseDurationMs
    );
    if (!acquired || !isActive(fence)) {
      scheduleFlush(fence, leaseDurationMs);
      return 0;
    }

    let sent = 0;
    let hasPending = false;
    for (const record of records) {
      if (!isActive(fence) || !getTransport()) {
        break;
      }
      const acknowledgement = await database.getAcknowledgement(record);
      if (acknowledgement) {
        await acknowledge(record, acknowledgement.serverSequence);
        continue;
      }
      if (record.state === "sending" && record.updatedAt + retryDelayMs > now()) {
        hasPending = true;
        continue;
      }

      const sending: EncryptedOutboxRecord = {
        ...record,
        attempts: record.attempts + 1,
        state: "sending",
        updatedAt: now()
      };
      await database.putOutbox(sending);
      const currentTransport = getTransport();
      if (!isActive(fence) || !currentTransport) {
        break;
      }
      try {
        await currentTransport(sending);
        sent += 1;
      } catch {
        // The durable record remains eligible for the scheduled retry.
      }
      hasPending = true;
    }

    if (hasPending) {
      scheduleFlush(fence, retryDelayMs);
    } else {
      cancelRetry(fence);
    }
    return sent;
  }

  function setTransport(next: EncryptedOutboxTransport | null): void {
    transport = next;
    if (next) {
      for (const fence of activeFences.values()) {
        scheduleFlush(fence, 0);
      }
    }
  }

  function getTransport(): EncryptedOutboxTransport | null {
    return transport;
  }

  function scheduleFlush(fence: OutboxFence, delayMs: number): void {
    if (closed || !transport || !isActive(fence)) {
      return;
    }
    const key = fenceKey(fence);
    const existing = retryTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    retryTimers.set(
      key,
      setTimeout(() => {
        retryTimers.delete(key);
        void flush(fence);
      }, delayMs)
    );
  }

  function cancelRetry(fence: OutboxFence): void {
    const key = fenceKey(fence);
    const timer = retryTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      retryTimers.delete(key);
    }
  }

  function isActive(fence: OutboxFence): boolean {
    const active = activeFences.get(fenceKey(fence));
    return active !== undefined && matchesFence(active, fence);
  }

  function assertAccount(record: Pick<EncryptedOutboxRecord, "userId">): void {
    if (record.userId !== userId) {
      throw new Error("Encrypted outbox account changed");
    }
  }

  return {
    acknowledge,
    activate,
    close,
    deactivate,
    enqueue,
    flush,
    listRecoverableDrafts,
    preserveTerminalRejection,
    setTransport
  };
}

function sectionDraftFor(records: EncryptedOutboxRecord[]): EncryptedSectionDraft {
  const first = records[0];
  if (!first?.terminalReason) {
    throw new Error("Recoverable encrypted draft is missing its terminal reason");
  }
  return {
    userId: first.userId,
    noteId: first.noteId,
    sectionId: first.sectionId,
    keyEpoch: first.keyEpoch,
    reason: first.terminalReason,
    updateIds: records.map((record) => record.updateId),
    createdAt: Math.min(...records.map((record) => record.createdAt)),
    retainedAt: Math.max(
      ...records.map((record) => record.terminalRejectedAt ?? record.updatedAt)
    )
  };
}

function fenceFor(record: EncryptedOutboxRecord): OutboxFence {
  return {
    keyEpoch: record.keyEpoch,
    noteId: record.noteId,
    sectionId: record.sectionId
  };
}

function fenceKey(fence: OutboxFence): string {
  return JSON.stringify([fence.noteId, fence.sectionId, fence.keyEpoch]);
}

function leaseKey(userId: string, fence: OutboxFence): string {
  return `${userId}:${fenceKey(fence)}`;
}

function matchesFence(
  left: Pick<EncryptedOutboxRecord, "noteId" | "sectionId" | "keyEpoch"> | OutboxFence,
  right: OutboxFence
): boolean {
  return (
    left.noteId === right.noteId &&
    left.sectionId === right.sectionId &&
    left.keyEpoch === right.keyEpoch
  );
}
