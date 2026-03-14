# @stackbase/auth

First-party authentication for Stackbase: email + password accounts (argon2id hashing, per-call
random salt, constant-time verification, legacy-scrypt migration), a hardened session model (short
access tokens + rotating refresh tokens with reuse detection, all hashed at rest), device
management (`listSessions`/`revokeSession`/`revokeOtherSessions`), and anonymous sign-in with
in-place upgrade. `ctx.auth.getUserId()` resolves identity inside the transaction, so session
revocation is reactive. Runtime-agnostic (`node:crypto`) — Node.js and Bun.

Configure via `defineAuth(options?)`; `export const auth = defineAuth()` uses the defaults.
Session/token details and the client `createAuthClient` are documented in
`docs/enduser/build/auth.md`.

Reference implementations consulted: convex-auth (Apache-2.0) and better-auth (MIT) — adapted with
attribution, never copied.

## Known limitations

1. **No storage-level unique index on `accounts(provider, accountId)`** — uniqueness is enforced by
   an application-level duplicate check in `signUp`, correct under single-writer OCC serialization
   (Tier 0 / Tier 1). A multi-writer engine (Tier 2+) would require a DB-level unique constraint.
2. **Sessions in one browser context** — the client single-refresher serializes rotation across tabs
   via Web Locks; two independent *processes* sharing one refresh token is unsupported.
3. **No httpOnly-cookie / CSRF mode** — Stackbase is WebSocket-first; identity flows over `SetAuth`,
   not headers. The session model (short access TTL + rotation + reuse detection) is the theft
   mitigation. See the auth doc's "localStorage vs. cookies" note.
4. **Email flows (verification / reset / magic-link / OTP) and external identity (OAuth, JWKS/OIDC)
   are not implemented** — deferred to the A2 (email) and A3 (external identity) slices.
