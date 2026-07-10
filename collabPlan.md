# Collaboration Branch Completion Plan

## Purpose

Complete the `collaboration` branch for merge into `master`. The implemented V1
uses encrypted whole-note snapshots, durable invalidation events, presence,
membership roles, per-recipient note-key shares, and client-side key rotation.

This file tracks only work that remains. Implemented architecture is documented
by the code, tests, `SECURITY.md`, and the ADRs under `docs/adr/`.

## Merge Blockers

1. Scope pending TOFU confirmation to the originating note.
   - Store the initiating `noteId` and note-key context with the pending action.
   - Clear or reject it when the selected note changes.
   - Test switching from note A to note B before confirmation.

2. Deliver permanent-delete tombstones after memberships are removed.
   - Capture immutable recipient user IDs before deleting the note.
   - Include those recipients in live delivery, replay, acknowledgement, and
     retention without restoring access to note data.
   - Test online and offline collaborators.

3. Preserve incomplete post-revoke key rotations per note.
   - Do not clear retry state when the owner selects another note.
   - Keep the failure discoverable until rotation succeeds.
   - Test navigating away and returning before retry.

4. Make realtime invalidation processing acknowledgement-safe and ordered.
   - Serialize or coalesce refetch/decryption work.
   - Prevent an older completion from replacing newer decrypted state.
   - Acknowledge only after invalidations succeed or are durably queued.
   - Retry failed processing rather than acknowledging receipt alone.

5. Synchronize mutations from another tab or device for the same account.
   - Do not suppress an event solely because `actorUserId` matches the current
     user.
   - Suppress only when a per-client mutation identifier proves local origin,
     or refetch all same-user events.

6. Enforce the backing session for the full WebSocket lifetime.
   - Bind each connection to its server session ID.
   - Close established sockets after logout, idle expiry, or absolute expiry.
   - Reject presence and stop metadata delivery after session invalidation.

The detailed evidence for these blockers is in `audit.md`.

## Test Gate

Add regression coverage for every blocker, including:

- Wrong-note trust confirmation.
- Live and replayed permanent deletion.
- Revocation rotation retry after navigation.
- Failed refetch before acknowledgement.
- Reversed refetch completion order.
- Two tabs using the same account.
- WebSocket logout and expiry.

Before merge, all of these commands must pass:

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm e2e
```

## Deferred Scope

- Full CRDT/live co-editing is deferred. V1 provides realtime encrypted
  snapshot synchronization and presence, not simultaneous character-level
  editing. The reusable control-plane boundary and future content-sync design
  are defined in `docs/adr/crdt-readiness.md`.
- Multi-process live fanout is deferred. The in-memory hub supports one server
  process; a later deployment milestone must add Redis/pubsub or an equivalent
  broker before horizontal scaling.
- Encrypted persistence of incomplete revocation rotations across lock/reload is
  deferred. V1 must preserve retry state across note navigation during the
  current unlocked vault session.

## Durable References

- `SECURITY.md`: current encryption, trust, revocation, replay, and session
  invariants.
- `docs/adr/public-key-trust.md`: local TOFU decision and confirmation rules.
- `docs/adr/crdt-readiness.md`: boundary between collaboration control state and
  future CRDT document synchronization.
- `audit.md`: unresolved findings for this branch; remove or archive it after
  every blocker is fixed and verified.
