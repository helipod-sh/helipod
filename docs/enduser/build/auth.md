---
title: Authentication
---

# Authentication

Stackbase ships a first-party, self-hosted auth component: **`@stackbase/auth`** — email + password
accounts, a hardened session model (short access tokens + rotating refresh tokens with reuse
detection), device management ("manage your sessions"), and anonymous sign-in with in-place upgrade.
Identity flows over the WebSocket sync connection via `SetAuth`, and `ctx.auth.getUserId()` resolves
the current user inside your query/mutation — so **revoking a session reactively flips every
subscribed query**, no polling.

## Enabling it

`@stackbase/auth` is a component you compose in `stackbase.config.ts`:

```ts
import { defineConfig } from "@stackbase/component";
import { auth } from "@stackbase/auth";

export default defineConfig({ components: [auth] });
```

`auth` is `defineAuth()` with defaults. To tune lifetimes:

```ts
import { defineAuth } from "@stackbase/auth";

defineAuth({
  accessTtlMs: 60 * 60 * 1000,          // access token lifetime (default 1h)
  refreshTtlMs: 30 * 24 * 60 * 60 * 1000, // refresh token lifetime, slides on rotation (default 30d)
  refreshGraceMs: 30_000,               // honest-race grace window (default 30s)
  sessionTotalTtlMs: 90 * 24 * 60 * 60 * 1000, // absolute ceiling, never slides (default 90d)
  anonymousSignInsPerMinute: 60,        // deployment-global anon throttle; 0 disables (default 60)
});
```

## The session model

- **Sign-in mints a pair**: a short-lived **access token** (used as the `SetAuth` identity) and a
  longer-lived **refresh token**. Both are stored **hashed at rest** (SHA-256); the raw tokens exist
  only in the client. A database leak is not a session-hijack.
- **`ctx.auth.getUserId()`** resolves the ambient access token to a user id via a DB read inside the
  transaction — so identity is part of your query's read-set and **revocation is reactive**.
- **Rotation + reuse detection**: `auth:refresh(refreshToken)` rotates both tokens in place (same
  session id) and remembers the previous refresh hash. Presenting a *previous* refresh token:
  - within the 30s **grace window** → a soft `REFRESH_STALE` (an honest racing tab lost to its
    sibling; no revocation);
  - outside the window → `REFRESH_REUSED`, and the **whole session is deleted** (a theft signal —
    stricter than a surgical subtree invalidation).
- **Expiry**: `REFRESH_EXPIRED` when the sliding refresh window lapses, and when the fixed
  **absolute ceiling** (`sessionTotalTtlMs`) is reached — an actively-refreshing session still forces
  re-authentication at the cap.

## Using it from the client — `createAuthClient`

Sign-in flows are ordinary mutations; hand the result to `createAuthClient`, which manages the token
lifecycle for you (persistence, applying the access token, scheduling refresh at ~80% of the access
TTL, a single-refresher across tabs via Web Locks, and broadcasting the rotated pair to sibling
tabs):

```ts
import { StackbaseClient, webSocketTransport, createAuthClient, anyApi } from "@stackbase/client";

const client = new StackbaseClient(webSocketTransport(url));
const auth = createAuthClient(client, { onSignedOut: () => location.reload() });

const result = await client.mutation(anyApi.auth.signUp, { email, password, deviceLabel: "Chrome on macOS" });
auth.setSession(result);        // persists + applies the access token + schedules refresh
// ... later:
auth.clearSession();            // sign out locally
```

`createAuthClient` persists to `localStorage` by default (with an in-memory fallback where it is
unavailable); pass `{ storage }` for a custom store (Node/Electron hosts). When a session is managed
this way, the durable offline outbox fingerprints by the stable **session id** (not the rotating
token), so a rotation never orphans queued offline mutations.

## Device management

For a "manage your devices" screen:

```ts
const sessions = await client.query(anyApi.auth.listSessions);     // [{ sessionId, deviceLabel, createdAt, lastRefreshAt, current }]
await client.mutation(anyApi.auth.revokeSession, { sessionId });    // kill one device (ownership-checked)
await client.mutation(anyApi.auth.revokeOtherSessions);            // keep this device, kill the rest
```

`listSessions` never returns token or hash material. A revoke deletes the session row, so any tab
authenticated with it flips to signed-out on the next reactive push.

## Anonymous auth

```ts
const anon = await client.mutation(anyApi.auth.signInAnonymously, { deviceLabel: "Safari" });
auth.setSession(anon);
// ... the user does real work, creating rows owned by their (anonymous) userId ...
const upgraded = await client.mutation(anyApi.auth.signUp, { email, password });  // same userId, in place
auth.setSession(upgraded);
```

An anonymous user is a **real user** (`users.anonymous: true`, no email). `signUp` while holding an
anonymous session attaches the email+password account to the **same userId**, clears the flag, and
replaces the sessions — **every row the anonymous user created survives**. `signInAnonymously` is
rejected for an already-authenticated caller and is subject to a deployment-global throttle
(`anonymousSignInsPerMinute`).

## localStorage vs. cookies

Stackbase is **WebSocket-first**: identity flows over the `SetAuth` message, not request headers, so
the client holds the access token in JS (`localStorage` by default) rather than an httpOnly cookie.
The theft mitigation is the session model itself — a short access TTL, refresh rotation, and reuse
detection — not cookie isolation. httpOnly-cookie mode + CSRF is intentionally **out of scope** for
A1 (it would rearchitect identity transport for marginal gain). If your threat model requires cookie
isolation, front Stackbase with your own auth-terminating proxy.

## Roadmap — external identity (not yet shipped)

Third-party identity providers (OAuth) and JWT/JWKS/OIDC token verification for issuers like Clerk or
Auth0 are **planned for the external-identity slice (A3)** and are **not implemented today**. When
they land, JWT verification will apply to third-party issuers only; Stackbase's own sessions stay DB
rows so revocation remains reactive. Email flows (verification, password reset, magic links, OTP) are
the **A2 slice**. This page will be updated as those ship.
