# Collaboration Branch Audit

Scope: `master...collaboration` at `a52b8a6`.

## Findings

### High: Trust confirmation can disclose a different note than the one reviewed

The pending TOFU decision stores the collaborator and role, but not the note that initiated the invite (`apps/client/src/components/SharingPanel.tsx:35`). Changing the selected note does not clear that state (`apps/client/src/components/SharingPanel.tsx:95`), and confirmation later calls `shareWithPublicKey`, which reads the currently selected note (`apps/client/src/components/SharingPanel.tsx:162`, `apps/client/src/components/SharingPanel.tsx:190`). A user can request an invite for note A, select owned note B while the fingerprint prompt is open, then click **Trust key** and unintentionally share note B.

Bind the pending decision to the originating note ID and key material, reject confirmation if the selection changed, and clear pending trust when `selectedNote.id` changes. Add a component test that switches notes before confirming trust.

### High: Permanent-delete tombstones are invisible to collaborators

Permanent deletion removes the note first, which cascades all membership rows, and then writes `note.permanently_deleted` with a `visibleUserIds` payload (`apps/server/src/notes/routes.ts:893`, `apps/server/src/notes/routes.ts:898`). Event visibility only accepts a current active membership, actor-scoped events with no note, or a targeted `membership.revoked` event (`apps/server/src/events/replay.ts:63`). It never consults `visibleUserIds`. Consequently the new tombstone is delivered to nobody, and an offline collaborator also loses visibility of earlier soft-delete events once the memberships are gone. Their decrypted local copy can remain indefinitely until a full manual reload.

Persist immutable recipients for deletion tombstones and include them in replay, acknowledgement, and retention logic. Cover both live and offline collaborators in route/realtime tests.

### High: Selecting another note discards an incomplete revocation rotation

When post-revoke key rotation fails, the only recovery record is `revocationRotationFailure`. `setSelectedNoteId` clears that record on every selection change (`apps/client/src/store/appStore.ts:186`). The sharing panel only renders retry UI from that record, so navigating to another note permanently removes the same-session recovery action even though the revoked collaborator's old note key has not been rotated.

Keep pending rotations per note until a successful rotation, and surface them independently of current selection. Prefer persisting enough encrypted recovery state to survive reload/lock; at minimum, do not clear the failure on navigation and add a test for switching away and back.

### Medium: Events are acknowledged before their invalidations are applied

Both replay and live handlers call `processCollaborationEvents` and then launch `reloadAfterEvents` independently (`apps/client/src/hooks/useRealtimeEvents.ts:140`, `apps/client/src/hooks/useRealtimeEvents.ts:148`). `processCollaborationEvents` immediately acknowledges the highest cursor (`apps/client/src/hooks/useRealtimeEvents.ts:220`, `apps/client/src/hooks/useRealtimeEvents.ts:235`). If the subsequent list request or decryption fails, the server has already advanced and may prune that cursor; reconnect will not replay the invalidation, while the current tab remains stale. The in-memory event list is not replayed locally after a failed reload.

Await successful invalidation handling before acknowledging. Retry the refetch/decrypt operation itself, not only the acknowledgement, and test a successful acknowledgement followed by a failed note reload.

### Medium: WebSocket authorization outlives the backing session

The session is validated only during the HTTP upgrade (`apps/server/src/realtime/server.ts:42`). The hub retains only user identity and never rechecks the session when publishing events or accepting presence (`apps/server/src/realtime/hub.ts:63`, `apps/server/src/realtime/hub.ts:78`). Deleting the session on logout, reaching the 30-minute idle expiry, or reaching absolute expiry therefore leaves an already-open socket receiving collaboration metadata and sending presence until it disconnects.

Associate each client with its session ID, revalidate it periodically and before privileged message handling/delivery, and close matching sockets when a session is deleted. Add logout and expiry tests against an established socket.

### Medium: Updates from another tab for the same account are intentionally skipped

Every realtime reload uses `skipOwnEvents: true` (`apps/client/src/hooks/useRealtimeEvents.ts:143`, `apps/client/src/hooks/useRealtimeEvents.ts:151`), and the filter defines "own" solely as `event.actorUserId === userId` (`apps/client/src/hooks/useRealtimeEvents.ts:334`). Local optimistic state only covers the tab that performed the mutation. A second tab or device signed into the same account acknowledges the event without refetching, so note edits, folder changes, membership changes, and key rotations can remain stale there.

Use a per-client mutation/connection identifier to suppress only the exact originating client, or reload same-user events and guard against version regression. Add a two-tab, one-account test.

### Medium: Concurrent realtime refetches can overwrite newer state

Each message starts an unawaited `reloadAfterEvents` (`apps/client/src/hooks/useRealtimeEvents.ts:143`, `apps/client/src/hooks/useRealtimeEvents.ts:151`). Multiple events therefore run `loadDecryptedNotes` concurrently, and every completion replaces the entire notes array (`apps/client/src/hooks/useAppData.ts:35`). If an earlier snapshot takes longer to fetch or decrypt than a later snapshot, it can finish last and regress the UI to stale ciphertext/version data.

Serialize or coalesce invalidation reloads, or attach a monotonically increasing generation and discard stale completions. Add a test with deliberately reversed request/decryption completion order.

## Verification

- `pnpm test`: 111 tests passed.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed.
- `pnpm e2e`: 7 Playwright tests passed.

The passing suites do not exercise the lifecycle and ordering cases above.
