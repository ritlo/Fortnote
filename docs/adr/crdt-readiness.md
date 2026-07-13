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
- Epoch-rotation handling for open and closed documents. When a note's key epoch
  advances, the client clears pending update IDs, discards old-epoch queued
  updates from the outbox, and broadcasts an encrypted `crdt-checkpoint` under
  the new epoch. If no CRDT binding exists, it seeds the checkpoint from the
  decrypted whole-note snapshot. The server inserts the checkpoint and compacts
  only the covered same-note, same-epoch updates.
- Reconnect/retry, duplicate, and rotation tests covering the outbox, server
  acknowledgement, and hub rotation.
- Additive snapshot migration. After replaying stored updates the server sends a
  `crdt-sync` marker carrying a `hasUpdates` flag. For an empty CRDT epoch the
  client deterministically seeds the full title/body snapshot from the note
  (`snapshotUpdate` builds a Y.Doc with a client ID derived from the note ID, so
  the seed is reproducible) and, for non-viewers, persists it as an encrypted
  `crdt-checkpoint`. Existing CRDT epochs (`hasUpdates`) are no longer reseeded
  from snapshots. Edits made during initial sync are queued as a pending patch
  and replayed once sync completes, so no keystrokes are dropped.
- Shared update tracking for compaction. A single `trackUpdate` records both
  local (`broadcastUpdate`) and remote (`receiveCrdtUpdate`) update IDs in
  `pendingUpdateIds` and triggers a `crdt-checkpoint` once the pending count
  crosses the threshold, so solo editors (local-only traffic) now also compact
   their updates rather than only peers receiving remote updates.
- A server-side per-note/key-epoch envelope ceiling
  (`MAX_CRDT_ENVELOPES_PER_EPOCH = 128`). Inbound updates are idempotent: a
  duplicate by `updateId` is detected and still acknowledged, so client retries
  never wedge. The stored count is checkpoint-aware — a `crdt-checkpoint`
  subtracts its compacted IDs — so reducing checkpoints are admitted even at the
   ceiling while net growth stays bounded. `publishCrdtUpdate` now returns a
   discriminated outcome (`accepted` | `forbidden` | `storage-limit`) instead of
   a boolean; an update that would exceed the ceiling yields an explicit
   `crdt-reject` message (with `reason: "storage-limit"`) rather than a silent
   non-acknowledgement. The client surfaces the rejection as a user-facing error
   and keeps the encrypted update in the outbox for retry once compaction frees
   space.

Still open:

- State-vector exchange is intentionally deferred. Full encrypted update replay
  already reconciles reconnecting peers correctly, so add it only if replay
  performance becomes measurable. The durable outbox covers offline durability.
- Protocol hardening and security review of the CRDT data plane. Storage-limit
  enforcement (per-epoch envelope ceiling and `crdt-reject`) is implemented; a
  full security review remains.

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
