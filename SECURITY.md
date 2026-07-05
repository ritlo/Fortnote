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

## Developer Rules

- Use `cryptoOwnerId`, not the viewer's user ID, as the note and attachment
  crypto context for shared records.
- Write data mutations and durable events in the same database transaction.
- Replay events only to active note members, except for a revoked user's own
  unacknowledged revocation tombstone.
- Acknowledge event cursors only after the client has processed or recorded
  enough state to replay safely.
- Delete old encrypted private sharing keys only after no note-key shares
  reference their sharing-key version.
- Keep presence ephemeral and scoped to active note members.
- Keep sharing-key trust records encrypted with the vault root key. Never store
  trusted fingerprints as plaintext server metadata.
