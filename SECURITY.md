# Security Model

Fortnote is designed for an honest-but-curious server: the server may store and
route collaboration data, but it must not receive plaintext note bodies,
plaintext attachment bytes, root keys, note keys, attachment keys, recovery
secrets, or private sharing keys.

This document describes the current collaboration security boundary. It is
product copy for users and implementation guidance for developers.

## What Stays Encrypted

- Note bodies are encrypted on the client with a note key.
- Attachment bytes are encrypted on the client with attachment keys.
- Attachment keys are wrapped by the note key.
- Note keys for collaborators are encrypted to each recipient's public sharing
  key.
- Private sharing keys are encrypted by the user's vault root key before they
  are stored.

The server should only store ciphertext and key envelopes. Do not add routes,
events, logs, or diagnostics that include plaintext content or unwrapped keys.

## Metadata The Server Can See

Collaboration does not hide all metadata. The server can see account names, note
IDs, membership rows, roles, actor IDs, event timing, presence state, edit
frequency, titles, filenames, MIME types, sizes, and timestamps.

Treat those fields as sensitive operational metadata. Avoid logging more of it
than necessary, and do not place note ciphertext, key-share ciphertext,
attachment ciphertext, or private-key envelopes in durable events.

## Sharing Key Trust

The invite flow looks up a collaborator's public sharing key by username. On
first use, the client computes a SHA-256 fingerprint of the key, shows it to the
owner, and requires explicit trust before creating the note-key share. Trusted
fingerprints are stored locally in encrypted vault state, keyed by collaborator
user ID and sharing-key version.

If the same user and sharing-key version later returns a different fingerprint,
the client blocks sharing. A new sharing-key version requires a new trust
confirmation. This is TOFU hardening: it detects key changes after first trust,
but it cannot prove that the first trusted key was correct and does not sync
trust decisions across devices.

A trust confirmation is authorization to share one specific note-key context,
not a general approval for whichever note is selected later. Changing the
selected note must invalidate the pending confirmation.

## Sender Authentication

Note-key shares use sealed boxes. Sealed boxes hide the note key from anyone
without the recipient's private sharing key, but they do not authenticate the
sender cryptographically.

The current implementation relies on server-side authorization metadata to
decide who may create or replace a share. Developers must keep share creation
and rotation behind owner authorization checks.

## Revocation Limits

Revocation immediately blocks future server access for the revoked member and
stops future note, key-share, attachment, event, and presence delivery. Online
or reconnecting clients receive a revocation tombstone so they can remove local
shared-note state.

Revocation is not retroactive secrecy for data already downloaded by the
revoked member. After revocation, owners should rotate the note key,
re-encrypt the note body, rewrap attachment keys, and create new note-key
shares for remaining active collaborators.

If that client-side rotation fails, the application must retain a per-note
repair action across note navigation until rotation succeeds. Immediate server
access removal does not make the unfinished key rotation complete.

## Developer Rules

- Use `cryptoOwnerId`, not the viewer's user ID, as the note and attachment
  crypto context for shared records.
- Write data mutations and durable events in the same database transaction.
- Replay events only to active note members, except for a revoked user's own
  unacknowledged revocation tombstone.
- Capture immutable recipients for permanent-delete tombstones before removing
  membership rows, and include those recipients in replay and retention.
- Acknowledge event cursors only after required refetch/decryption succeeds or
  the client durably records work that it will retry. In-memory receipt alone is
  not sufficient.
- Treat WebSocket authentication as continuous: close established connections
  when their backing session is deleted or expires.
- Treat events from another tab or device for the same user as remote unless a
  per-client identifier proves the mutation originated locally.
- Delete old encrypted private sharing keys only after no note-key shares
  reference their sharing-key version.
- Keep presence ephemeral and scoped to active note members.
- Keep sharing-key trust records encrypted with the vault root key. Never store
  trusted fingerprints as plaintext server metadata.

## Authentication Operations

- Unknown usernames must receive pseudorandom dummy KDF and recovery envelopes
  with the same response shape as registered accounts. Login and recovery must
  still perform Argon2 verification against a dummy hash when no account exists.
- Apply both IP-wide and account-specific limits to every pre-authentication
  endpoint. Keep authentication request bodies and encoded crypto fields bounded.
- JSON API requests are capped at 1 MiB. Encrypted attachment uploads use the
  separate octet-stream route and retain the attachment-specific size limit.
- Password changes and account recovery revoke every existing server session and
  replace the caller's cookie only after the credential and key-material updates
  commit atomically.
- Enforce key-material versions in the `UPDATE` predicate, not only with a prior
  read, so concurrent rotations cannot both succeed.

## Realtime Operations

- Every HTTP upgrade socket must be accepted or explicitly rejected; unmatched
  paths must never be left open.
- Keep the WebSocket payload limit close to the largest supported client message.
  Presence and heartbeat messages do not require attachment-sized frames.
- Validate a session once per session and authorization once per user when
  broadcasting the same event or presence update to multiple sockets.
- Delete expired session rows during the realtime session sweep. Bound event
  pruning by the cursor supplied with each acknowledgement.

## Storage And Concurrency

- Enforce note optimistic locking in the mutation's `UPDATE` predicate. A prior
  version read is useful for an early conflict response but is not a lock.
- Recheck attachment quota inside an immediate SQLite transaction before
  inserting attachment metadata. The pre-upload quota check is only an early
  rejection optimization.
- Enforce folder ownership and existence in the database. New databases use
  folder foreign keys, while migration triggers protect databases created by
  earlier versions.
- Use asynchronous filesystem operations on request paths. On startup, remove
  unreferenced UUID-named attachment ciphertext files left by an interrupted or
  partially failed database/filesystem operation.
