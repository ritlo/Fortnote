# ADR: Public Sharing-Key Trust

## Status

Accepted and implemented for local TOFU.

## Context

Fortnote uses user-published public sharing keys to encrypt note-key shares for
collaborators. The original V1 invite flow asked the server for a public sharing
key by username and trusted the returned key. That protected against passive
observation, but not against a malicious or compromised server substituting its
own public key.

A previous attempt showed a live fingerprint preview in the sharing panel and
was reverted. Fingerprint display alone is not enough: users need a trust
decision, the app needs to remember that decision, and legitimate sharing-key
rotation needs predictable behavior.

## Decision

Do not reintroduce passive fingerprint preview as the trust hardening. Use
explicit trust-on-first-use (TOFU) with fingerprints.

Implemented behavior:

- Compute a stable fingerprint from the public sharing key on the client.
- When inviting a collaborator whose key has no local trust record, show the
  username and fingerprint and require explicit confirmation before creating the
  note-key share.
- Store the trusted fingerprint locally in encrypted vault state, keyed by
  collaborator user ID and sharing-key version.
- If a later lookup for the same user/version returns a different fingerprint,
  block sharing and show a key-change warning.
- If the collaborator rotates to a new sharing-key version, require a new trust
  confirmation for that version before using it.
- When post-revocation key rotation needs to rewrap note keys for remaining
  collaborators, block wrapping to unknown or changed sharing keys rather than
  silently trusting them.
- Keep server authorization checks as mandatory defense-in-depth; TOFU only
  hardens public-key substitution, not membership authorization.

## Non-Goals

- No sender-authenticated share envelope in this step.
- No cross-device trust sync unless encrypted vault-state sync already exists.
- No claim that TOFU protects against malicious client JavaScript served by the
  server.

## Implementation Notes

- The fingerprint should be derived from the decoded public key bytes with a
  modern hash such as SHA-256, formatted in short groups for comparison.
- Trust records must be cleared on vault reset/logout only if other vault-local
  collaboration secrets are also cleared.
- The sharing panel can surface trust state, but WebSocket/realtime code should
  remain outside UI components.
- Tests should cover stable fingerprint formatting, first-use confirmation
  gating share creation, mismatch blocking, and new-version re-confirmation.
