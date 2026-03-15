# Auth slice A2 — email flows (design)

**Date:** 2026-03-12
**Status:** Approved (design presented and approved in-session)
**Arc context:** Slice A2 of the three-slice auth arc — A1 session core (SHIPPED, merged
`4fd0ac1`: hashed access+refresh pairs, rotation/reuse detection, device management,
anonymous, the `mintSession` chokepoint), A2 email flows (this), A3 external identity
(OAuth + JWKS/OIDC). Every flow here mints through A1's `mintSession` and inherits its
session model unchanged.

**Goal:** Give `@stackbase/auth` its email surface: an EmailProvider seam (BlobStore-style —
zero-config dev default, one production adapter, fully pluggable), plus email verification,
password reset, magic-link sign-in, and OTP sign-in — hashed-at-rest codes, action-orchestrated
sends, deterministic mutations, and abuse defenses that work without transport identifiers.

## Locked design decisions

1. **One uniform, hashed-at-rest code model for all four flows** (adopting convex-auth's
   discipline; rejecting better-auth's plaintext-by-default rows and stateless replayable
   verification JWTs). Every emailed secret is SHA-256(base64url)-hashed before commit; the
   raw code exists only in the email. Redeem re-hashes the presented code and compares
   constant-time against the single active row.
2. **One active code per `(email, flow)`** — issuing a new code overwrites the previous row
   (a lost email is self-healing; only the last-issued code is ever valid).
3. **Atomic consume-before-validate**: the redeem mutation deletes/consumes the code row as
   part of the same transaction that validates it — under single-writer OCC, concurrent
   redeems of the same code produce exactly one winner.
4. **The send seam straddles the mutation/action boundary** (a shape neither reference has,
   forced by our deterministic-mutation rule and strictly better than both): public
   `request*` functions are ACTIONS that (a) `ctx.runMutation` an internal mutation which
   writes the hashed code + updates throttle counters and COMMITS, then (b) send the email
   through the provider. Torn state is structural-safe: a code is always durably committed
   before a send is attempted; a failed send throws to the caller and a re-request overwrites.
   No scheduler dependency.
5. **Redeem functions are mutations** minting through A1's `mintSession` chokepoint —
   reactive revocation and the session model apply unchanged.
6. **Abuse defense without transport identifiers** (we carry no IP/UA by design, per A1):
   - per-code attempt counter: `otpAttempts` (default 5) wrong guesses deletes the code row
     (re-request required) — adapted from better-auth's embedded counter;
   - per-`(email, flow)` request cooldown: `requestCooldownMs` (default 60s) between
     re-requests → typed `EMAIL_COOLDOWN`;
   - deployment-global send throttle: `emailSendsPerMinute` (default 100, `0` disables) on
     the existing `authCounters` table (same pattern as A1's anonymous throttle) → typed
     `EMAIL_THROTTLED`. Protects the provider bill and caps enumeration probing.
7. **Anti-enumeration**: every `request*` action returns `{ sent: true }` whether or not the
   account exists (for reset/verify on unknown emails, no email is actually sent and no code
   row is written — but the response is identical). Error codes never distinguish
   "no such account" from "wrong code" at redeem: both are the generic invalid-code error.
8. **Password reset is a credential boundary** (matching A1's upgrade precedent and
   convex-auth's posture; better-auth's default-off revocation rejected): `resetPassword`
   revokes ALL of the user's sessions and mints a fresh one in the same transaction.
9. **Cross-account guard**: a code row records the email it was issued for; every redeem
   asserts the presented email matches the row (a reset code can never act on a different
   account) — the convex-auth `Password.ts:196` guard, adopted as a correctness requirement.
10. **Unverified-account adoption clears the password** (better-auth's correctness rule,
    adopted): when magic-link/OTP sign-in adopts a pre-existing password account whose email
    was never verified, the password credential is deleted — otherwise an attacker who
    pre-registered the victim's email with a password keeps a backdoor into the account the
    victim now legitimately owns.
11. **Policy flags are first-class config, not hard-coded** (the references disagree on both,
    so both are options):
    - `requireEmailVerification` (default **false** — existing apps unaffected): when true,
      `signUp`/`signIn` of an unverified password account returns
      `{ needsVerification: true }` (no tokens) and auto-sends a verification code instead
      of minting.
    - `createUsersOnEmailSignIn` (default **true**): magic-link/OTP sign-in creates the user
      on first use (with `emailVerified: true`); when false, unknown emails follow the
      anti-enumeration rule (request succeeds, redeem fails generically).
12. **Successful magic-link/OTP sign-in and successful `verifyEmail` set
    `users.emailVerified: true`** (proof of mailbox control is proof of mailbox control,
    whichever flow demonstrated it).
13. **Code shapes per flow**: OTP = 8 numeric digits (human-typed; 10^8 space against a
    5-attempt budget); magic-link / reset / verify = 32-char base64url high-entropy tokens
    (URL-embedded). TTLs: `otpTtlMs` 10min, `magicLinkTtlMs` 1h, `resetTtlMs` 1h,
    `verifyTtlMs` 24h.
14. **Adapters shipped: console + Resend** (user decision): `consoleEmail()` is the
    zero-config dev default (logs the full email including the code/link to the server
    console); `resendEmail({ apiKey, baseUrl? })` is the production adapter (one `fetch` to
    the Resend API, zero dependencies). Anything else is a custom provider object; SMTP ships
    as a documented nodemailer recipe, not a built-in.

## Schema (component tables, additive)

New table `authCodes`:

```
{
  email,        // normalized; the identity the code was issued for (cross-account guard)
  flow,         // "verify" | "reset" | "magic" | "otp"
  codeHash,     // SHA-256 base64url of the raw code — never the raw code
  expiresAt,
  attempts,     // wrong-guess counter (OTP guessing defense; counts for all flows)
  createdAt,    // also drives the request cooldown
}
index byEmailFlow on ["email", "flow"]   // the (email, flow) natural key — one active row
```

`users` gains `emailVerified: v.optional(v.boolean())`. `authCounters` (from A1) gains a
second named row `emailSends` for the global send throttle. No changes to `sessions` or
`accounts`. All additions pass the additive deploy gate.

## Config (extends A1's `defineAuth`)

```ts
defineAuth({
  // ...A1 options unchanged,
  email: {
    provider: EmailProvider,          // required to enable email flows; absent = flows disabled
    from: string,                     // required
    appName?: string,                 // used in default templates; default "Stackbase app"
    baseUrl?: string,                 // app URL for links in magic/reset/verify templates
    otpAttempts?: number,             // default 5
    otpTtlMs?: number,                // default 10 * 60 * 1000
    magicLinkTtlMs?: number,          // default 60 * 60 * 1000
    resetTtlMs?: number,              // default 60 * 60 * 1000
    verifyTtlMs?: number,             // default 24 * 60 * 60 * 1000
    requestCooldownMs?: number,       // default 60_000
    emailSendsPerMinute?: number,     // default 100; 0 disables the global throttle
    requireEmailVerification?: boolean,  // default false
    createUsersOnEmailSignIn?: boolean,  // default true
    templates?: Partial<EmailTemplates>, // per-flow { subject, text, html? } builders
  }
})
```

`EmailProvider = { send(msg: { to: string; from: string; subject: string; text: string;
html?: string }): Promise<void> }`. `consoleEmail()` and `resendEmail({ apiKey, baseUrl? })`
are exported from `@stackbase/auth`. Template builders receive
`{ appName, email, code?, url?, ttlMs }` per flow and return `{ subject, text, html? }`;
defaults are plain, functional messages. When `email` is absent from config, none of the A2
functions are registered (the component surface stays exactly A1's).

## Component surface

Actions (each: `runMutation` internal write → provider send; always return `{ sent: true }`):
- `requestEmailVerification(email)` — for the account's email; also invoked internally by
  signUp/signIn when `requireEmailVerification` gates them.
- `requestPasswordReset(email)`
- `requestMagicLink(email)`
- `requestOtp(email)`

Internal mutation (not public): `_issueCode(email, flow)` — normalizes email, enforces the
cooldown (`EMAIL_COOLDOWN`) and global throttle (`EMAIL_THROTTLED`), applies anti-enumeration
policy (whether a row is written at all for unknown accounts, per flow + flags), generates
the raw code (shape per decision 13), stores the hashed row (overwriting any prior
`(email, flow)` row), and returns the raw code + send-decision to the action. The raw code
never appears in any stored row or log.

Mutations (redeems; all consume-before-validate, all errors code-as-message):
- `verifyEmail(email, code, deviceLabel?)` → sets `emailVerified: true` and ALWAYS mints a
  session (mint-shaped result) — proof of mailbox control is sign-in-grade proof, identical
  to the magic-link posture, with no path-dependence on how the caller got here.
- `resetPassword(email, code, newPassword)` → cross-account guard, re-hash password
  (argon2id, unchanged from A1), delete ALL the user's sessions (byUserId), mint fresh →
  mint-shaped result. Typed failures: generic `"invalid code"` (wrong/expired/consumed/no
  such account — indistinguishable), `EMAIL_CODE_EXPIRED` is NOT distinguished externally
  (expired = generic invalid; the row is deleted on expiry-hit).
- `signInWithMagicLink(email, token, deviceLabel?)` → mint-shaped result; creates the user
  per `createUsersOnEmailSignIn`; sets `emailVerified: true`; clears an unverified adopted
  account's password (decision 10).
- `signInWithOtp(email, code, deviceLabel?)` → same semantics as magic link, plus the
  attempt counter: a wrong guess increments `attempts` (commit-then-throw so the count
  survives the failed call, same mechanism as A1's lockout) and at `otpAttempts` the row is
  deleted.

signUp/signIn integration (only when `requireEmailVerification: true` and email configured):
password signUp and signIn of an unverified account return `{ needsVerification: true }`
with no tokens — the mutation never does I/O, so the CLIENT responds to `needsVerification`
by calling the `requestEmailVerification` action (the auth-demo shows the pattern). The
`verifyEmail` redeem then mints.
Anonymous upgrade (A1) composes: an anonymous user upgrading via signUp under the
verification gate gets `needsVerification` and keeps working anonymously until verified.

Typed error codes (code-as-message, per A1 convention): `EMAIL_COOLDOWN`, `EMAIL_THROTTLED`,
`EMAIL_NOT_CONFIGURED` (calling an A2 function when `email` config is absent — defensive,
normally unregistered), plus generic `"invalid code"` for all redeem failures.

## Client (`@stackbase/client`)

No new client machinery required — the flows are ordinary actions/mutations callable through
the generated api, and successful redeems return mint-shaped results the app hands to A1's
`createAuthClient.setSession()`. The auth-demo gains the flows' UI (verify banner, forgot-
password, magic-link/OTP sign-in) as the reference pattern.

## Testing

- Component-level (`@stackbase/test`), adapting the reference suites' behavioral assertions
  (attribution comments where adapted; convex-auth Apache-2.0, better-auth MIT):
  - hashed-at-rest: no raw code in any stored row; redeem works from the raw code.
  - only the LAST issued code per (email, flow) verifies (re-request overwrites).
  - single-use: a consumed code fails on replay; concurrent redeems → exactly one winner.
  - expiry: expired code = generic invalid; row cleaned up.
  - OTP brute force: `otpAttempts` wrong guesses delete the row (correct code then fails —
    lockout is real); attempt counter survives the failed calls (commit-then-throw).
  - cooldown: immediate re-request → `EMAIL_COOLDOWN`; after the window a new code issues.
  - global throttle: trips at the cap, recovers next window.
  - anti-enumeration: request for unknown email returns `{ sent: true }`, sends nothing,
    writes nothing (capture provider asserts zero sends).
  - reset: old password dead, new works, ALL other sessions revoked, fresh session minted,
    cross-account guard (code for A cannot reset B).
  - magic/OTP: user created on first use (and NOT when `createUsersOnEmailSignIn: false`);
    `emailVerified` set; unverified adopted account's password cleared (attribution:
    better-auth magic-link.test.ts:268); OTP requires the matching email (attribution:
    convex-auth otp.test.ts:25).
  - verification gate: `requireEmailVerification: true` → signUp returns
    `needsVerification`, no tokens; verifyEmail then mints; default-false leaves A1
    behavior byte-identical.
- E2E through the real `stackbase dev` server (`packages/cli/test/auth-email-e2e.test.ts`):
  an in-memory capture provider (test-only) records sends; full magic-link round trip
  (request → capture the link → redeem → session works, live subscription sees identity);
  password reset revocation fans out reactively to a live subscription on another
  connection; console provider smoke (the zero-config path prints and succeeds).
- Provider unit tests: `resendEmail` request shape against a mocked fetch (auth header,
  payload, error propagation on non-2xx); `consoleEmail` output shape.

## Docs

`docs/enduser/build/auth.md` gains the email-flows section (setup with console default,
Resend for production, the SMTP recipe, each flow's client-side usage, the policy flags,
the abuse-defense table); `components/auth/README.md` limitations re-baselined (email flows
shipped; A3 roadmap note updated to OAuth/JWKS only).

## Non-goals (A2)

- Email change/update flows (verify-new-address dance) — future.
- SMS/phone OTP — no SMS seam exists; future.
- Per-IP rate limiting, IP/UA capture — carried forward from A1 by design.
- Template theming beyond `{ subject, text, html? }` builders.
- SMTP as a built-in adapter (documented recipe instead — user decision).
- Queued/retried sends (a failed send throws; re-request overwrites — the scheduler-backed
  outbox pattern is deliberately deferred until demanded).
- convex-auth-style `redirectTo`/OAuth-adjacent URL plumbing (A3 territory).

## Reference implementations consulted

`.reference/convex-auth` (Apache-2.0) and `.reference/better-auth` (MIT). Adopted from
convex-auth: the uniform hashed-at-rest code discipline, one-active-code-overwrite,
consume-before-validate, reset-revokes-all+mints, the cross-account guard. Adopted from
better-auth: the per-code attempt counter (theirs: 3, embedded in the stored value; ours: 5,
a first-class field), unverified-adoption-clears-password, `{ sent: true }` enumeration
silence, per-flow policy flags. Rejected: better-auth's plaintext-at-rest defaults and
stateless verification JWTs (violate hashed-at-rest; the JWT variant is unrevocable and
replayable), both references' single-execution-context send ordering (our mutation/action
split is structurally safer), better-auth's per-IP/per-endpoint rate limits (no transport
identifiers by design), and convex-auth's Auth.js provider-object shape (we are not Auth.js;
a plain `send()` seam is the whole surface we need).
