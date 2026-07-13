# ADR: CRDT Readiness Boundary

## Status

In progress — CRDT data plane implementation started on `feat/crdt-realtime-collab`.

## Progress

Implemented in the first end-to-end slice:

- Yjs character-level co-editing for note titles and bodies.
- Versioned `crdt-v1` realtime capability negotiation.
- XChaCha20-Poly1305 encrypted update envelopes with associated data binding
  `cryptoOwnerId`, note ID, key epoch, update ID, and format version.
- A separate `note_updates` store with membership-checked replay and broadcast;
  `note_events` remains unchanged as the control/invalidation log.
- Key-epoch validation and epoch advancement during existing note-key rotation.
- Periodic update compaction into encrypted Yjs checkpoints. A client encodes the
  full document state as a `crdt-checkpoint` message once its pending-update count
  crosses a threshold; the server atomically inserts the checkpoint and deletes
  only the same-note, same-epoch update IDs it covers. The checkpoint envelope
  extends the update format with `compactedUpdateIds`, bound by dedicated
  `crdt-checkpoint` AEAD associated data, and `note_updates` gains `kind` and
  `compacted_update_ids` columns.
- A convergence test for two simulated Yjs clients and an end-to-end encrypted
  update storage/broadcast test.
- A durable encrypted localStorage outbox. Queued `crdt-update` and
  `crdt-checkpoint` messages persist across reconnects under
  `fortnote:crdt-outbox:v1`; the server replies with a `crdt-ack` per delivered
  update and the client drops acknowledged entries, so the outbox flushes
  idempotently on (re)connect and on each send with no server-side duplicates
  (the `note_updates` insert is idempotent on `updateId`).
- Epoch-rotation handling for open documents. When a note's key epoch advances
  while open, the binding clears pending update IDs, the client discards
  old-epoch queued updates from the outbox, and broadcasts an encrypted
  `crdt-checkpoint` under the new epoch; the server inserts the checkpoint and
  compacts only the covered same-note, same-epoch updates.
- Reconnect/retry, duplicate, and rotation tests covering the outbox, server
  acknowledgement, and hub rotation.

Still open:

- State-vector reconciliation for peers that reconnect after missed updates. The
  outbox is durable, but offline merge against peer state vectors is not yet
  implemented.
- A persisted migration checkpoint for existing whole-note snapshots. In the
  first slice, a snapshot field enters Yjs on its first live edit; rotation
  checkpointing currently only fires for documents left open at epoch advance.
- Protocol hardening, storage limits, and security review.

## Context

The collaboration V1 branch added the control plane used by live co-editing:
authenticated realtime transport, note membership,
roles, key sharing, revocation, presence, and durable control-event replay.

V1 content synchronization saved encrypted whole-note snapshots with optimistic
versions. This branch keeps that snapshot path during migration and adds Yjs
updates for simultaneous character-level edits.

Completing the CRDT data plane requires an encrypted update format, update storage,
snapshotting, compaction, offline reconciliation, key-epoch handling, and a
migration path for existing notes. The progress list records which parts now
exist and which remain release work.

## Decision

The V1 decision kept full CRDT support out of its merge gate. This branch now
adds the CRDT content data plane at the preserved boundary without replacing
collaboration authorization or key management.

The following remain shared infrastructure:

- Session-bound WebSocket connections.
- Note memberships, roles, and access checks.
- Sharing keys and per-recipient note-key shares.
- Note-key rotation after revocation.
- Attachment access and key wrapping.
- Presence and durable collaboration-control events.

The CRDT data plane follows these rules:

- Store encrypted document updates separately from `note_events`.
- Use a versioned update format and update-specific AEAD associated data that
  includes `cryptoOwnerId`, note ID, key epoch, and update identity.
- Periodically compact updates into encrypted snapshots.
- Preserve an additive migration path from existing whole-note snapshots.
- Create a compacted checkpoint under a new note-key epoch after revocation,
  then encrypt subsequent updates under that epoch.
- Advertise a versioned realtime capability before sending document-update
  messages so snapshot-only clients fail safely rather than misinterpreting
  CRDT traffic.

`note_events` remains the durable control/invalidation log. It must not become
an unbounded CRDT update log or contain plaintext document operations.

## Consequences

- Live sessions now merge title and body edits through encrypted Yjs updates;
  whole-note saves remain the existing durable snapshot path during migration.
- CRDT support changes the content synchronization data plane and adds
  `note_updates` plus versioned realtime messages, but does not redesign
  membership, authorization, sharing keys, revocation, attachments, or presence.
- Revocation tests must verify key-epoch checkpointing
  and ensure revoked users cannot fetch updates from the new epoch.
