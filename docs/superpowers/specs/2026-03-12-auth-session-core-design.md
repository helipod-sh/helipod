# Auth slice A1 — session core hardening (design)

**Date:** 2026-03-12
**Status:** Approved (design presented and approved in-session; arc sequence approved)
**Arc context:** Slice A1 of the three-slice auth arc — A1 session core (this), A2 email flows
(EmailProvider seam + verification/reset/magic-links/OTP), A3 external identity (OAuth
providers + JWKS/OIDC verifier). Every later sign-in method ends by minting a session, so the
session model ships first and later slices land on it through one chokepoint.

**Goal:** Upgrade `@stackbase/auth` from a single 30-day opaque bearer token to a hardened
session core: short-lived access tokens + rotating refresh tokens with reuse detection,
hashed-at-rest tokens, session listing/revocation ("manage devices"), anonymous auth with
in-place upgrade, and a single internal `mintSession` chokepoint. Plus: correct the stale
`docs/enduser/build/auth.md`, which documents JWKS/OIDC machinery that does not exist.

## Locked design decisions

1. **Token model: opaque access + rotating refresh, both DB rows** (over JWT access). Identity
   resolution stays a DB read inside the transaction (`sessions` lookup in
   `authContext.getUserId()`), so it enters the read-set and **revocation stays instantly
   reactive** — kill a session, every tab's queries flip on the next push. JWTs would break
   that property; they return in A3 for third-party issuers only.
2. **Tokens are hashed at rest** (SHA-256, base64url). Today `sessions.token` stores the raw
   token — a DB leak is mass session hijack. After A1 the DB stores only hashes; raw tokens
   exist only in the client's hands.
3. **Rotation + reuse detection, per-session (the session row IS the family).** `refresh`
   rotates both hashes in place and remembers the previous refresh hash. A presented refresh
   token that matches the *previous* hash outside the grace window is a theft signal → the
   session row is deleted (revoked). Matching neither hash is plain invalid.
4. **Grace window for honest races:** presented == previous hash AND
   `now - lastRefreshAt <= refreshGraceMs` (default 30s) → typed soft error `REFRESH_STALE`,
   **no revocation** — a racing tab lost to its sibling and should pick up the winner's pair
   (via the client's broadcast). Outside the window → revoke.
5. **Client-side single-refresher.** The browser client serializes refreshes via Web Locks
   (the same leader mechanism the outbox drain uses) and broadcasts the new pair over
   BroadcastChannel; non-leader tabs never call `refresh` themselves. Non-browser hosts fall
   back to in-process serialization; two independent *processes* sharing one refresh token is
   documented as unsupported.
6. **Revoke = DELETE the session row** (no `revokedAt` tombstone — YAGNI, and delete is what
   makes revocation reactive through the existing read-set).
7. **`lastRefreshAt` updates only on refresh, never per-request.** Per-request session writes
   would turn every authenticated query into write amplification through the reactive engine.
8. **Anonymous users are real users** (`users.anonymous: true`, no email). Upgrading is
   in-place: `signUp` while holding an anonymous session attaches email + password account to
   the SAME `userId` and clears the flag — every row the anonymous user created survives.
9. **Outbox fingerprint moves to the stable `sessionId`.** Today the client fingerprints the
   raw token; under rotation that would orphan queued offline mutations mid-drain. Mint
   results carry `sessionId`; the managed auth client fingerprints that. The raw
   `setAuth(token)` path keeps token-hash fingerprinting unchanged.
10. **Config via `defineAuth(options?)`**, following the component convention
    (`defineScheduler`). The existing `auth` export becomes `defineAuth()` with defaults —
    no breaking change for `stackbase.config.ts` files that compose `auth`.
11. **Absolute session-lifetime ceiling** (adopted from Convex Auth's total-duration cap):
    `absoluteExpiresAt = mintTime + sessionTotalTtlMs` (default 90 days) is fixed at mint and
    NEVER slides — `refresh` rejects past it with `REFRESH_EXPIRED` regardless of activity.
    Without it, a continuously-active session would never force re-authentication.
12. **Anonymous sign-in guards** (adopted from Better Auth's anon plugin behavior):
    `signInAnonymously` rejects when the caller's ambient identity already resolves to ANY
    user (prevents anon churn from signed-in callers), and a **global throttle** caps
    anonymous user creation per deployment (`anonymousSignInsPerMinute`, default 60,
    `0` disables) — anonymous sign-up is unauthenticated write amplification and we carry no
    per-IP identifiers by design, so the throttle is deployment-global (a single counter row;
    the single-writer transactor makes contention a non-issue).
13. **Constant-time comparison** for the `prevRefreshTokenHash` check inside `refresh` (the
    one token comparison that happens in app code rather than via index lookup).

## Reference implementations consulted

`.reference/convex-auth` (Apache-2.0) and `.reference/better-auth` (MIT) were studied for
this design; test-suite cases were adapted (marked in Testing). Both validate the locked
decisions by contrast: Convex Auth's non-erroring refresh-race replay depends on its
refresh secret being the row's own unhashed primary key (the leak surface decision #2
closes), and Better Auth's unhashed tokens force its list-sessions API to return raw bearer
credentials as revoke keys. Neither hashes tokens at rest; neither ships in-place anonymous
upgrade (Better Auth mints a NEW userId and deletes the old row — integrators must copy data
in an `onLinkAccount` callback, with an acknowledged partial-state bug; Convex Auth leaves
upgrade to userland and its own anonymous-conversion test is an unimplemented `test.todo`).
Deliberately NOT adopted, as conscious decisions: Better Auth's freshness gate on
device-management ops (our 1h access TTL already bounds the exposure a freshness gate would
close), per-IP rate limiting and server-side IP/UA capture (no transport identifiers by
design), an anonymous-upgrade hook (YAGNI — in-place upgrade means there is no data to
migrate), and Convex Auth's surgical subtree invalidation (our session row IS the family;
whole-session death on theft is simpler and stricter).

## Schema (component tables, additive)

`sessions` (new shape; all new fields optional at the storage layer for live-deploy
additivity):

```
{
  userId, 
  tokenHash,            // SHA-256(access token), index byTokenHash
  expiresAt,            // access expiry (now + accessTtlMs)
  refreshTokenHash,     // SHA-256(current refresh token), index byRefreshTokenHash
  prevRefreshTokenHash, // SHA-256(previous refresh token) — reuse detection
  refreshExpiresAt,     // sliding: reset to now + refreshTtlMs on each rotation
  absoluteExpiresAt,    // fixed at mint: mintTime + sessionTotalTtlMs — never slides
  deviceLabel,          // optional client-supplied string (e.g. "Chrome on macOS")
  createdAt,
  lastRefreshAt,
  // legacy rows keep { token, expiresAt } and resolve until natural expiry
}
```

`users` gains `anonymous: v.optional(v.boolean())`; `email` becomes optional (anonymous users
have none). The `byEmail` index remains for real users.

Legacy compatibility: `authContext.getUserId()` resolves the ambient identity by
`byTokenHash` first, then falls back to the legacy `byToken` index for pre-A1 rows, until
those expire. New mints are always hashed pairs.

## Component surface

Config: `defineAuth({ accessTtlMs = 60*60*1000, refreshTtlMs = 30*24*60*60*1000,
refreshGraceMs = 30_000, sessionTotalTtlMs = 90*24*60*60*1000,
anonymousSignInsPerMinute = 60 })`; `export const auth = defineAuth()`.

Internal chokepoint (not a public function): `mintSession(ctx, userId, deviceLabel?)` →
generates both raw tokens, stores hashes, returns
`{ token, refreshToken, sessionId, userId, expiresAt }`. `signUp`, `signIn`,
`signInAnonymously`, and `refresh` all mint through it; A2/A3 flows will too.

Public functions (all component-namespaced, callable like today's `auth:signIn`):

- `signUp(email, password, deviceLabel?)` → mint result. **Upgrade path:** if the caller's
  ambient identity resolves to an anonymous user, attach the email + password account to that
  userId, clear `anonymous`, delete ALL of that user's existing sessions (an upgrade is a
  credential boundary), and mint a fresh session. Duplicate-email guard unchanged.
- `signIn(email, password, deviceLabel?)` → mint result. Lockout behavior unchanged
  (5 attempts / 15 min, commit-then-throw counter durability).
- `signInAnonymously(deviceLabel?)` → creates `{ anonymous: true }` user + mint result.
  Rejects if the caller is already authenticated (any user); subject to the global
  `anonymousSignInsPerMinute` throttle (typed `ANONYMOUS_THROTTLED`).
- `refresh(refreshToken)` → mint-shaped result for the SAME sessionId (rotation in place):
  new access + refresh tokens, `prevRefreshTokenHash` ← old hash, sliding
  `refreshExpiresAt`, `lastRefreshAt = now`. Reuse detection + grace per locked decisions
  3–4. Expired refresh (`now > refreshExpiresAt`) → typed `REFRESH_EXPIRED`.
- `signOut(token)` → unchanged semantics (deletes the caller's session row; accepts legacy
  and new tokens).
- `listSessions()` → for the ambient identity's user: array of
  `{ sessionId, deviceLabel, createdAt, lastRefreshAt, current }` — never any hash material.
- `revokeSession(sessionId)` → ownership-checked delete.
- `revokeOtherSessions()` → delete all the user's sessions except the current one.

Typed error codes (crossing the wire like other engine errors): `REFRESH_STALE` (reuse
inside grace — no revocation), `REFRESH_REUSED` (reuse outside grace — thrown AFTER the
session row is deleted, so the theft response commits even though the call fails: the same
commit-then-throw mechanism the lockout counter uses), `REFRESH_EXPIRED`, plus the existing
auth failures.

## Client (`@stackbase/client`)

- `setAuth(token)` unchanged — the raw escape hatch (and what A3 third-party JWTs will use).
- New `createAuthClient(client, { storage? })` — a thin token-lifecycle manager:
  - persists the mint result (default `localStorage` with in-memory fallback; pluggable
    storage for Node/Electron hosts, same shape as the outbox's storage seam);
  - calls `client.setAuth(accessToken)` and re-applies it on reconnect (the existing
    SetAuth replay already handles the wire side);
  - schedules refresh at ~80% of access TTL; Web-Locks single-refresher; broadcasts the new
    pair; applies a broadcast pair received from another tab;
  - on `REFRESH_STALE` waits for the broadcast winner; on `REFRESH_EXPIRED`/`REFRESH_REUSED`
    clears storage and invokes `onSignedOut`;
  - exposes `setSession(mintResult)`, `clearSession()`, `getSessionInfo()` — sign-in flows
    remain ordinary app mutations; the app hands the result to the auth client.
- Outbox fingerprint: when a session is managed by `createAuthClient`, the durable-entry
  identity fingerprint derives from `sessionId` (stable across rotation). Raw `setAuth`
  users keep the current token-hash fingerprint.

## Migration & deploy safety

Purely additive schema (new optional fields, one new optional user field) — passes the
`stackbase deploy` additive gate. Existing sessions keep working until natural expiry via the
legacy-index fallback. No data migration step. `examples/auth-demo` is updated to use
`createAuthClient` (and demonstrates listSessions/revoke — the "manage devices" panel — and
the anonymous→upgrade flow).

## Documentation deliverables

- Rewrite `docs/enduser/build/auth.md` to describe the REAL component: password + session
  auth, the A1 session model (rotation, reuse detection, device management, anonymous), the
  `createAuthClient` usage, and the localStorage-vs-cookie tradeoff note. The JWKS/OIDC
  content moves to a clearly-marked "coming in the external-identity slice" roadmap note —
  the doc must stop claiming unshipped machinery.
- `components/auth/README.md` updated to match (limitations list re-baselined).

## Testing

- Component-level via `@stackbase/test` (`createTestStackbase` over the real engine):
  rotation happy path; reuse-outside-grace revokes; reuse-inside-grace returns
  `REFRESH_STALE` without revoking; expired refresh (sliding AND the absolute
  `absoluteExpiresAt` ceiling — an actively-refreshing session still dies at the cap);
  hashed-at-rest (no raw token appears in any stored row); legacy-token fallback resolution;
  anonymous upgrade preserves userId and clears the flag; repeat `signInAnonymously` while
  authenticated is rejected; the anonymous global throttle trips and recovers;
  listSessions/revoke ownership checks; revokeOtherSessions keeps the current session.
  Divergence-pinning tests (adapted from the reference suites): theft response kills the
  WHOLE session — assert no surviving usable token after reuse-outside-grace (the opposite
  of Convex Auth's surgical subtree survival, so nobody "fixes" it toward their behavior);
  and the racing loser receives `REFRESH_STALE` — never a fresh usable pair (the opposite of
  Convex Auth's fork/replay branches, foreclosed by hashed-at-rest).
- E2E through the real `stackbase dev` server (`packages/cli/test/auth-session-e2e.test.ts`,
  the e2e-through-shipped-entrypoint rule): a live subscription reading
  `ctx.auth.getUserId()` sees revocation fan out reactively when another connection calls
  `revokeSession`; a full rotate-while-subscribed cycle keeps identity continuous; the
  anonymous→upgrade flow proves a row written while anonymous is still readable by the
  upgraded user through the same live subscription.
- Client unit tests for `createAuthClient` (fake timers for the refresh schedule; two
  simulated tabs for the Web-Locks/broadcast race; storage fallback).

## Non-goals (A1)

- **httpOnly-cookie mode + CSRF** — deliberately out, as a decision: Stackbase is
  WebSocket-first and identity flows over the `SetAuth` message, not request headers. Cookie
  auth would rearchitect identity transport for marginal gain; short access TTL + rotation +
  reuse detection is the theft mitigation. Documented in the enduser doc.
- MFA / TOTP / passkeys; IP/UA capture (deviceLabel is client-supplied by design — honest
  and transport-agnostic); admin user-management dashboard UI; email flows (A2); OAuth and
  JWKS/OIDC (A3); per-request sliding access expiry (write amplification).
