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

## Two-factor authentication (TOTP)

`@stackbase/auth` also supports TOTP-based two-factor authentication (RFC 6238 — Google
Authenticator, Authy, 1Password, and the rest of the authenticator-app ecosystem) with
one-time recovery codes as the backup factor. It gates every first-factor sign-in success
(password, magic-link, OTP, email verification, password reset, and social/OAuth sign-in
alike) behind a second factor, without ever bypassing the session-minting chokepoint —
`finishSignIn` wraps `mintSession`, it never replaces it. MFA is **opt-in**: it only
registers once you pass an `mfa` block to `defineAuth`, and a deployment without one is
byte-identical to today.

### Setup

```ts
import { defineAuth } from "@stackbase/auth";

export const auth = defineAuth({
  mfa: {
    // A 32-byte key, base64 or hex, sourced from the environment — never hardcoded.
    encryptionKey: process.env.STACKBASE_AUTH_MFA_KEY!,
    issuer: "My App",          // otpauth:// issuer label shown in the authenticator app (default "Stackbase")
  },
});
```

Generate a key once per deployment:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

`defineAuth` **fails fast** at boot if `mfa` is configured without a usable 32-byte key (a
missing, empty, or wrong-length key is a config error, not a runtime surprise) — the same
posture as `STACKBASE_ADMIN_KEY` for the admin/storage surfaces.

The TOTP secret is encrypted at rest with **AES-256-GCM** under this key (not hashed — a
one-way hash would make verification impossible, since the server has to *recompute* the
expected code every time). Everything else the account already trusts — session tokens,
email codes — is a one-way hash instead, because those are only ever compared, never
recovered.

### The enroll → confirm → gate → complete flow

Enrollment is **two-phase**: `startMfaEnrollment` hands back a secret nobody can use to gate
sign-in yet; only `confirmMfaEnrollment`, by proving a live code, actually turns MFA on. This
guarantees a user can't lock themselves out mid-setup with a mistyped or unscanned secret.

```ts
import { StackbaseClient, webSocketTransport, createAuthClient, anyApi } from "@stackbase/client";

const client = new StackbaseClient(webSocketTransport(url));
const auth = createAuthClient(client);

// 1. Enroll (while already signed in). The raw secret + otpauth:// URI are returned ONCE —
//    render the URI as a QR code for the user to scan with their authenticator app.
const enrollment = await client.mutation(anyApi.auth.startMfaEnrollment, {});
// enrollment: { secret, otpauthUri, digits, period, algorithm }
showQrCode(enrollment.otpauthUri);

// 2. Confirm with the first live code the app displays — this is what activates MFA and
//    mints the one-time recovery-code set (also returned ONCE — show it for the user to
//    save/print/download; there is no way to view it again after this response).
const { recoveryCodes } = await client.mutation(anyApi.auth.confirmMfaEnrollment, { code: userEnteredCode });
showRecoveryCodesOnce(recoveryCodes);
```

From here on, every gated sign-in path (`signIn`, verified `signUp`, `verifyEmail`,
`signInWithMagicLink`, `signInWithOtp`, `resetPassword`, and the OAuth/JWT mint paths) returns
`{ mfaRequired: true, pendingToken, expiresAt }` instead of a session the moment the first
factor succeeds — no token, no `MintResult`, nothing an app could mistake for being signed in:

```ts
const outcome = await client.mutation(anyApi.auth.signIn, { email, password });
if ("mfaRequired" in outcome) {
  // Prompt for a 6-digit authenticator code (or "use a recovery code instead").
  const session = await client.mutation(anyApi.auth.completeMfaSignIn, {
    pendingToken: outcome.pendingToken,
    code: userEnteredCode,     // a live TOTP code OR one of the recovery codes — one input box
  });
  auth.setSession(session);   // same MintResult shape as every other sign-in path
} else {
  auth.setSession(outcome);
}
```

`pendingToken` authorizes only a second-factor attempt for that one user, once, within
`challengeTtlMs` (default 5 minutes) — it is never a session credential itself, and
`ctx.auth.getUserId()` never resolves it. Five wrong `completeMfaSignIn` guesses (default,
`mfaAttempts`) burn the pending window entirely; the client must restart from the first
factor.

### Recovery codes

`confirmMfaEnrollment` mints 10 one-time recovery codes (`recoveryCodeCount`, default 10),
shown to the user exactly once. Each is a backup second factor: `completeMfaSignIn` accepts
either a live TOTP code or a recovery code through the same `code` field, and a recovery code
is deleted (consumed) the moment it's used — it cannot be replayed. Track the remaining count
so you can nudge the user to regenerate before they run out:

```ts
const status = await client.query(anyApi.auth.getMfaStatus, {});
// { enrolled: boolean, confirmed: boolean, recoveryCodesRemaining: number }

if (status.recoveryCodesRemaining < 3) {
  const { recoveryCodes } = await client.mutation(anyApi.auth.regenerateRecoveryCodes, { code: userEnteredTotpCode });
  showRecoveryCodesOnce(recoveryCodes); // replaces the WHOLE set — the old codes stop working
}
```

`regenerateRecoveryCodes` requires a **live TOTP code specifically** — a recovery code
cannot mint a fresh batch of recovery codes (it would be self-referential, and would also
burn one of the codes being replaced).

### Disabling MFA

```ts
await client.mutation(anyApi.auth.disableMfa, { code: userEnteredCode }); // TOTP or recovery code
```

`disableMfa` requires a **fresh, currently-valid** second factor — proof of possession, not
just an active session — so a stolen-but-still-live access token can't silently strip a
victim's second factor. It deletes the enrollment and every recovery code; the very next
sign-in mints directly again, with no `mfaRequired` step.

### The honest boundary: losing the authenticator

There is no backdoor around a lost authenticator app **and** lost recovery codes together.
This is deliberate — an unconditional bypass would defeat the point of a second factor. Two
supported recoveries:

- **A saved recovery code** — the intended path. Any one of the 10 codes shown at enrollment
  completes `completeMfaSignIn` exactly like a TOTP code, and you should tell users, in
  the UI, to save them somewhere durable (a password manager, printed and filed) the moment
  they're shown.
- **An admin/support-side reset** — your app decides this policy (e.g. a support flow that
  verifies identity out-of-band, then calls `disableMfa` with elevated privileges, or simply
  deletes the user's `mfaEnrollments`/`mfaRecoveryCodes` rows directly via the dashboard).
  Stackbase does not ship an automatic "reset MFA" flow — that decision belongs to your
  app's support/identity-verification process, not the auth component.

There is also no self-service "remember this device for 30 days" skip: every gated sign-in
challenges, every time, on every device.

### Encryption-key rotation

The `mfa` config also accepts a keyring for rotation:

```ts
defineAuth({
  mfa: {
    encryptionKeys: [
      { id: "2", key: process.env.STACKBASE_AUTH_MFA_KEY_2! }, // NEW primary — encrypts going forward
      { id: "1", key: process.env.STACKBASE_AUTH_MFA_KEY_1! }, // retired — still decrypts old secrets
    ],
  },
});
```

The **first** entry is always the primary (used for all new encryptions); decryption
dispatches on the `keyId` embedded in each stored secret's envelope, so existing enrollments
keep working under a retired key until their owner re-enrolls. Only drop a retired key once
no confirmed enrollment still references its `keyId` — losing every keyring entry that could
decrypt a given secret permanently strands it (the account falls back to recovery codes, then
re-enrollment; there is no server-side recovery of a lost key, by design — the same
responsibility contract as `STACKBASE_ADMIN_KEY`).

### Non-goals

Not built, and not planned for this slice: SMS/phone-based two-factor, more than one confirmed
TOTP enrollment per user, trusted-device 2FA skip, per-operation step-up re-prompts beyond
disable/regenerate re-auth, admin-forced org-wide MFA policy, and automatic bulk key-rotation
tooling. (Passkeys have since shipped as a separate first-factor sign-in method — see
[Passkeys](#passkeys-webauthn) below; using a passkey to *satisfy* an MFA step-up is a reserved
follow-on noted there.) `algorithm`/`digits`/`period` are fixed at SHA1/6/30 (the
combination the authenticator-app ecosystem broadly supports) — not app-configurable in v1.

## Passkeys (WebAuthn)

`@stackbase/auth` supports **passkeys** — WebAuthn credentials (Face ID / Touch ID / Windows
Hello / a hardware security key / a synced platform passkey) as a phishing-resistant,
passwordless sign-in. A passkey is a first factor like a password or a social login: it flows
through the same session-minting chokepoint, so revocation, device management, and reactive
identity all work identically no matter how the user signed in. Passkeys are **opt-in** — they
register only once you pass a `passkeys` block to `defineAuth`, and a deployment without one is
byte-identical to today.

### Setup

```ts
import { defineAuth } from "@stackbase/auth";

export const auth = defineAuth({
  passkeys: {
    rpID: "example.com",          // your Relying Party ID — the registrable domain, no scheme/port
    rpName: "My App",             // human-readable label shown in the OS passkey prompt
    origins: ["https://example.com"], // every web origin the ceremony may run from (exact-match)
  },
});
```

`rpID`, `rpName`, and `origins` are **required** (there is no safe default for a security
domain). `defineAuth` **fails fast** at boot if any is missing, and validates every origin with
the same rule the OAuth redirect allowlist uses: a loopback `http://localhost` origin is allowed
for local dev, but any non-loopback origin **must** be `https://` (a plaintext production origin
is a downgrade an attacker could exploit). Optional knobs and their defaults:

| Field | Default | Meaning |
|---|---|---|
| `userVerification` | `"preferred"` | Whether the authenticator must verify the user (biometric/PIN). `"required"` forces it. |
| `residentKey` | `"preferred"` | Whether to create a **discoverable** credential (enables usernameless sign-in). |
| `maxCredentialsPerUser` | `20` | Per-user credential cap; registering past it is a typed `PasskeyLimitReached`. |
| `challengeTtlMs` | `300000` (5 min) | How long an issued registration/authentication challenge stays valid. |

### The two ceremonies

WebAuthn is a two-message handshake on each side. The server issues a one-time **challenge**
(the `begin*` action), the authenticator signs it, and the server verifies the signature (the
`finish*` action). The browser half is `@simplewebauthn/browser`; the crypto lives entirely
server-side (in an action — never in a query/mutation).

```bash
npm install @simplewebauthn/browser
```

**Register a passkey** (the user must already be signed in — including
[anonymously](#anonymous-auth), which is the passwordless-bootstrap path: sign in anonymously,
register a passkey, and the account is now reachable from any device with no password ever set):

```ts
import { startRegistration } from "@simplewebauthn/browser";
import { StackbaseClient, webSocketTransport, createAuthClient, anyApi } from "@stackbase/client";

const client = new StackbaseClient(webSocketTransport(url));
const authClient = createAuthClient(client);

async function registerPasskey() {
  // 1. Server issues creation options (with a fresh challenge) for the signed-in caller.
  const options = await client.action(anyApi.auth.beginPasskeyRegistration, {});
  // 2. The browser/OS prompts the user and produces a signed attestation.
  const response = await startRegistration({ optionsJSON: options });
  // 3. Server verifies it and stores the credential.
  await client.action(anyApi.auth.finishPasskeyRegistration, { response });
}
```

**Sign in with a passkey.** Two shapes share the same finish call:

```ts
import { startAuthentication } from "@simplewebauthn/browser";

async function signInWithPasskey(email?: string) {
  // Usernameless (omit email) uses a DISCOVERABLE credential — the OS shows the user their
  // saved passkeys and no account hint is sent. Passing an email scopes the allowed credentials
  // to that account (for a non-discoverable key); an unknown email returns the SAME empty shape
  // as a known one with no passkeys, so it is never an account-existence oracle.
  const options = await client.action(anyApi.auth.beginPasskeyAuthentication, email ? { email } : {});
  const response = await startAuthentication({ optionsJSON: options });
  const outcome = await client.action(anyApi.auth.finishPasskeyAuthentication, { response });

  if ("mfaRequired" in outcome) {
    // The user has TOTP enrolled — a passkey is a first factor, so it does NOT bypass an
    // explicitly-configured second factor. Complete exactly like any other gated sign-in.
    const session = await client.mutation(anyApi.auth.completeMfaSignIn, {
      pendingToken: outcome.pendingToken,
      code: userEnteredCode,
    });
    authClient.setSession(session);
  } else {
    authClient.setSession(outcome); // a normal MintResult
  }
}
```

### Device management

A user's passkeys are managed exactly like their [sessions](#device-management):

```ts
const passkeys = await client.query(anyApi.auth.listPasskeys, {});
// [{ passkeyId, deviceName, transports, backedUp, createdAt, lastUsedAt }, ...]
//   — display metadata only; the public key and signature counter never leave the server.

await client.mutation(anyApi.auth.renamePasskey, { passkeyId, deviceName: "My iPhone" });
await client.mutation(anyApi.auth.revokePasskey, { passkeyId });
```

`listPasskeys` is reactive — revoking a credential on one device updates a live list on another.
Rename and revoke are ownership-checked: another user's `passkeyId` is a generic "passkey not
found", never a cross-user leak. A revoked passkey is un-authenticatable immediately.

### Security notes

- **Challenge / origin / RP-ID binding.** Every ceremony is bound to a fresh single-use
  challenge (consumed before validation, so a replay finds nothing) and verified against the
  configured `origins` and `rpID` — an assertion captured on a phishing origin does not verify.
- **Clone detection.** Each credential carries a signature counter; an authentication that
  presents a counter which regressed (or repeated a non-zero value) is rejected atomically —
  no session minted, no state changed — as a possible cloned authenticator.
- **Anti-enumeration.** Every authentication failure — unknown credential, wrong owner,
  bad signature, stale challenge — collapses to one generic message, and a `begin` for an
  unknown email is byte-shaped like a known one, so passkey sign-in is never an account oracle.
- **No key-material leak.** `listPasskeys` returns display metadata only; the COSE public key
  and counter are never sent to a client.

### Non-goals (reserved follow-ons)

Passkey **as a second factor** — i.e. a user-verified passkey assertion *satisfying* an MFA
step-up so an MFA-enrolled user can skip TOTP — is a deliberate future refinement, not built
here: today a passkey is strictly a first factor and honors any enrolled second factor. Also not
built: attestation-format / MDS verification (registration uses `none` attestation), a dedicated
email-capturing passkey **sign-up** (register runs against an existing authed account), and
conditional-UI autofill.

## External identity

`@stackbase/auth` also supports signing in via a **third-party OAuth provider** (Google, GitHub,
Microsoft, Discord, Facebook, Apple, or any custom OIDC/OAuth2 provider) and via a **third-party
JWT/OIDC issuer** (Clerk, Auth0, or any
issuer that publishes a JWKS) — both opt-in, both composing through the same account-linking core as
password/email sign-in. Stackbase's own sessions always stay DB rows: an external identity is
resolved to (or linked with) a local `userId`, then a normal Stackbase session is minted for it — so
revocation stays reactive no matter how the user originally signed in.

### OAuth setup

Configure providers and a redirect allowlist on `defineAuth({ oauth })`:

```ts
import {
  defineAuth, googleProvider, githubProvider,
  microsoftProvider, discordProvider, facebookProvider, appleProvider,
} from "@stackbase/auth";

export const auth = defineAuth({
  oauth: {
    providers: {
      google: googleProvider({ clientId: process.env.GOOGLE_CLIENT_ID!, clientSecret: process.env.GOOGLE_CLIENT_SECRET! }),
      github: githubProvider({ clientId: process.env.GITHUB_CLIENT_ID!, clientSecret: process.env.GITHUB_CLIENT_SECRET! }),
      microsoft: microsoftProvider({ clientId: process.env.MS_CLIENT_ID!, clientSecret: process.env.MS_CLIENT_SECRET! }),
      discord: discordProvider({ clientId: process.env.DISCORD_CLIENT_ID!, clientSecret: process.env.DISCORD_CLIENT_SECRET! }),
      facebook: facebookProvider({ clientId: process.env.FB_APP_ID!, clientSecret: process.env.FB_APP_SECRET! }),
      apple: appleProvider({
        clientId: process.env.APPLE_SERVICES_ID!,   // your Services ID, e.g. com.acme.web
        teamId: process.env.APPLE_TEAM_ID!,
        keyId: process.env.APPLE_KEY_ID!,
        privateKey: process.env.APPLE_PRIVATE_KEY!, // the .p8 PKCS#8 PEM contents
      }),
    },
    // REQUIRED — an open-redirect guard. Every `redirectTo` passed to `/start` must match one of
    // these origin+path-prefix entries (exact-path or subtree match), or `/start` 400s before any
    // state is written.
    redirectAllowlist: ["https://app.example.com/auth/callback"],
  },
});
```

`redirectAllowlist` is required and non-empty — `defineAuth` throws at config time otherwise.
`googleProvider`/`githubProvider`/`microsoftProvider`/`discordProvider`/`facebookProvider`/
`appleProvider` are all thin builders over the public `oauthProvider({ kind, ... })` seam, so any
other OIDC (`kind: "oidc"`, discovery-based) or OAuth2 (`kind: "oauth2"`, explicit
`authorizationEndpoint`/`tokenEndpoint`/`userinfoEndpoint`, typically with a custom `mapClaims` since
a generic OAuth2 userinfo response isn't shaped like OIDC claims) provider is a config entry, not a
code change:

```ts
import { oauthProvider } from "@stackbase/auth";

const acmeProvider = oauthProvider({
  kind: "oidc",
  issuer: "https://auth.acme.com",
  clientId: "...",
  clientSecret: "...",
});
```

### Built-in providers

All six builders share the same flow — register the engine's **callback** URL
(`https://<deployment>/api/auth/oauth/<name>/callback`) as the redirect URI with the provider, then
send users to `GET /api/auth/oauth/<name>/start?redirectTo=…`. Provider-specific notes:

- **`microsoftProvider({ clientId, clientSecret, tenant?, scopes? })`** — Microsoft Entra ID (OIDC).
  `tenant` defaults to `"common"` (also `"organizations"`, `"consumers"`, or a tenant GUID /
  `*.onmicrosoft.com`). For the multi-tenant authorities the id_token's issuer is tenant-specific, so
  Stackbase relaxes the issuer **string** check while still verifying the token's signature against
  Microsoft's keys. **Autolinking requires the `xms_edov` optional claim** — Entra emits no
  `email_verified`; without `xms_edov` a Microsoft sign-in is treated as unverified and never links to
  an existing account. Enable `xms_edov` (email-domain-owner-verified) in your app's token
  configuration in the Entra portal.

- **`discordProvider({ clientId, clientSecret, scopes? })`** — Discord (OAuth2, `/users/@me`). Default
  scopes `identify email`. Email is linked only when Discord reports it as `verified`.

- **`facebookProvider({ clientId, clientSecret, scopes?, graphVersion? })`** — Meta / Facebook Login
  (OAuth2, Graph `/me`). Graph version is pinned (`v25.0`); override with `graphVersion`. Facebook only
  returns confirmed emails, and an app may not receive an email at all — an absent email means a
  separate account, never a placeholder.

- **`appleProvider({ clientId, teamId, keyId, privateKey, scopes? })`** — Sign in with Apple (OIDC,
  `form_post`). `clientId` is your **Services ID** (not the app bundle id). `teamId`/`keyId`/
  `privateKey` come from a **Sign-in-with-Apple key** (`.p8`, PKCS#8 PEM). Apple issues no static client
  secret — Stackbase mints a short-lived **ES256 JWT** from your `.p8` on each token exchange (cached,
  auto-refreshed); the private key stays on the server and is never stored. Apple returns the response
  as an HTTP **POST** (`form_post`) and sends the user's **name only on the first authorization**, as a
  `user` field in the POST body. Stackbase uses that name for a **cosmetic display name only** —
  identity (the account id, email, and email-verified status) always comes from the signature-verified
  id_token, never from the POST body. (Apple's `transfer_sub` app-transfer remapping is not handled — a
  rare migration event.)

**Production issuers/providers must be `https://`.** Stackbase's config-time MITM guard
(`assertProviderEndpointsSecure`) rejects a non-loopback `http://` issuer or endpoint outright — the
`http://` exception exists ONLY for a loopback host (`127.0.0.1`/`localhost`/`::1`), for local dev and
testing. Every provider above (and any custom `oauthProvider`) is subject to this same guard.

**The engine mounts the OAuth routes for you** — `GET /api/auth/oauth/:provider/start` and
`/api/auth/oauth/:provider/callback` (both `GET` and `POST` — Apple's `form_post` mode delivers the
authorization response as an HTTP POST, everyone else as a `GET` redirect; the engine handles either
transparently) — the moment `oauth` is configured; there's no app code to write for them. **Register
the *callback* URL** (`https://<your-deployment>/api/auth/oauth/<name>/callback`) as the redirect URI
with each provider (Google/GitHub/Microsoft/Discord/Facebook: the OAuth redirect URI; Apple: the
Services ID's "Return URL"), not your app's own URL — the flow always comes back through the engine
first.

The client-side flow:

```ts
// 1. Kick off sign-in — a plain navigation (not a fetch), so the browser follows the 302 to the
//    provider's own consent screen:
location.href = `${apiUrl}/api/auth/oauth/google/start?redirectTo=${encodeURIComponent("https://app.example.com/auth/callback")}`;

// 2. The provider redirects back through the engine's own /callback, which 302s to `redirectTo`
//    with a one-time code in the URL FRAGMENT (never the query string — fragments are never sent to
//    servers or logged in a Referer header): https://app.example.com/auth/callback#code=<handoff>
//
// 3. On that page's load, read the fragment and exchange it for a session:
import { StackbaseClient, webSocketTransport, createAuthClient, anyApi } from "@stackbase/client";

const client = new StackbaseClient(webSocketTransport(url));
const auth = createAuthClient(client);

const code = new URLSearchParams(location.hash.slice(1)).get("code");
if (code) {
  const session = await client.action(anyApi.auth.completeOAuthSignIn, { handoffCode: code });
  auth.setSession(session);       // same MintResult shape as signUp/signIn — persists + applies the token
  history.replaceState(null, "", location.pathname); // drop the fragment from the visible URL
}
```

The handoff code is **single-use** (consume-before-validate — a second exchange of the same code
rejects) and short-lived (`handoffTtlMs`, default 2 minutes). It never carries a real session
token — only `completeOAuthSignIn` (an action, so it can `runMutation` the actual mint) trades it for
one.

**Link-while-signed-in** ("connect your Google account" from a settings page): if the request that
hits `/start` carries the current session's access token as `Authorization: Bearer <token>`, a
successful callback links the external identity to *that* signed-in user instead of resolving by
email. Because a plain navigation (`location.href = ...`, as in step 1 above) can't attach a custom
header, this path needs a `fetch("/start?...", { headers: { authorization: \`Bearer ${token}\` } })`
instead of a bare link/redirect for that specific call.

### Third-party JWT / OIDC setup

For providers that hand your frontend a signed ID token directly (Clerk, Auth0, Supabase Auth, or any
OIDC issuer) rather than redirecting through your backend, configure `jwt.issuers` and call
`signInWithIdToken`:

```ts
export const auth = defineAuth({
  jwt: {
    issuers: [
      { issuer: "https://your-tenant.clerk.accounts.dev", audience: "your-audience" },
      // jwksUrl is optional — it defaults to `${issuer}/.well-known/jwks.json`; set it explicitly
      // only when a provider publishes its JWKS somewhere else.
    ],
  },
});
```

```ts
const idToken = await clerk.session.getToken(); // however your provider hands you its ID token
const session = await client.action(anyApi.auth.signInWithIdToken, { idToken });
auth.setSession(session);
```

`signInWithIdToken` verifies the token exactly once — signature (via a live JWKS fetch, `jose`),
`iss`, `aud`, `exp`/`nbf` — against the first matching configured issuer, then resolves/links/mints a
Stackbase session through the same core the OAuth callback uses. A first-sight identity is
JIT-provisioned into a brand-new local user; a returning one resolves to its existing `userId`.

**This is an exchange model, not per-request verification** — deliberately diverging from Convex's
design, where the third-party JWT itself *is* the ambient identity, re-verified on every request.
Stackbase instead verifies the token **once** and trades it for a normal Stackbase session (its own
access/refresh token pair, a real DB-backed `sessions` row, a real local `userId`). This is why:

- **Revocation stays reactive.** A DB-backed session can be listed (`listSessions`) and revoked
  (`revokeSession`) like any other Stackbase session — a bare third-party JWT can't be listed or
  killed early; you'd have to wait out its `exp`.
- **`ctx.auth.getUserId()` resolves to a real local `userId`** usable everywhere your schema
  references a user (foreign keys, ownership checks), rather than a foreign `sub` string your schema
  would otherwise have to map itself on every request.
- **No per-request JWKS/verification cost.** Verification happens once, at exchange time; every
  request after that is an ordinary Stackbase session lookup — the same cost profile as password
  sign-in.

A stateless per-request-JWT-is-identity model (verify the token fresh on every call, no local session
row at all) is a deliberate non-goal — it would give up reactive revocation and a real local `userId`
for no benefit Stackbase's session model doesn't already provide.

### Account linking — the safety rules

Both flows funnel through one shared resolution core, so linking behaves identically whether the
identity came from OAuth or from `signInWithIdToken`. In order:

1. **Returning identity.** If this exact `(provider, accountId)` pair is already bound to a user,
   sign in as that user. (`provider` is `"google"`/`"github"`/your custom provider's key for OAuth, or
   `"oidc:<issuer>"` for `signInWithIdToken`.)
2. **Link-while-signed-in.** If the caller proved an existing session (the `Bearer` token at
   `/start`), the new external account is attached to *that* session's user — no email comparison at
   all.
3. **Verified-email autolink.** Only if the external identity's email comes back **verified** (a hard
   boolean from the provider/token, e.g. Google/OIDC's `email_verified`, GitHub's per-address
   `verified` flag) AND it matches an existing user's email, the external account is linked to that
   user. Linking a verified email additionally revokes **every** existing session on that account —
   the same first-mailbox-proof rule A2's email flows use (`markVerifiedRevokingIfFirstProof`): if the
   matched user was not already `emailVerified` (e.g. a pre-registered, never-verified password
   account — the classic pre-registration-takeover shape), this is the *first* proof anyone has
   controlled that mailbox, so every session on the account is killed before the link completes. An
   **already-verified** user linking a second provider has no flip and keeps their other sessions —
   normal multi-device use, already proven safe.
4. **Unverified email NEVER autolinks.** If the email is missing, or present but not verified, step 3
   is skipped entirely regardless of whether it matches an existing user — an attacker cannot claim
   someone else's account by presenting an unverified or spoofable email address. A brand-new user is
   provisioned instead.
5. **No match at all** — same outcome as step 4: a fresh user is created and the external account is
   bound to it.

### Security notes

| Concern | Mechanism |
| --- | --- |
| CSRF on the OAuth redirect | A random `state`, hashed (SHA-256) before being stored, single-use (consumed — deleted — before it is ever validated, so a replayed callback with the same `state` 400s) |
| Authorization-code injection | PKCE (`code_verifier`/`code_challenge`, S256) on every OAuth exchange, plus an OIDC `nonce` bound into the `id_token` where applicable |
| Open redirect | `redirectTo` must match `redirectAllowlist` (origin + path-prefix, segment-boundary-aware) — checked at `/start` *and* re-checked at `/callback` before any account/session write |
| Cookies | None — no cookie is ever set. OAuth state and the post-callback handoff are ephemeral DB rows keyed by a hash of a random token; the actual credential handoff is the URL fragment, read once by the app and never sent to any server |
| Tokens in the URL | Never — only a one-time, single-use handoff *code* transits the URL (in the fragment); real session tokens are only ever returned in an RPC response body |
| At-rest hashing | OAuth `state` and the handoff code are stored hashed (SHA-256/base64url), never raw — with one narrow exception: the PKCE `code_verifier` and OIDC `nonce` are stored in the (short-lived, single-use) state row in recoverable form, because the code itself needs the literal value to complete the token exchange; they are deleted the moment the state row is consumed |
| Consume-before-validate | Both the OAuth state row and the handoff row are deleted *before* their contents are checked (provider match, expiry) — so a failure after a valid-looking row is found still burns it; nothing is retryable by resubmission |
| No enumeration | Every OAuth/JWT failure (bad state, expired handoff, failed token exchange, bad signature, wrong issuer/audience, expired token) surfaces as the same generic "authentication failed" — no distinguishable failure modes |
| Plain-http endpoints | **Loopback only.** A non-loopback (i.e. not `127.0.0.1`/`localhost`/`::1`) `http://` provider endpoint, issuer, or JWKS URL is *rejected at config time* — `defineAuth` throws before the app ever boots. In production, every OAuth provider endpoint and every JWT issuer/JWKS URL **must** be `https://`; plain `http://` is tolerated only for local dev/testing against a loopback mock. There is no config flag to weaken this. |

Native `@stackbase/*` imports throughout — never `convex/*`.
