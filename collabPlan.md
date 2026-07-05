# Full Collaboration Architecture Plan

## Summary

Build full multi-user encrypted collaboration on the `collaboration` branch. The design includes sharing, role-based access, key sharing, realtime sync, presence, and a future path to CRDT/live editing. Implementation should land in staged commits, but the data model must support full collaboration from the start.

Current owner-only assumptions must change: notes, folders, and attachments are keyed by `user_id`, and note crypto AAD uses `userId + noteId`. Collaboration requires explicit owner/crypto context on shared records.

## Implementation Audit

Current code covers the core V1 collaboration path: collaboration schema and migrations, sharing keys, local TOFU public-key trust, note memberships, note-key shares, membership-aware note/folder/attachment authorization, realtime WebSocket replay, presence, durable event cursors and retention, sharing UI, shared-note crypto context, client-orchestrated post-revoke key rotation, sharing-key rotation/cleanup, shared-note presentation, and a three-user collaboration E2E flow with online editor plus offline viewer.

Most V1 hardening and coverage work is now complete. Remaining work is limited to larger deferred architecture expansions that should not block an honest-but-curious-server V1.

| Area | Status | Remaining Task | Priority | Notes |
| --- | --- | --- | --- | --- |
| Event cursor lifecycle | Done | None for V1. | - | Server persists per-user acknowledged cursors and keeps revoke tombstone acknowledgement semantics. |
| Event retention | Done | None for V1. | - | Events prune only after all users who can replay them have acknowledged; revoked users still block their revoke tombstone until acknowledgement. |
| Transaction failure coverage | Done | None for V1. | - | Tests force event-write failures across note create/update/key rotation, membership invite/role/revoke, folder create/update/delete, and attachment upload/delete. |
| Revocation forward secrecy | Done for V1 | None for V1. | - | Owner revocation removes access immediately, then the client rotates the note key, re-encrypts the body, rewraps attachment keys, and writes fresh shares for remaining active members. If post-revoke rotation fails, the sharing panel surfaces a same-session retry action. |
| Sharing key rotation lifecycle | Done | Continue validating UX copy. | Low | Users can rotate sharing keys and clean up retired encrypted private keys that no active note shares reference. |
| Public key trust hardening | Done for local TOFU | Consider cross-device trust sync or sender-authenticated share envelopes later. | Low | Invite flow requires first-use fingerprint confirmation, stores encrypted local trust records, blocks same-version mismatches, and re-confirms new sharing-key versions; see `docs/adr/public-key-trust.md`. |
| Security/product documentation | Done | Keep docs aligned with future trust work. | Low | `SECURITY.md` documents metadata visibility, sealed-box sender-auth limits, key substitution risk, and revocation limits. |
| Shared attachment E2E depth | Done | None for V1. | - | E2E downloads/decrypts a shared attachment as editor and viewer and checks viewer mutation restrictions. |
| Client realtime unit coverage | Done | None for V1. | - | Hook tests cover acknowledgement, failed-ack retry, revoke-note removal, reload filtering, folder reload filtering, and cursor merging. |
| Shared folder UX | Done | None for V1. | - | Shared notes appear in the shared view rather than exposing owner folder hierarchy; owner folder changes have durable invalidations. |
| Presence placement | Done | None for V1. | - | Presence appears in membership rows and the editor header summary. |
| Multi-process realtime fanout | Deferred | Add Redis/pubsub or another broker before running multiple server processes. | Low | Current in-memory hub is acceptable for local/dev single-process deployment. |
| CRDT/live editing | Deferred | Add CRDT/Yjs or another live-editing model after whole-note encrypted snapshots are stable. | Low | Current model intentionally uses optimistic whole-note snapshots. |

## Current Remaining Work

- Multi-process realtime fanout is a deployment scaling task. Durable events preserve reconnect correctness, but live delivery between server processes needs Redis/pubsub or an equivalent broker.
- CRDT/live editing is a future product expansion. Keep the current whole-note encrypted snapshot model until the collaboration baseline has shipped.

## Key Changes

- Add collaboration schema:
  - `user_sharing_keys`: user ID, sharing key version, public key, root-key-encrypted private key, nonce, format version, timestamps. Primary key is `(user_id, sharing_key_version)` so old encrypted private keys can remain while shares reference old versions.
  - `note_memberships`: note ID, user ID, role `owner|editor|viewer`, status `active|invited|revoked`, timestamps.
  - `note_key_shares`: note ID, recipient user ID, encrypted note key, sender user ID, sharing key version, format version, timestamps.
  - `note_events`: durable integer cursor, event ID, resource type, resource ID, optional note ID, actor user ID, event type, note version, payload metadata, timestamp.
  - Add indexes for accessible notes by user, note memberships by note, and event replay by user/cursor.
  - Existing notes must get owner `note_memberships` rows during migration. Keep the current owner `encrypted_note_key` fields readable for backward compatibility, and require `note_key_shares` for collaborators.
  - All newly created notes must create the owner `note_memberships` row in the same transaction as the note row.
  - Add immutable `crypto_owner_id` to `notes`, set to the creator/owner user ID.
  - Enforce one membership per `(note_id, user_id)`.
  - Store `sharing_key_version` on `note_key_shares`.
  - Migrations must be idempotent for existing SQLite databases: use guarded `ALTER TABLE`/backfill steps in addition to updated `CREATE TABLE IF NOT EXISTS` definitions.

- Update crypto model:
  - Generate a client-side sharing keypair after vault unlock if missing with libsodium `crypto_box_keypair`.
  - Encrypt note-key shares with `crypto_box_seal` and decrypt them with `crypto_box_seal_open`.
  - Encrypt the private sharing key with the root key before storing it, using the existing XChaCha20-Poly1305 helper pattern.
  - Store public sharing key on the server.
  - Sharing keys are versioned. V1 does not rotate existing note shares automatically when a user rotates sharing keys.
  - Add immutable `cryptoOwnerId` to note payloads and set it to the creator/owner user ID at note creation.
  - Keep note body/key AAD stable by using `cryptoOwnerId` as crypto context for shared notes.
  - Owner encrypts each shared note key for each collaborator using libsodium sealed boxes with the collaborator’s public sharing key.
  - Before using a collaborator public sharing key, the client enforces local TOFU: first-use fingerprint confirmation, encrypted local trust records by collaborator user ID and sharing-key version, mismatch blocking, and new-version re-confirmation.
  - Attachment keys remain wrapped by the note key. Anyone who can decrypt the shared note key can decrypt attachment keys; server role checks still gate upload/delete mutations.
  - Server never receives root keys, note keys, attachment keys, private sharing keys, note plaintext, or attachment plaintext.

- Update authorization and APIs:
  - Replace owner-only note access checks with membership-aware checks.
  - Owners can invite, revoke, and change roles.
  - Invite creation is active immediately in V1: creating an invite creates an active membership and key share. The `invited` status is reserved for future explicit-acceptance flows and must not be used by V1 routes.
  - Editors can update note content, metadata, and attachments.
  - Viewers can list/read/decrypt shared notes but cannot mutate them.
  - Add endpoints for sharing keys, note-scoped invite creation, membership listing, role updates, revoke, and fetching note key shares.
  - Final route shapes: `/sharing-keys/current` for the signed-in user's key, `/sharing-keys/lookup?username=` for invite lookup, `/notes/:id/memberships` for note memberships/invites, and `/notes/:id/key-share` for the signed-in user's note-key share.
  - Note/folder/attachment list APIs must return both owned and accessible shared data, with role and owner/crypto context metadata.
  - Sharing UI belongs in note actions, not global settings, because sharing is note-scoped.

- Add realtime transport:
  - Add authenticated WebSocket endpoint using the existing session cookie.
  - Add a server WebSocket library such as `ws`, create an HTTP server in `apps/server/src/index.ts`, and attach both Express and the WebSocket server to it.
  - Use same-origin `ws://host` or `wss://host` so the current `connect-src 'self'` CSP remains valid. If a separate realtime origin is introduced, update CSP explicitly.
  - Track user connections in-memory for local dev.
  - Broadcast durable events for note, membership, folder, and attachment changes.
  - Client reconnects with last seen event cursor and refetches/decrypts affected records.
  - Add presence events per accessible note: user joined, left, editing/idle.
  - Durable event replay must enforce visibility. Users can read events for notes they currently have access to; revoked users can replay only `membership.revoked` tombstones addressed to them. After the revoked user acknowledges that cursor, no further events or note metadata for that note are visible to them.

- Add client collaboration layer:
  - Create a realtime client module separate from UI components.
  - Add a collaboration hook that connects after session + vault unlock.
  - After vault unlock, fetch `/sharing-key`; if absent, generate keys, wrap the private key, upload public/wrapped private key, and keep the opened private key in memory only.
  - On events, refetch affected note/folder/attachment records and decrypt with the correct owner crypto context.
  - Add invite/share UI in note actions.
  - Surface collaborator roles and presence in the editor header/sidebar without putting WebSocket logic in UI components.
  - Add a collaboration store slice for presence, event cursor, connection status, opened sharing keys, and decrypted shared note keys. Memberships may remain local to the sharing panel while they are only displayed and mutated there; centralize them if more surfaces need the same state. Clear decrypted sharing/private note material on lock/logout.

- Conflict/editing model:
  - Keep current optimistic `version` checks for first implementation.
  - On conflict, refetch latest encrypted note and show save failure.
  - Whole-note encrypted snapshots are acceptable for first full-scope implementation.
  - Keep event/key/member architecture compatible with later CRDT/Yjs updates.

## Security Model

- E2EE target is an honest-but-curious server. The server stores ciphertext, key envelopes, metadata, roles, and events, but not plaintext note bodies, plaintext attachment bytes, root keys, note keys, attachment keys, or private sharing keys.
- The app does not protect against a malicious server that serves modified client JavaScript. Stronger protection would require signed clients, native apps, extensions, or independent client verification.
- Collaboration metadata is plaintext server-visible metadata: usernames, note IDs, membership rows, roles, actor IDs, event timing, presence state, edit frequency, titles, filenames, MIME types, sizes, and timestamps.
- `crypto_box_seal` protects note-key share confidentiality but does not authenticate the sender. V1 trusts server authorization metadata for who created a share. Sender-authenticated shares can be added later.
- Public sharing key lookup by username uses local TOFU. It detects same-version key substitution after first trust and forces confirmation for new versions, but first trust can still be wrong if the server is malicious at first use, and trust records do not sync across devices.
- Revocation blocks server access and future event/key-share delivery, but it is not cryptographic forward secrecy for ciphertext or keys already obtained by the revoked user.
- Forward secrecy after revocation requires rotating the note key, re-encrypting the note body and attachment keys, and rewrapping the new note key for remaining active members. Current implementation performs this as a client-side sequence after access removal, so a rotation failure remains visible and retryable during the current vault session.
- Old encrypted private sharing keys may remain stored only while active note shares reference their version. Delete old private keys only after all referenced shares are rewrapped or revoked.
- Presence is ephemeral, not durable. Send presence only to active note members and never to revoked users.

## Reliability Model

- Durable `note_events.cursor` is the replay ordering source of truth. Use a monotonically increasing integer cursor, not UUID ordering.
- WebSocket delivery is best-effort. REST refetch plus event replay is the correctness path.
- Data mutations and event writes must happen in the same database transaction. If note update commits, its event must commit; if the event write fails, the note update must roll back.
- Client event handling must be idempotent. Duplicate events must not duplicate notes, corrupt state, or regress versions.
- Reconnect flow: open WebSocket with last acknowledged cursor, replay missed visible events, then continue live subscription.
- Cursor acknowledgement happens after the client processes the event or after the client records enough state to safely replay it.
- Presence uses heartbeat/TTL so disconnects, tab crashes, and process exits do not leave stale online users forever.
- In-memory WebSocket connection tracking supports one server process only. Multi-process live fanout needs Redis/pubsub or another broker later; durable events preserve reconnect correctness.
- Event retention is visibility-aware: do not delete events until every user who can replay that event has acknowledged past it. Revoked users can retain only their own unacknowledged revoke tombstone.

## Event Semantics

- Events are invalidation signals only. They must not include plaintext, ciphertext bodies, note keys, attachment keys, private sharing keys, or key-share ciphertext. Clients always refetch key-share material through authorized REST endpoints.
- Standard event envelope:
  - `cursor`
  - `eventId`
  - `type`
  - `resourceType`
  - `resourceId`
  - optional `noteId`
  - `actorUserId`
  - `version`
  - optional `attachmentId`
  - optional `membershipUserId`
  - optional metadata needed to decide which REST resource to refetch.
- Durable event replay must enforce visibility. Users can read events for notes they currently have access to; revoked users can replay only `membership.revoked` tombstones addressed to them.
- After a revoked user acknowledges the revoke tombstone cursor, no further events or note metadata for that note are visible to them.
- Revoke and role-change events must be emitted transactionally with the membership change.

## Key Envelope Formats

- Private sharing key envelope:
  - `publicKey`
  - `encryptedPrivateKey`
  - `privateKeyNonce`
  - `sharingKeyVersion`
  - `formatVersion`
  - `createdAt`
- Note-key share envelope:
  - `noteId`
  - `recipientUserId`
  - `senderUserId`
  - `sharingKeyVersion`
  - `encryptedNoteKey`
  - `formatVersion`
  - `createdAt`
- Shared note open flow:
  - fetch note metadata including `cryptoOwnerId`, role, version, and ciphertext fields.
  - fetch the current user's note-key share if the note key is not already in memory.
  - decrypt the note-key share with the in-memory private sharing key.
  - decrypt note body with `cryptoOwnerId` as AAD context.
  - cache decrypted shared note keys in memory only.

## Authorization Rules

- Add one server helper, `getNoteAccess(noteId, userId)`, returning role, status, owner user ID, and `cryptoOwnerId`.
- Every note, attachment, key-share, event, invite, membership, and presence route must use membership-aware authorization.
- Owners can read, edit, invite, revoke, change roles, delete, and permanently delete.
- Editors can read, decrypt through their key share, update content/metadata, and upload/delete attachments.
- Viewers can list, fetch, and decrypt only.
- Revoked users cannot fetch note data, key shares, attachments, future events, or presence, except for their own revoke tombstone.
- Attachment storage quota is charged to the note owner in V1.

## Migration Rules

- Add `crypto_owner_id` to existing notes with value copied from current `user_id`.
- Create owner `note_memberships` rows for every existing note.
- Keep existing owner `encrypted_note_key`/`note_key_nonce` fields readable for owners during V1.
- Collaborators must use `note_key_shares`; do not expose owner note-key fields to collaborators.
- New notes create note row, owner membership row, and event row in one transaction.
- Existing single-user notes must still decrypt after migration.

## Failure Modes

- Missing collaborator sharing key: owner cannot invite that user until the user unlocks once and publishes a sharing key.
- Version conflict: client refetches latest encrypted note and shows save failure.
- Permission changed while editing: server returns forbidden/conflict, client refetches membership state and disables unavailable actions.
- Revoked while online: client receives revoke tombstone, clears local shared note key/body for that note, and removes note access.
- WebSocket disconnected: client shows degraded sync state and falls back to reconnect/replay.
- Duplicate event: client ignores already processed cursor/event ID.

## Test Plan

- Server tests:
  - Membership authorization for owner/editor/viewer/revoked users.
  - Note listing includes owned and shared notes.
  - Editor can update shared note; viewer cannot.
  - Invite/revoke changes access immediately.
  - Key-share endpoints never expose another user’s private material.
  - Event rows are written for note/membership/attachment mutations.
  - Note mutation and event write commit or roll back together.
  - New notes create owner membership rows.

- Client crypto tests:
  - Sharing keypair generation and private-key wrapping.
  - Owner encrypts note key for collaborators.
  - Collaborators decrypt note key shares and then note body using owner crypto context.
  - Wrong recipient/private key cannot decrypt another user’s note-key share.
  - `cryptoOwnerId` mismatch fails note decryption.
  - Revoked user cannot fetch fresh note data/key shares.
  - Lock/logout clears decrypted private sharing key and decrypted shared note keys from client state.

- Realtime tests:
  - WebSocket rejects unauthenticated clients.
  - Three-user scenario: Alice owns a note, Bob is online as an editor, and Carol is offline as a viewer.
  - Alice updates the note; Bob receives the realtime event and refetches/decrypts immediately.
  - Carol misses the live event while offline, reconnects later with her last event cursor, receives replayed events, and refetches/decrypts the latest note.
  - Bob updates the note as editor; Alice receives the realtime event immediately, and Carol catches up from replay while offline.
  - Bob’s presence is visible while connected; Carol has no live presence while offline.
  - Revoke or role-change events reach online users immediately and are replayed to offline users on reconnect.
  - Carol receives `membership.revoked`, advances her cursor, reconnects again, and receives no further events or note metadata.
  - Replayed duplicate events are idempotent.

- E2E tests:
  - Alice creates a note and invites Bob and Carol.
  - Bob is online and receives Alice’s updates without a manual refresh.
  - Carol is offline during Alice’s update, then signs in later and receives the updated note through event replay/resync.
  - Carol as viewer cannot edit; Bob as editor edits and Alice receives the realtime update.
  - Carol later reconnects and sees Bob’s latest edit through replay/resync.
  - Alice revokes Carol; Carol loses access on reconnect/refresh.
  - Attachment sharing works through encrypted attachment key access.
  - Existing single-user notes still decrypt after migration.
  - Existing single-user vault, recovery, markdown sanitization, lock/logout flows still pass.

## Assumptions

- Full collaboration scope is intentional; do not narrow to single-user sync.
- Tests must cover three users, with one online collaborator and one offline collaborator.
- First shipped editing model uses whole-note encrypted snapshots and optimistic version conflicts, not CRDT.
- Shared note crypto context is immutable `cryptoOwnerId`, initially set to the creator/owner user ID.
- Folder sharing follows note access initially: shared notes may appear in a shared section rather than exposing owner folder hierarchy to collaborators.
- WebSocket scaling beyond one Node process is deferred; durable `note_events` preserves a path to Redis/pubsub later.
