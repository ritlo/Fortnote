# ADR: CRDT Readiness Boundary

## Status

The automated CRDT merge blockers are fixed and covered by regression tests.
Browser and manual owner/editor verification remain before merge.

## Resolved merge blockers

- Key rotation must stop before changing the server key when any CRDT envelope
  failed decryption. A checkpoint must not clear that failure or compact prior
  epochs over partial state.
- On a fresh CRDT open, a newer whole-note snapshot from a legacy client must be
  migrated instead of discarded merely because older CRDT updates exist.
- An envelope over the transport limit is a terminal `payload-too-large` error,
  not a retryable storage-capacity error. The client must reject its delivery and
  remove it from the durable outbox.
- If localStorage cleanup fails after an acknowledgement, stale persisted data
  must not resurrect and resend the acknowledged update.

## Remaining merge gate

- The browser suite and manual cross-account owner/editor verification must pass,
  including concurrent edits followed by reconnect and reload.

## Final verification

Automated merge gates now cover:

- Undecryptable CRDT history must remain stored and synchronization must fail
  visibly. A client must never checkpoint a stale snapshot over envelopes it could
  not decrypt or list those envelopes for compaction.
- Realtime transport must explicitly reject an envelope larger than its supported
  limit without broadcasting it. The accepted realtime document size must be
  aligned with the existing 1 MiB note API contract so a valid saved note cannot
  silently fall outside CRDT persistence.
- `pnpm test` must include and pass the workspace typecheck, preventing a branch
  that cannot produce a client build from passing the normal merge gate.

State-vector optimization, IndexedDB outbox storage, and an external production
security audit remain deferred until replay performance, browser quota pressure,
or release policy requires them.

## Context

The collaboration V1 branch added the control plane used by live co-editing:
authenticated realtime transport, note membership,
roles, key sharing, revocation, presence, and durable control-event replay.

V1 content synchronization saved encrypted whole-note snapshots with optimistic
versions. This branch keeps that snapshot path during migration and adds Yjs
updates for simultaneous character-level edits.

Completing the CRDT data plane requires an encrypted update format, update storage,
snapshotting, compaction, offline reconciliation, key-epoch handling, and a
migration path for existing notes.

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
  Snapshot reloads refresh metadata but do not replace an already-open Y.Doc;
  legacy snapshot content is picked up on the next fresh CRDT open.
- CRDT support changes the content synchronization data plane and adds
  `note_updates` plus versioned realtime messages, but does not redesign
  membership, authorization, sharing keys, revocation, attachments, or presence.
- Revocation tests must verify key-epoch checkpointing
  and ensure revoked users cannot fetch updates from the new epoch.
