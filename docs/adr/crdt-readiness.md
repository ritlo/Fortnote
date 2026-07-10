# ADR: CRDT Readiness Boundary

## Status

Accepted for collaboration V1. Full CRDT implementation is deferred.

## Context

The collaboration branch adds the control plane required by both snapshot sync
and future live co-editing: authenticated realtime transport, note membership,
roles, key sharing, revocation, presence, and durable control-event replay.

V1 content synchronization still saves an encrypted whole-note snapshot and
uses optimistic note versions. This provides realtime propagation after save,
but it does not merge simultaneous character-level edits.

Implementing a CRDT also requires an encrypted update format, update storage,
snapshotting, compaction, offline reconciliation, key-epoch handling, and a
migration path for existing notes. That work should not be mixed with the
remaining V1 lifecycle fixes unless live co-editing is a release requirement.

## Decision

Keep full CRDT support out of the collaboration V1 merge gate. Preserve a clear
boundary so CRDT support later replaces the content synchronization data plane
without replacing collaboration authorization or key management.

The following remain shared infrastructure:

- Session-bound WebSocket connections.
- Note memberships, roles, and access checks.
- Sharing keys and per-recipient note-key shares.
- Note-key rotation after revocation.
- Attachment access and key wrapping.
- Presence and durable collaboration-control events.

The future CRDT data plane will:

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

- Collaboration V1 can merge after its audited lifecycle defects are fixed,
  without implementing a CRDT.
- Product copy must call the current behavior realtime snapshot synchronization,
  not simultaneous live editing.
- Adding CRDT support later changes the content save/load pipeline and adds
  storage/protocol components, but does not redesign membership, authorization,
  sharing keys, revocation, attachments, or presence.
- Revocation tests for future CRDT support must verify key-epoch checkpointing
  and ensure revoked users cannot fetch updates from the new epoch.
