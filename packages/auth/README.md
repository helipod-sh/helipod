# @stackbase/auth

Authentication primitives for Stackbase — password hashing with scrypt (per-call random salt, constant-time verification) and secure token generation. These helpers are runtime-agnostic and work on both Node.js and Bun via `node:crypto`.

Data model adapted from convex-auth (Apache-2.0).

## Known limitations

1. **No storage-level unique index on `accounts(provider, accountId)`** — uniqueness is enforced by an application-level duplicate check in `signUp`. This is correct under single-writer OCC serialization (Tier 0 / Tier 1). A multi-writer engine (Tier 2+) would require a DB-level unique constraint on `(provider, accountId)` to remain race-free.
2. **No session expiry** — tokens are permanent until explicitly deleted via `signOut`. Time-bounded sessions are deferred to a later slice.
3. **OAuth, email-verification, and token-refresh are not implemented** — these are deferred to the Actions slice, which provides the side-effect model required for sending emails and calling external OAuth providers.
