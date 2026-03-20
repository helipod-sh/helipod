---
title: Authentication
---

# Authentication

Stackbase ships a first-party, self-hosted auth component: **`@stackbase/auth`** — email + password
accounts, a hardened session model (short access tokens + rotating refresh tokens with reuse
detection), device management ("manage your sessions"), anonymous sign-in with in-place upgrade, and
a full email-flows surface (email verification, password reset, magic-link and one-time-code
sign-in). Identity flows over the WebSocket sync connection via `SetAuth`, and
`ctx.auth.getUserId()` resolves the current user inside your query/mutation — so **revoking a
session reactively flips every subscribed query**, no polling.

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

## Email flows

`@stackbase/auth` also ships email verification, password reset, magic-link sign-in, and one-time-code
(OTP) sign-in — all built on one internal chokepoint (`_issueCode`) that generates the raw code,
hashes it, and stores only the hash. These flows are **opt-in**: they only register once you pass an
`email` block to `defineAuth`.

### Setup

```ts
import { defineAuth, consoleEmail } from "@stackbase/auth";

export const auth = defineAuth({
  email: {
    provider: consoleEmail(),               // zero-config dev default (see below)
    from: "no-reply@example.com",
    appName: "My App",                      // used in email subject lines (default "Stackbase app")
    baseUrl: "https://app.example.com",     // required to build clickable links for reset/magic/verify
  },
});
```

`consoleEmail()` is the zero-config default: it doesn't deliver anything — it prints the whole
rendered email (subject + body, including the raw code/link) to the **server** console (the terminal
running `stackbase dev`/`serve`). It's fine for local dev, never for production.

For production, use `resendEmail({ apiKey, baseUrl? })` — one `fetch` call to the Resend API, zero
extra dependencies:

```ts
import { defineAuth, resendEmail } from "@stackbase/auth";

export const auth = defineAuth({
  email: {
    provider: resendEmail({ apiKey: process.env.RESEND_API_KEY! }),
    from: "no-reply@example.com",
    appName: "My App",
    baseUrl: "https://app.example.com",
  },
});
```

Anything else — SMTP included — is a custom provider: the seam is just
`{ send(msg: { to, from, subject, text, html? }): Promise<void> }`. SMTP is **not** a built-in
adapter; here's the documented recipe using `nodemailer` (add it as a dependency yourself):

```ts
import nodemailer from "nodemailer";
import type { EmailProvider } from "@stackbase/auth";

function smtpEmail(opts: { host: string; port: number; user: string; pass: string }): EmailProvider {
  const transport = nodemailer.createTransport({
    host: opts.host,
    port: opts.port,
    auth: { user: opts.user, pass: opts.pass },
  });
  return {
    async send(msg) {
      await transport.sendMail({
        to: msg.to, from: msg.from, subject: msg.subject, text: msg.text, html: msg.html,
      });
    },
  };
}
```

### Using the flows from the client

Every `request*` function is an **action** (call it with `client.action`); every redeem function is a
**mutation** (call it with `client.mutation`) and returns a `MintResult` — hand it to
`auth.setSession(...)` exactly like `signUp`/`signIn`. Imports are always `@stackbase/*`, never
`convex/*`.

**Email verification** — gated by `requireEmailVerification` (see Policy flags below). A gated
`signUp`/`signIn` returns `{ needsVerification: true }` instead of a session:

```ts
import { StackbaseClient, webSocketTransport, createAuthClient, anyApi } from "@stackbase/client";

const client = new StackbaseClient(webSocketTransport(url));
const auth = createAuthClient(client);

const outcome = await client.mutation(anyApi.auth.signUp, { email, password });
if ("needsVerification" in outcome) {
  await client.action(anyApi.auth.requestEmailVerification, { email });
  // ... user reads the code/link from their inbox (or the server console with consoleEmail()) ...
  const session = await client.mutation(anyApi.auth.verifyEmail, { email, code });
  auth.setSession(session);
} else {
  auth.setSession(outcome);
}
```

**Password reset**:

```ts
await client.action(anyApi.auth.requestPasswordReset, { email });
const session = await client.mutation(anyApi.auth.resetPassword, { email, code, newPassword });
auth.setSession(session);
```

`resetPassword` revokes **every** session on the account (a credential boundary) before minting the
fresh one it returns.

**Magic-link sign-in**:

```ts
await client.action(anyApi.auth.requestMagicLink, { email });
// user follows the emailed link (built from `baseUrl`) or pastes its token
const session = await client.mutation(anyApi.auth.signInWithMagicLink, { email, token });
auth.setSession(session);
```

**OTP sign-in**:

```ts
await client.action(anyApi.auth.requestOtp, { email });
const session = await client.mutation(anyApi.auth.signInWithOtp, { email, code });
auth.setSession(session);
```

Magic-link and OTP sign-in both adopt an existing user by email or — if `createUsersOnEmailSignIn` is
on (the default) — create one on the fly, passwordless.

### Policy flags

- **`requireEmailVerification`** (default `false`): when `true`, `signUp`/`signIn` for an account
  whose email isn't yet verified return `{ needsVerification: true }` instead of minting a session —
  the client must complete `requestEmailVerification` → `verifyEmail` first. Flip this on when you
  need mailbox ownership proven before granting access.
- **`createUsersOnEmailSignIn`** (default `true`): whether `signInWithMagicLink`/`signInWithOtp` for
  an email with no existing user creates one automatically (passwordless). Set to `false` for
  invite-only signup, where an account must already exist before passwordless sign-in works.

### Abuse defense

| Defense | Config | Behavior |
| --- | --- | --- |
| Per-code attempt counter | `otpAttempts` (default 5) | OTP only: each wrong guess increments a counter; at the cap the code is deleted (locked out) rather than remaining guessable |
| Per-`(email, flow)` cooldown | `requestCooldownMs` (default 60s / `60_000`) | A second `request*` for the same email+flow inside the cooldown throws `EMAIL_COOLDOWN` |
| Global send throttle | `emailSendsPerMinute` (default 100, `0` disables) | A deployment-wide counter of emails sent per minute; over the cap throws `EMAIL_THROTTLED` (protects both cost and enumeration) |
| Anti-enumeration on request | always on | `request*` always returns `{ sent: true }`, whether or not the email has an account — the response never reveals account existence |
| Anti-enumeration on redeem | always on | Every redeem failure (wrong code, expired, already consumed, or no such account) returns the same generic "invalid code" error — no distinguishable failure modes |
| Uniform cooldown (anti-enumeration) | always on | An unknown email still gets a cooldown-tracking row with an unmatchable sentinel hash, so the cooldown itself can't be used as an existence oracle (a known vs. unknown email look identical across two rapid requests) |
| First-mailbox-proof session revocation | always on | Any flow that flips `emailVerified` false→true (`verifyEmail`, `signInWithMagicLink`, `signInWithOtp`) revokes **all** of that user's existing sessions before minting a new one — closing the "parked session" backdoor where an attacker pre-registers an account and keeps a live session after the true owner proves mailbox control. `resetPassword` revokes all sessions unconditionally, every time. An **already-verified** user signing in via magic-link/OTP from a second device is normal multi-device use and revokes nothing. |
| No per-IP rate limiting | deliberate absence | Stackbase's sync transport carries no per-request IP/device identifier to rate-limit on; abuse defense here is per-`(email, flow)` and per-deployment-per-minute, not per-source. Front the deployment with your own reverse proxy if you need IP-level limiting too. |

### Code shapes and TTLs

| Flow | Code shape | Default TTL | Config field |
| --- | --- | --- | --- |
| OTP | 8 numeric digits, zero-padded | 10 minutes | `otpTtlMs` |
| Magic link | 32-char base64url token, embedded in a URL | 1 hour | `magicLinkTtlMs` |
| Password reset | 32-char base64url token | 1 hour | `resetTtlMs` |
| Email verify | 32-char base64url token | 24 hours | `verifyTtlMs` |

Every code/token is generated with a CSPRNG (`node:crypto`) and stored **hashed at rest**
(SHA-256/base64url) — only the raw value that goes out in the email exists outside the database.
Only one active code exists per `(email, flow)` at a time: a new `request*` overwrites the previous
row rather than accumulating them.

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
rows so revocation remains reactive. This page will be updated as that ships.
