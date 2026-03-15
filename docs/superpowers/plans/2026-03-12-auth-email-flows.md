# Auth slice A2 — email flows (implementation plan)

For agentic workers: use the `superpowers:subagent-driven-development` skill to execute this plan — each task below is an independently reviewable unit; dispatch one subagent per task, in order.

**Goal:** Give `@stackbase/auth` its email surface — an `EmailProvider` seam (console dev default + Resend production adapter, fully pluggable), plus email verification, password reset, magic-link sign-in, and OTP sign-in. All emailed secrets are SHA-256/base64url hashed at rest (raw code only in the email), sends are action-orchestrated over deterministic mutations, and abuse defenses (per-code attempt counter, per-`(email,flow)` cooldown, deployment-global send throttle) work without any transport identifiers. Every redeem mints through A1's `mintSession` chokepoint and inherits the A1 session model unchanged.

**Architecture:** The `email` config block (with a required `provider`) extends A1's `defineAuth`; when absent, `makeAuthModules` registers **exactly** the A1 surface (no A2 functions). The send seam straddles the mutation/action boundary (decision 4): the four public `request*` functions are ACTIONS that first `ctx.runMutation("auth:_issueCode", …)` — an internal (`_`-prefixed) mutation that writes the hashed code row + updates throttle counters and COMMITS, returning the raw code + a send-decision — then send the email through the provider. The internal-mutation-from-action call mirrors `scheduler:_enqueue`/`scheduler:_cancel` exactly. The raw code is generated INSIDE `_issueCode` via `node:crypto` (identical precedent to A1's `mintSession` generating the raw session token via `generateToken()` inside a mutation and returning it) — resolving the determinism question below. The four redeem functions are mutations that consume-before-validate (delete the row in the same transaction that validates it) and mint through `mintSession`.

**Tech Stack:** TypeScript, Bun (runtime/pkg-manager), Turborepo, vitest under Node, `@stackbase/values`/`@stackbase/executor`/`@stackbase/component`/`@stackbase/runtime-embedded` engine seams, `@stackbase/errors` typed errors, `node:crypto` for hashing + secret generation, `hash-wasm` argon2id (unchanged from A1), native `fetch` for the Resend adapter (zero deps). Component tests follow the SHIPPED A1 auth idiom (`composeComponents` + `EmbeddedRuntime.create` + `r.run(...)`, injecting a capture provider via `defineAuth({ email: {...} })`), not `createTestStackbase`. The E2E drives a REAL `@stackbase/client` over a REAL WebSocket against a REAL `stackbase dev` server.

## Global Constraints

Binding values copied verbatim from the design spec (`docs/superpowers/specs/2026-03-12-auth-email-flows-design.md`). Do not relitigate these while implementing:

- **Hashed at rest.** Every emailed secret is SHA-256/base64url hashed (`sha256base64url`, the A1 helper) before commit. `authCodes.codeHash` stores the hash; the raw code exists ONLY in the email and is never persisted or logged. Redeem re-hashes the presented code and compares (constant-time via the index-equality lookup on `codeHash`, plus the cross-account email guard). No raw code in any row or log line.
- **One active code per `(email, flow)`** — `_issueCode` overwrites the previous `(email, flow)` row (via the `byEmailFlow` index) so only the last-issued code is ever valid; a lost email is self-healing.
- **Atomic consume-before-validate.** The redeem mutation deletes/consumes the code row as part of the same transaction that validates it — under single-writer OCC, concurrent redeems of the same code produce exactly one winner. (The winner is the transaction whose delete commits; the loser's read-set conflict re-runs and finds no row → generic invalid.)
- **The send seam straddles mutation/action (decision 4).** `request*` are ACTIONS: (a) `ctx.runMutation("auth:_issueCode", { email, flow })` writes the hashed code + throttle counters and COMMITS, returning `{ send, code?, email }`; (b) if `send`, build the templated message and `await provider.send(...)`; (c) ALWAYS `return { sent: true }`. A code is durably committed before any send is attempted; a failed send throws to the caller and a re-request overwrites. No scheduler dependency.
- **Redeems are mutations minting via `mintSession`.** Reactive revocation and the A1 session model apply unchanged; every successful redeem returns a `MintResult`-shaped value.
- **Where the raw code is generated (RESOLVED — see "Resolved ambiguities").** Generated INSIDE `_issueCode` (the mutation) via `node:crypto`, returned to the action — mirroring how A1's `mintSession` generates the raw session token via `generateToken()` (`randomBytes`) inside a mutation and returns it. The "no `Date.now()`/`Math.random()` in mutations" rule targets `Math.random()` and wall-clock `Date.now()` (use `ctx.now()` for all TTL/cooldown timestamps); `node:crypto` CSPRNG secret generation inside a mutation is A1-established and correct (a re-run on OCC conflict simply mints a fresh unsent secret). ACTIONS may use native `crypto`/`fetch`, but the code is NOT generated action-side — `_issueCode` owns generation so the hash-and-store and the returned raw value can never diverge.
- **Code shapes (decision 13).** OTP = **8 numeric digits** (`crypto.randomInt`, zero-padded; 10^8 space against a 5-attempt budget). magic-link / reset / verify = **32-char base64url** high-entropy tokens (`randomBytes(24).toString("base64url")` → exactly 32 chars, URL-embeddable).
- **TTL defaults:** `otpTtlMs = 10*60*1000` (10min), `magicLinkTtlMs = 60*60*1000` (1h), `resetTtlMs = 60*60*1000` (1h), `verifyTtlMs = 24*60*60*1000` (24h). All overridable in the `email` config block.
- **Per-code attempt counter:** `otpAttempts` (default **5**). A wrong OTP guess increments `authCodes.attempts` via **commit-then-throw** (so the count survives the failed call, same mechanism as A1's lockout); at `otpAttempts` reached the row is DELETED (re-request required). Applies to the OTP flow's guessing defense.
- **Per-`(email, flow)` request cooldown:** `requestCooldownMs` (default **60_000**). `_issueCode` rejects a re-request inside the window since the existing row's `createdAt` with typed `EMAIL_COOLDOWN`.
- **Deployment-global send throttle:** `emailSendsPerMinute` (default **100**, `0` disables). A second named `authCounters` row `"emailSends"` (same single-row windowed pattern as A1's `"anonymousSignIns"`), 60_000ms window, typed `EMAIL_THROTTLED` at the cap. Protects the provider bill and caps enumeration probing.
- **Anti-enumeration (decision 7).** Every `request*` action returns `{ sent: true }` whether or not the account exists. For reset/verify on an unknown email, NO email is sent and NO code row is written (`_issueCode` returns `{ send: false }`), but the response is identical. At redeem, error codes NEVER distinguish "no such account" from "wrong code": both (and expired, and consumed) are the generic `"invalid code"` error.
- **Password reset is a credential boundary (decision 8).** `resetPassword` revokes ALL of the user's sessions (delete over the `byUserId` range) and mints a fresh one in the same transaction. Cross-account guard applies (decision 9).
- **Cross-account guard (decision 9).** A code row records the `email` it was issued for; every redeem asserts the presented (normalized) email matches the row — a reset code can never act on a different account. Adopted from convex-auth `Password.ts:196`.
- **Unverified-account adoption clears the password (decision 10).** When magic-link/OTP sign-in adopts a pre-existing PASSWORD account whose `users.emailVerified` was never true, the password credential (the `accounts` row) is DELETED — otherwise a pre-registrant keeps a backdoor into the account the mailbox owner now legitimately controls. Adopted from better-auth `magic-link.test.ts:268`.
- **verifyEmail ALWAYS mints (decision 12).** Successful `verifyEmail` sets `users.emailVerified: true` and mints a session (mint-shaped result) — proof of mailbox control is sign-in-grade proof, identical to the magic-link posture, with no path-dependence on how the caller arrived.
- **Successful magic-link/OTP sign-in AND successful verifyEmail set `users.emailVerified: true`** (decision 12).
- **`requireEmailVerification` (default FALSE).** When true AND email configured, password `signUp`/`signIn` of an unverified account returns `{ needsVerification: true }` (NO tokens, no I/O in the mutation) and the CLIENT drives the resend by calling the `requestEmailVerification` action. Default false leaves A1 `signUp`/`signIn` behavior byte-identical. Anonymous upgrade (A1) composes: an anonymous user upgrading via `signUp` under the gate gets `needsVerification` and keeps working anonymously until verified.
- **`createUsersOnEmailSignIn` (default TRUE).** magic-link/OTP sign-in creates the user on first use (with `emailVerified: true`). When false, an unknown email follows the anti-enumeration rule (request succeeds `{ sent: true }`, redeem fails generically — `_issueCode` writes no row for an unknown email under this flag).
- **Adapters shipped: console + Resend (decision 14).** `consoleEmail()` is the zero-config dev default (logs the full email incl. code/link to the server console). `resendEmail({ apiKey, baseUrl? })` is the production adapter — ONE `fetch` to the Resend API, ZERO dependencies, throws on non-2xx. Anything else is a custom `{ send }` object. SMTP is a documented nodemailer recipe, not a built-in.
- **`EMAIL_NOT_CONFIGURED`** — defensive typed error if an A2 function is somehow invoked when `email` config is absent (normally the functions are simply unregistered, so this is belt-and-suspenders).
- **Email config absent → A2 functions NOT registered.** The component surface stays EXACTLY A1's (test this explicitly).
- **Additive schema only.** New table `authCodes`; `users` gains `emailVerified: v.optional(v.boolean())`; `authCounters` gains a second named row (data, not schema). All pass the additive deploy gate (`packages/cli/src/schema-diff.ts` — new table accepted, new optional field accepted).
- **No `Date.now()`/`Math.random()` in mutations** — use `ctx.now()` for TTL/cooldown/window timestamps. `node:crypto` secret generation inside `_issueCode` is the A1-established exception (see the determinism constraint above). Actions may use native `crypto`/`fetch`.
- **Error codes are code-as-message (A1 convention):** `UserError` subclasses whose `.code === .message`; `commitThenThrow(codeString)` for the commit-then-throw path (carries no `.code`, so the code rides as the message). Redeem failures throw a generic `"invalid code"` (a plain `Error`; NEVER a typed code that could distinguish failure modes).
- **E2E through the real server.** `packages/cli/test/auth-email-e2e.test.ts` drives a REAL `@stackbase/client` over a REAL WebSocket against a REAL `stackbase dev` server (`loadProject` + `createEmbeddedRuntime` + `startDevServer`), per the e2e-through-shipped-entrypoint rule — using an in-memory capture provider (test-only) to record sends.
- **Reference code is Apache-2.0 (`.reference/convex-auth`) / MIT (`.reference/better-auth`) — adapt with attribution comments, NEVER copy FSL code.** Cite the adapted case in the test name/comment.
- **Build ordering / dist resolution.** Tests resolve deps via each package's built `dist/`. **After editing a dependency package, run `bun run build` (or `bun run --filter <pkg> build`) before running a dependent's tests** — editing a dep's `src` is a no-op for a dependent until rebuilt. `git checkout` won't revert git-ignored `dist/`.

Verification commands (package names confirmed: `@stackbase/auth`, `@stackbase/client`, `@stackbase/cli`):

```bash
bun run build                              # all packages, topological
bun run typecheck                          # all packages
bun run test                               # full vitest suite under Bun/Node
bun run --filter @stackbase/auth build
bun run --filter @stackbase/auth test
bun run --filter @stackbase/cli test       # includes auth-email-e2e
```

---

## Task 1 — EmailProvider seam + config

The `EmailProvider` type, the two shipped adapters (`consoleEmail`, `resendEmail`), the `EmailTemplates` defaults + override merge, the `email` config block extending A1's `AuthConfig`, the `EMAIL_NOT_CONFIGURED` defensive error, and conditional module registration (email absent ⇒ surface unchanged). Provider unit tests.

### Files
- **Create** `components/auth/src/email/provider.ts` — `EmailProvider`, `EmailMessage`, `consoleEmail`, `resendEmail`.
- **Create** `components/auth/src/email/templates.ts` — `EmailTemplates`, `TemplateArgs`, `defaultTemplates`, `resolveTemplates`.
- **Modify** `components/auth/src/config.ts` — add `EmailConfig`/`EmailOptions`, extend `AuthConfig`/`AuthOptions`/`DEFAULTS`/`resolveAuthConfig`.
- **Modify** `components/auth/src/errors.ts` — add `EmailCooldownError`, `EmailThrottledError`, `EmailNotConfiguredError`.
- **Modify** `components/auth/src/index.ts` — export the provider/template/config surface.
- **Modify** `components/auth/src/functions.ts` — `makeAuthModules` conditional A2 registration stub (real A2 modules land in Tasks 2–4; here only the `if (config.email)` seam + the "surface unchanged" guarantee).
- **Create** `components/auth/test/email-provider.test.ts`.

### Interfaces

`components/auth/src/email/provider.ts`:

```ts
/** The whole send seam — a plain async `send`. No Auth.js provider-object shape (decision: rejected). */
export interface EmailMessage { to: string; from: string; subject: string; text: string; html?: string }
export interface EmailProvider { send(msg: EmailMessage): Promise<void> }

/** Zero-config dev default (decision 14): logs the full email (incl. code/link) to the server console. */
export function consoleEmail(): EmailProvider {
  return {
    async send(msg) {
      // Intentionally logs the raw code/link — dev-only convenience, documented as such.
      console.log(
        `\n[stackbase auth] email →\n  to:      ${msg.to}\n  from:    ${msg.from}\n  subject: ${msg.subject}\n  ${msg.text.replace(/\n/g, "\n  ")}\n`,
      );
    },
  };
}

/** Production adapter (decision 14): ONE fetch to the Resend API, zero deps, throws on non-2xx. */
export function resendEmail(opts: { apiKey: string; baseUrl?: string }): EmailProvider {
  const base = opts.baseUrl ?? "https://api.resend.com";
  return {
    async send(msg) {
      const res = await fetch(`${base}/emails`, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          from: msg.from, to: msg.to, subject: msg.subject, text: msg.text,
          ...(msg.html ? { html: msg.html } : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`resend send failed (${res.status}): ${body}`);
      }
    },
  };
}
```

`components/auth/src/email/templates.ts`:

```ts
export type Flow = "verify" | "reset" | "magic" | "otp";
export interface TemplateArgs { appName: string; email: string; code?: string; url?: string; ttlMs: number }
export interface RenderedEmail { subject: string; text: string; html?: string }
export type TemplateFn = (a: TemplateArgs) => RenderedEmail;
export type EmailTemplates = Record<Flow, TemplateFn>;

const minutes = (ms: number) => Math.round(ms / 60000);
export const defaultTemplates: EmailTemplates = {
  verify: (a) => ({ subject: `Verify your ${a.appName} email`,
    text: `Confirm your email for ${a.appName}:\n\n${a.url}\n\nThis link expires in ${minutes(a.ttlMs)} minutes.` }),
  reset: (a) => ({ subject: `Reset your ${a.appName} password`,
    text: `Reset your ${a.appName} password:\n\n${a.url}\n\nThis link expires in ${minutes(a.ttlMs)} minutes. If you didn't request this, ignore this email.` }),
  magic: (a) => ({ subject: `Sign in to ${a.appName}`,
    text: `Sign in to ${a.appName}:\n\n${a.url}\n\nThis link expires in ${minutes(a.ttlMs)} minutes.` }),
  otp: (a) => ({ subject: `Your ${a.appName} sign-in code`,
    text: `Your ${a.appName} sign-in code is:\n\n${a.code}\n\nIt expires in ${minutes(a.ttlMs)} minutes.` }),
};

export function resolveTemplates(overrides?: Partial<EmailTemplates>): EmailTemplates {
  return { ...defaultTemplates, ...(overrides ?? {}) };
}
```

`components/auth/src/config.ts` — **old code** (verbatim current):

```ts
export interface AuthConfig {
  /** Access-token lifetime (default 1h). Bounds how long a stolen access token is usable. */
  accessTtlMs: number;
  /** Refresh-token lifetime, sliding on each rotation (default 30d). */
  refreshTtlMs: number;
  /** Grace window: a previous-hash replay within this of `lastRefreshAt` is a soft `REFRESH_STALE`,
   *  not a theft signal (default 30s). */
  refreshGraceMs: number;
  /** Absolute session ceiling, fixed at mint, never slides (default 90d). */
  sessionTotalTtlMs: number;
  /** Deployment-global cap on anonymous user creation per minute; `0` disables anonymous throttling
   *  (default 60). */
  anonymousSignInsPerMinute: number;
}

export type AuthOptions = Partial<AuthConfig>;

const DEFAULTS: AuthConfig = {
  accessTtlMs: 60 * 60 * 1000,
  refreshTtlMs: 30 * 24 * 60 * 60 * 1000,
  refreshGraceMs: 30_000,
  sessionTotalTtlMs: 90 * 24 * 60 * 60 * 1000,
  anonymousSignInsPerMinute: 60,
};

export function resolveAuthConfig(opts?: AuthOptions): AuthConfig {
  return { ...DEFAULTS, ...(opts ?? {}) };
}
```

`components/auth/src/config.ts` — **new code:**

```ts
import type { EmailProvider } from "./email/provider";
import { resolveTemplates, type EmailTemplates } from "./email/templates";

/** Resolved email config (all defaults applied). Present iff a project passed `email` with a provider. */
export interface EmailConfig {
  provider: EmailProvider;
  from: string;
  appName: string;
  baseUrl?: string;
  otpAttempts: number;
  otpTtlMs: number;
  magicLinkTtlMs: number;
  resetTtlMs: number;
  verifyTtlMs: number;
  requestCooldownMs: number;
  emailSendsPerMinute: number;
  requireEmailVerification: boolean;
  createUsersOnEmailSignIn: boolean;
  templates: EmailTemplates;
}

/** The user-facing `email` block: `provider` + `from` required, everything else optional-with-defaults. */
export interface EmailOptions {
  provider: EmailProvider;
  from: string;
  appName?: string;
  baseUrl?: string;
  otpAttempts?: number;
  otpTtlMs?: number;
  magicLinkTtlMs?: number;
  resetTtlMs?: number;
  verifyTtlMs?: number;
  requestCooldownMs?: number;
  emailSendsPerMinute?: number;
  requireEmailVerification?: boolean;
  createUsersOnEmailSignIn?: boolean;
  templates?: Partial<EmailTemplates>;
}

export interface AuthConfig {
  accessTtlMs: number;
  refreshTtlMs: number;
  refreshGraceMs: number;
  sessionTotalTtlMs: number;
  anonymousSignInsPerMinute: number;
  /** Present iff a project configured `email` (with a provider) — absent ⇒ A2 flows are unregistered. */
  email?: EmailConfig;
}

export type AuthOptions = Partial<Omit<AuthConfig, "email">> & { email?: EmailOptions };

const DEFAULTS: Omit<AuthConfig, "email"> = {
  accessTtlMs: 60 * 60 * 1000,
  refreshTtlMs: 30 * 24 * 60 * 60 * 1000,
  refreshGraceMs: 30_000,
  sessionTotalTtlMs: 90 * 24 * 60 * 60 * 1000,
  anonymousSignInsPerMinute: 60,
};

const EMAIL_DEFAULTS = {
  appName: "Stackbase app",
  otpAttempts: 5,
  otpTtlMs: 10 * 60 * 1000,
  magicLinkTtlMs: 60 * 60 * 1000,
  resetTtlMs: 60 * 60 * 1000,
  verifyTtlMs: 24 * 60 * 60 * 1000,
  requestCooldownMs: 60_000,
  emailSendsPerMinute: 100,
  requireEmailVerification: false,
  createUsersOnEmailSignIn: true,
};

function resolveEmailConfig(opts: EmailOptions): EmailConfig {
  return {
    ...EMAIL_DEFAULTS,
    ...opts,                                        // provider/from + any explicit overrides
    appName: opts.appName ?? EMAIL_DEFAULTS.appName,
    templates: resolveTemplates(opts.templates),    // merge partial overrides onto defaults
  };
}

export function resolveAuthConfig(opts?: AuthOptions): AuthConfig {
  const { email, ...rest } = opts ?? {};
  const base: AuthConfig = { ...DEFAULTS, ...rest };
  if (email) base.email = resolveEmailConfig(email);
  return base;
}
```

> Note the spread ordering in `resolveEmailConfig`: `...opts` includes optional keys as `undefined` when omitted, which would clobber `EMAIL_DEFAULTS`. Implement `resolveEmailConfig` field-by-field with `??` (as `resolveTemplates`/`appName` show) rather than a raw `...opts` spread — the snippet above shows the intent; the implementer must ensure an omitted `otpAttempts` resolves to `5`, not `undefined`. (A `compact`-style filter or explicit `opts.otpAttempts ?? EMAIL_DEFAULTS.otpAttempts` per field.)

`components/auth/src/errors.ts` — **append** (matching the existing `UserError` code-as-message style):

```ts
/** `request*` re-requested inside `requestCooldownMs` of the last issue for this (email, flow). */
export class EmailCooldownError extends UserError {
  override readonly code = "EMAIL_COOLDOWN";
  constructor() { super("EMAIL_COOLDOWN"); }
}
/** Deployment-global `emailSendsPerMinute` cap tripped (spec decision 6). */
export class EmailThrottledError extends UserError {
  override readonly code = "EMAIL_THROTTLED";
  constructor() { super("EMAIL_THROTTLED"); }
}
/** An A2 function invoked while `email` config is absent — defensive; normally unregistered. */
export class EmailNotConfiguredError extends UserError {
  override readonly code = "EMAIL_NOT_CONFIGURED";
  constructor() { super("EMAIL_NOT_CONFIGURED"); }
}
```

`components/auth/src/functions.ts` — **old code** (the factory tail, verbatim):

```ts
  return { signUp, signIn, signOut, getUserId, refresh, signInAnonymously, listSessions, revokeSession, revokeOtherSessions };
}
```

`components/auth/src/functions.ts` — **new code** (the conditional seam; the A2 modules themselves are built by helpers landed in Tasks 2–4):

```ts
  const base = { signUp, signIn, signOut, getUserId, refresh, signInAnonymously, listSessions, revokeSession, revokeOtherSessions };
  if (!config.email) return base;                       // email absent ⇒ surface stays EXACTLY A1's
  return { ...base, ...makeEmailModules(config) };       // Tasks 2–4 provide makeEmailModules
}
```

> In Task 1, `makeEmailModules` may be a stub returning `{}` (kept behind the `if` so the "surface unchanged" test passes now); Tasks 2–4 fill it. Alternatively, land `makeEmailModules` empty in Task 1 and grow it — implementer's choice, but the `if (!config.email) return base;` guard and the "surface unchanged" test are Task 1 deliverables.

### Tests (`email-provider.test.ts`)
- `resendEmail`: mock `globalThis.fetch`; assert the request URL (`https://api.resend.com/emails`), `authorization: Bearer <key>`, JSON body (`from`/`to`/`subject`/`text`, `html` only when provided). Attribution: better-auth email-verification route test shape.
- `resendEmail` non-2xx: mocked 422 response → `send` rejects with the status + body in the message.
- `resendEmail` custom `baseUrl`: honored.
- `consoleEmail`: spy `console.log`; assert the output contains `to`/`subject`/the code (dev convenience is deliberate).
- `resolveTemplates`: a partial override replaces only that flow; others keep defaults.
- **Surface-unchanged guarantee** (also assertable here or in Task 2): `makeAuthModules(resolveAuthConfig())` (no email) has EXACTLY the A1 keys (`signUp,signIn,signOut,getUserId,refresh,signInAnonymously,listSessions,revokeSession,revokeOtherSessions`) and none of `requestOtp`/`verifyEmail`/`_issueCode`/etc.

### Verification
```bash
bun run --filter @stackbase/auth build && bun run --filter @stackbase/auth test
```

---

## Task 2 — `authCodes` core: schema, `_issueCode`, and the `request*` actions

The `authCodes` table + `byEmailFlow` index, `users.emailVerified`, the internal `_issueCode` mutation (normalize, cooldown, global throttle, anti-enum policy, overwrite, hash-and-store, `attempts: 0`, generate-and-return raw code), and the four `request*` ACTIONS wiring `runMutation` → provider send → `{ sent: true }`.

### Files
- **Modify** `components/auth/src/schema.ts` — add `authCodes` + index, add `users.emailVerified`.
- **Create** `components/auth/src/email/codes.ts` — code generation (`generateOtp`, `generateLinkToken`), the shared `authCodes` helpers.
- **Modify** `components/auth/src/functions.ts` — `makeEmailModules(config)` with `_issueCode` + `requestEmailVerification`/`requestPasswordReset`/`requestMagicLink`/`requestOtp`.
- **Create** `components/auth/test/email-issue.test.ts`.

### Interfaces

`components/auth/src/schema.ts` — **old code** (the `users` line + the `authCounters` line, verbatim):

```ts
  users: defineTable({ email: v.optional(v.string()), anonymous: v.optional(v.boolean()) }).index("byEmail", ["email"]),
```
```ts
  authCounters: defineTable({ name: v.string(), windowStart: v.number(), count: v.number() }).index("byName", ["name"]),
```

`components/auth/src/schema.ts` — **new code** (`users` gains `emailVerified`; add `authCodes` after `authCounters`; `authCounters` itself unchanged — the `"emailSends"` row is data):

```ts
  users: defineTable({
    email: v.optional(v.string()),
    anonymous: v.optional(v.boolean()),
    emailVerified: v.optional(v.boolean()),    // A2: set true by magic/otp sign-in + verifyEmail
  }).index("byEmail", ["email"]),
```
```ts
  authCounters: defineTable({ name: v.string(), windowStart: v.number(), count: v.number() }).index("byName", ["name"]),
  // A2 (spec "Schema"): one active hashed code per (email, flow). `byEmailFlow` is the natural key —
  // `_issueCode` overwrites the prior row through it (decision 2), redeems consume-before-validate.
  authCodes: defineTable({
    email: v.string(),      // normalized; the identity the code was issued for (cross-account guard, decision 9)
    flow: v.string(),       // "verify" | "reset" | "magic" | "otp"
    codeHash: v.string(),   // SHA-256 base64url of the raw code — never the raw code
    expiresAt: v.number(),
    attempts: v.number(),   // wrong-guess counter (OTP defense; commit-then-throw increments)
    createdAt: v.number(),  // also drives the request cooldown
  }).index("byEmailFlow", ["email", "flow"]),
```

`components/auth/src/email/codes.ts`:

```ts
import { randomBytes, randomInt } from "node:crypto";
import type { Flow } from "./templates";

/** OTP = 8 numeric digits, zero-padded. `crypto.randomInt` is a CSPRNG (decision 13). */
export function generateOtp(): string {
  return randomInt(0, 100_000_000).toString().padStart(8, "0");
}
/** magic/reset/verify token = exactly 32 base64url chars (24 bytes → 32 chars, decision 13). */
export function generateLinkToken(): string {
  return randomBytes(24).toString("base64url");
}
/** OTP flow shows the code; token flows embed it in a URL. */
export function isTokenFlow(flow: Flow): boolean { return flow !== "otp"; }
```

`components/auth/src/functions.ts` — **new code** (`makeEmailModules`; imports `action` from `@stackbase/executor`, the code/template helpers, and the new errors). Key shapes:

```ts
type SendDecision = { send: boolean; code?: string; email: string };

function ttlFor(config: AuthConfig, flow: Flow): number {
  const e = config.email!;
  return flow === "otp" ? e.otpTtlMs : flow === "magic" ? e.magicLinkTtlMs : flow === "reset" ? e.resetTtlMs : e.verifyTtlMs;
}

// Whether a row is written at all for this (email, flow) given account existence + flags (decision 7/11).
async function shouldIssue(ctx: MutationCtx, config: AuthConfig, email: string, flow: Flow): Promise<boolean> {
  const [user] = await ctx.db.query("users", "byEmail").eq("email", email).collect();
  if (flow === "otp" || flow === "magic") {
    // Sign-in flows: issue for a known user always; for an unknown email only if createUsersOnEmailSignIn.
    return !!user || config.email!.createUsersOnEmailSignIn;
  }
  // verify/reset: only for an existing account (unknown email → silent no-send, decision 7).
  return !!user;
}

const _issueCode = mutation(async (ctx, { email, flow }: { email: string; flow: Flow }): Promise<SendDecision> => {
  if (!config.email) throw new EmailNotConfiguredError();
  const normEmail = normalizeEmail(email);
  const now = ctx.now();

  // Global send throttle FIRST (protects the bill + caps enumeration even for no-send emails). Same
  // single-windowed-row pattern as A1's anonymousSignIns (spec decision 6). `0` disables.
  if (config.email.emailSendsPerMinute > 0) {
    const [counter] = await ctx.db.query("authCounters", "byName").eq("name", "emailSends").collect();
    const windowMs = 60_000;
    if (!counter) {
      await ctx.db.insert("authCounters", { name: "emailSends", windowStart: now, count: 1 });
    } else if (now - (counter.windowStart as number) >= windowMs) {
      await ctx.db.replace(counter._id as string, { ...counter, windowStart: now, count: 1 });
    } else if ((counter.count as number) >= config.email.emailSendsPerMinute) {
      throw new EmailThrottledError();
    } else {
      await ctx.db.replace(counter._id as string, { ...counter, count: (counter.count as number) + 1 });
    }
  }

  // Anti-enumeration: decide whether to write/send at all, per flow + flags.
  if (!(await shouldIssue(ctx, config, normEmail, flow))) return { send: false, email: normEmail };

  // Per-(email, flow) cooldown against the existing row's createdAt (decision 6).
  const [existing] = await ctx.db.query("authCodes", "byEmailFlow").eq("email", normEmail).eq("flow", flow).collect();
  if (existing && now - (existing.createdAt as number) < config.email.requestCooldownMs) {
    throw new EmailCooldownError();
  }

  // Generate raw code INSIDE the mutation (A1 mintSession precedent), hash, overwrite prior row.
  const code = isTokenFlow(flow) ? generateLinkToken() : generateOtp();
  const row = { email: normEmail, flow, codeHash: sha256base64url(code), expiresAt: now + ttlFor(config, flow), attempts: 0, createdAt: now };
  if (existing) await ctx.db.replace(existing._id as string, { ...row });   // one active row (decision 2)
  else await ctx.db.insert("authCodes", row);

  return { send: true, code, email: normEmail };   // raw code returned to the action, never logged/stored
});

// One action factory per flow — each: runMutation _issueCode → (if send) build template + provider.send → { sent: true }.
function requestAction(flow: Flow) {
  return action(async (ctx: ActionCtx, { email }: { email: string }): Promise<{ sent: true }> => {
    if (!config.email) throw new EmailNotConfiguredError();
    const decision = await ctx.runMutation<SendDecision>("auth:_issueCode", { email, flow });
    if (decision.send && decision.code) {
      const e = config.email;
      const url = isTokenFlow(flow) && e.baseUrl
        ? `${e.baseUrl.replace(/\/$/, "")}/auth/${flow}?token=${decision.code}&email=${encodeURIComponent(decision.email)}`
        : undefined;
      const rendered = e.templates[flow]({ appName: e.appName, email: decision.email, code: isTokenFlow(flow) ? undefined : decision.code, url, ttlMs: ttlFor(config, flow) });
      await e.provider.send({ to: decision.email, from: e.from, ...rendered });
    }
    return { sent: true };   // ALWAYS — anti-enumeration (decision 7)
  });
}

return {
  _issueCode,
  requestEmailVerification: requestAction("verify"),
  requestPasswordReset: requestAction("reset"),
  requestMagicLink: requestAction("magic"),
  requestOtp: requestAction("otp"),
  // Task 3 adds the redeem mutations to this object.
};
```

> **Internal-mutation-from-action convention (found, verbatim from `scheduler`):** the action calls `ctx.runMutation("auth:_issueCode", { … })`. `_issueCode` is registered in the module map under key `_issueCode` → path `auth:_issueCode`; the `_` prefix makes it non-client-callable but reachable from an action's `runMutation`, exactly as `components/scheduler/src/facade.ts:307` calls `api.runMutation("scheduler:_enqueue", …)` and `modules.ts` registers `_enqueue`. The action's `ctx.runMutation` routes through `InlineUdfExecutor.runActionFn`'s `run("mutation")` → `invoke(path, …)` (executor.ts:702), which permits `_` paths (public `runtime.run` blocks them; the action path does not — executor.ts:82).

### Tests (`email-issue.test.ts`, capture provider injected via `defineAuth({ email: { provider: capture, from } })`)

Capture provider: `const sent: EmailMessage[] = []; const capture = { async send(m){ sent.push(m); } };` The test extracts the raw code from `sent[i].text` (that is exactly what a real user would do from the email).

- **hashed-at-rest:** after `requestOtp`, privileged-read the `authCodes` row (via a `_admin`/direct store read or a test-only query) → `codeHash` is set, no field equals the raw code from the email.
- **overwrite / only-last-valid:** two `requestOtp` calls (advance clock past cooldown) → exactly ONE `authCodes` row for `(email, otp)`; the first code no longer verifies (Task 3 redeem), the second does.
- **cooldown:** immediate re-request → rejects `/EMAIL_COOLDOWN/`; after `requestCooldownMs` a new code issues.
- **global throttle:** set `emailSendsPerMinute: 2`; 3rd request within the window → `/EMAIL_THROTTLED/`; advance 60s → recovers. Attribution: convex-auth `rateLimit.test.ts`.
- **anti-enum zero-send (verify/reset):** `requestPasswordReset("unknown@x.co")` → returns `{ sent: true }`, `sent.length === 0`, no `authCodes` row written.
- **anti-enum + createUsersOnEmailSignIn:false (magic/otp):** unknown email → `{ sent: true }`, no row, no send.
- **createUsersOnEmailSignIn:true (default):** unknown email `requestMagicLink` → a row IS written and a send captured (user created at redeem, Task 3).

### Verification
```bash
bun run --filter @stackbase/auth build && bun run --filter @stackbase/auth test
```

---

## Task 3 — Redeem mutations

The shared consume-before-validate helper, then `verifyEmail`, `signInWithOtp`, `signInWithMagicLink`, `resetPassword`.

### Files
- **Modify** `components/auth/src/functions.ts` — add the four redeem mutations to `makeEmailModules`'s return, plus a `consumeCode` helper.
- **Create** `components/auth/test/email-redeem.test.ts`.

### Interfaces

```ts
/** Consume-before-validate (decision 3) + cross-account guard (decision 9) + expiry.
 *  Returns the raw-code MATCH outcome; on a NON-OTP mismatch/expiry/absence the row is deleted and
 *  we throw generic invalid. For OTP, the caller handles the attempt counter (commit-then-throw)
 *  BEFORE deleting, so we split: `peekCode` reads + guards; the redeem fn decides delete vs. count. */

// Shared read+guard (no delete yet — the redeem decides consume vs. count):
async function peekCode(ctx: MutationCtx, email: string, flow: Flow, presented: string) {
  const normEmail = normalizeEmail(email);
  const [row] = await ctx.db.query("authCodes", "byEmailFlow").eq("email", normEmail).eq("flow", flow).collect();
  const matches = !!row
    && (row.email as string) === normEmail                       // cross-account guard (belt: key already scopes)
    && ctx.now() <= (row.expiresAt as number)
    && (row.codeHash as string) === sha256base64url(presented);  // index-equality-grade constant-time
  return { row: (row as Record<string, unknown> | undefined) ?? null, normEmail, matches };
}
const INVALID = "invalid code";   // generic, used for wrong/expired/consumed/no-such-account alike (decision 7)
```

**`verifyEmail(email, code, deviceLabel?)`** — always mints (decision 12):
```ts
const verifyEmail = mutation(async (ctx, { email, code, deviceLabel }: { email: string; code: string; deviceLabel?: string }) => {
  if (!config.email) throw new EmailNotConfiguredError();
  const { row, normEmail, matches } = await peekCode(ctx, email, "verify", code);
  if (!matches) { if (row) await ctx.db.delete(row._id as string); throw new Error(INVALID); }  // expired/wrong → consume + generic
  await ctx.db.delete(row!._id as string);                                                      // consume-before-validate winner
  const [user] = await ctx.db.query("users", "byEmail").eq("email", normEmail).collect();
  if (!user) throw new Error(INVALID);                                                           // verify targets an existing account
  await ctx.db.replace(user._id as string, { ...user, emailVerified: true });
  return mintSession(ctx, config, user._id as string, deviceLabel);
});
```

**`resetPassword(email, code, newPassword)`** — credential boundary (decisions 8/9):
```ts
const resetPassword = mutation(async (ctx, { email, code, newPassword }: { email: string; code: string; newPassword: string }) => {
  if (!config.email) throw new EmailNotConfiguredError();
  const { row, normEmail, matches } = await peekCode(ctx, email, "reset", code);
  if (!matches) { if (row) await ctx.db.delete(row._id as string); throw new Error(INVALID); }
  await ctx.db.delete(row!._id as string);
  const [account] = await ctx.db.query("accounts", "byAccount").eq("provider", "password").eq("accountId", normEmail).collect();
  if (!account) throw new Error(INVALID);
  await ctx.db.replace(account._id as string, { ...account, secret: await hashSecret(newPassword), failedAttempts: 0, lockedUntil: 0 });
  const userId = account.userId as string;
  const [user] = [await ctx.db.get(userId)];
  if (user) await ctx.db.replace(userId, { ...user, emailVerified: true });   // a reset proves mailbox control too
  // Revoke ALL sessions (byUserId range, credential boundary — decision 8), then mint fresh.
  for (const s of await ctx.db.query("sessions", "byUserId").eq("userId", userId).collect()) await ctx.db.delete(s._id as string);
  return mintSession(ctx, config, userId);
});
```
> Setting `emailVerified: true` on reset is consistent with decision 12's "proof of mailbox control is proof of mailbox control" and harmless (reset already requires the mailbox). If a reviewer prefers to leave `emailVerified` untouched on reset, that is acceptable — the spec only mandates it for magic/otp/verify. **Flag for adjudication** (listed below).

**`signInWithMagicLink(email, token, deviceLabel?)`** — create-per-flag, adopt-clears-password (decisions 10/11/12):
```ts
const signInWithMagicLink = mutation(async (ctx, { email, token, deviceLabel }: { email: string; token: string; deviceLabel?: string }) => {
  if (!config.email) throw new EmailNotConfiguredError();
  const { row, normEmail, matches } = await peekCode(ctx, email, "magic", token);
  if (!matches) { if (row) await ctx.db.delete(row._id as string); throw new Error(INVALID); }
  await ctx.db.delete(row!._id as string);
  return adoptOrCreateThenMint(ctx, config, normEmail, deviceLabel);   // shared with OTP
});
```

Shared `adoptOrCreateThenMint`:
```ts
async function adoptOrCreateThenMint(ctx: MutationCtx, config: AuthConfig, normEmail: string, deviceLabel?: string): Promise<MintResult> {
  let [user] = await ctx.db.query("users", "byEmail").eq("email", normEmail).collect();
  if (!user) {
    if (!config.email!.createUsersOnEmailSignIn) throw new Error(INVALID);   // unknown email, creation off → generic (decision 11)
    const id = (await ctx.db.insert("users", { email: normEmail, emailVerified: true })) as string;
    return mintSession(ctx, config, id, deviceLabel);
  }
  // Adopt an existing account. If it had a PASSWORD credential and was NEVER verified, delete that
  // credential (decision 10 — a pre-registrant's backdoor). Attribution: better-auth magic-link.test.ts:268.
  if (user.emailVerified !== true) {
    for (const a of await ctx.db.query("accounts", "byAccount").eq("provider", "password").eq("accountId", normEmail).collect()) {
      await ctx.db.delete(a._id as string);
    }
  }
  await ctx.db.replace(user._id as string, { ...user, emailVerified: true });
  return mintSession(ctx, config, user._id as string, deviceLabel);
}
```

**`signInWithOtp(email, code, deviceLabel?)`** — magic-link semantics + attempt counter (decision 6, commit-then-throw):
```ts
const signInWithOtp = mutation(async (ctx, { email, code, deviceLabel }: { email: string; code: string; deviceLabel?: string }) => {
  if (!config.email) throw new EmailNotConfiguredError();
  const { row, normEmail, matches } = await peekCode(ctx, email, "otp", code);
  if (!row) throw new Error(INVALID);                        // no row at all → generic (no counter to bump)
  if (!matches) {
    // Wrong (or expired) guess: bump attempts; at the cap DELETE the row (lockout). commit-then-throw
    // so the increment/delete COMMITS despite the throw (same mechanism as A1's lockout).
    const attempts = (row.attempts as number) + 1;
    if (attempts >= config.email.otpAttempts) await ctx.db.delete(row._id as string);
    else await ctx.db.replace(row._id as string, { ...row, attempts });
    return commitThenThrow(INVALID);
  }
  await ctx.db.delete(row._id as string);                   // consume-before-validate winner
  return adoptOrCreateThenMint(ctx, config, normEmail, deviceLabel);
});
```
> OTP's expiry: an expired-but-present row that the user guesses correctly still goes through the `!matches` branch (because `peekCode` checks expiry), so it bumps the counter and throws generic invalid — expired = generic invalid, row cleaned up on cap or on a subsequent correct-shape guess. Acceptable; a wrong guess against an expired row is indistinguishable from a live one (anti-enum-consistent).

### Tests (`email-redeem.test.ts`)
- **verify mints + sets emailVerified:** request→redeem returns a token; the user row's `emailVerified === true`.
- **single-use / replay:** a consumed code fails on a second redeem (generic invalid).
- **concurrent redeem → one winner:** fire two `signInWithMagicLink` with the same token concurrently (`Promise.allSettled`) → exactly one fulfilled, one rejected `/invalid code/`. (Under single-writer OCC one delete wins.)
- **expiry:** advance clock past the TTL → redeem = generic `/invalid code/`; row cleaned up.
- **OTP brute force:** `otpAttempts` wrong guesses → the row is deleted; the (previously correct) code then also fails; assert the `attempts` counter survived the failed calls (commit-then-throw durability — privileged-read the row between guesses). Attribution: better-auth email-otp.test.ts (theirs 3; ours 5).
- **OTP matching-email requirement / cross-account:** a code issued for A cannot redeem as B (`peekCode`'s key + guard) → generic invalid. Attribution: convex-auth otp.test.ts:25.
- **reset:** old password dead (A1 `signIn` rejects), new password works, ALL other sessions revoked (open a second session first, assert it's gone via `getUserId`), a fresh session minted; cross-account guard (reset code for A cannot reset B). Attribution: convex-auth passwords.test.ts (reset section) + Password.ts:196.
- **magic/otp create-on-first-use:** unknown email (default flags) → user created, `emailVerified: true`; with `createUsersOnEmailSignIn: false` → generic invalid, no user created.
- **unverified-adoption-clears-password:** password-signUp an unverified account, then magic-link sign-in the same email → the `accounts` password row is gone (A1 `signIn` now rejects with invalid credentials), the user is adopted (same userId). Attribution: better-auth magic-link.test.ts:268.

### Verification
```bash
bun run --filter @stackbase/auth build && bun run --filter @stackbase/auth test
```

---

## Task 4 — signUp/signIn verification gate

The `requireEmailVerification` branch on A1's `signUp`/`signIn` (returns `{ needsVerification: true }`, no tokens, no I/O), byte-identical default-false behavior, anonymous-upgrade composition.

### Files
- **Modify** `components/auth/src/functions.ts` — gate branches in `signUp`/`signIn`.
- **Create** `components/auth/test/email-verification-gate.test.ts`.

### Interfaces

The gate return type widens the mint result to a discriminated union — additive, existing callers unaffected when the flag is off:
```ts
export type NeedsVerification = { needsVerification: true };
export type SignInResult = MintResult | NeedsVerification | ReturnType<typeof commitThenThrow>;
```

`signUp` — **new code** (insert the gate right before the final `return mintSession(...)`; the mutation does NO I/O — the client drives the resend by calling `requestEmailVerification`):
```ts
    await ctx.db.insert("accounts", { userId, provider: "password", accountId: normEmail, secret: await hashSecret(password), failedAttempts: 0, lockedUntil: 0 });
    // Verification gate (decision 11): only when configured on AND the account isn't already verified.
    // No tokens, no send here — the CLIENT responds to needsVerification by calling requestEmailVerification.
    // Anonymous-upgrade composes: the upgrade above already ran (userId/rows preserved); the user keeps
    // working anonymously (their old anon session still lives) until verifyEmail mints.
    if (config.email?.requireEmailVerification) {
      const user = await ctx.db.get(userId);
      if (user?.emailVerified !== true) return { needsVerification: true } as NeedsVerification;
    }
    return mintSession(ctx, config, userId, deviceLabel);
```
> **Anonymous-upgrade + gate interaction (flag for adjudication):** A1's `signUp` upgrade path deletes ALL the anon user's sessions BEFORE minting. Under the gate we return `needsVerification` without minting — but the sessions were already deleted, so the user would be signed OUT, contradicting "keeps working anonymously until verified" (spec §"signUp/signIn integration"). **Resolution:** when `requireEmailVerification` is on AND we're on the anon-upgrade branch, do NOT delete the anon sessions until verification completes (or defer the whole credential-boundary revocation to `verifyEmail`). The cleanest implementation: in the gate branch, skip the session-wipe for the anon-upgrade case (the anon session must survive) and let `verifyEmail`'s `mintSession` be the point the credential boundary is enforced. Implementer should special-case this; see the test below. This is the one genuinely subtle interaction in the slice.

`signIn` — **new code** (after successful password verification, before minting):
```ts
    // Success path (counters reset / legacy rehash already applied above)...
    if (config.email?.requireEmailVerification) {
      const user = await ctx.db.get(account.userId as string);
      if (user?.emailVerified !== true) return { needsVerification: true } as NeedsVerification;
    }
    return mintSession(ctx, config, account.userId as string, deviceLabel);
```

### Tests (`email-verification-gate.test.ts`)
- **gate off (default):** `signUp`/`signIn` return a full mint result (byte-identical A1) — no `needsVerification` key. Reuse the A1 assertions.
- **gate on, signUp:** unverified `signUp` → `{ needsVerification: true }`, NO token; then `requestEmailVerification` + `verifyEmail` → mints; a subsequent `signIn` (now `emailVerified`) → mints directly. Attribution: convex-auth passwords.test.ts:68-113.
- **gate on, signIn of unverified existing account:** → `needsVerification`, no token.
- **anon-upgrade under the gate:** anon sign-in → write a row → `signUp` (gate on) → `needsVerification`; the anon session STILL resolves (`getUserId` non-null) and the anon-written row still reads; after `verifyEmail` the session mints and the row survives under the same userId.

### Verification
```bash
bun run --filter @stackbase/auth build && bun run --filter @stackbase/auth test
```

---

## Task 5 — E2E through the real server + auth-demo

`packages/cli/test/auth-email-e2e.test.ts` (in-memory capture provider through the REAL dev server) + the auth-demo UI/flows.

### Files
- **Create** `packages/cli/test/auth-email-e2e.test.ts`.
- **Modify** `examples/auth-demo/stackbase.config.ts` — pass `email: { provider: consoleEmail(), from, appName, baseUrl }` to `defineAuth`/`auth` (switch `auth` → `defineAuth({ email: {...} })`).
- **Modify** `examples/auth-demo/web/main.tsx` — forgot-password, magic-link/OTP sign-in, verify banner (drives `needsVerification`).
- **Modify** `examples/auth-demo/test/flow.test.ts` — add the email flows (capture provider) if the demo's test wiring allows a provider injection; else add a sibling test.
- Regenerate `examples/auth-demo/convex/_generated/*` if the demo's own functions change (they don't — the flows live in the component).

### E2E shape (mirror `auth-session-e2e.test.ts` exactly — `loadProject` + `createEmbeddedRuntime` + `startDevServer` + real `StackbaseClient`/`webSocketTransport`):

- A test-only in-memory capture provider composed via `defineAuth({ email: { provider: capture, from: "no-reply@test", baseUrl: "https://app.test", appName: "Demo" } })`; `capture.sent` is an array the test reads the code/link out of.
- **magic-link round trip:** `client.action(api.auth.requestMagicLink, { email })` → read the token from `capture.sent.at(-1).text` → `client.mutation(api.auth.signInWithMagicLink, { email, token })` → `setAuth(token)` → a live `whoami.get` subscription (opened before) sees the new userId.
- **reset revocation fans out:** sign up + open a `whoami.get` subscription on connection A (authed); on connection B (or via the action) `requestPasswordReset` + `resetPassword` → connection A's subscription flips to `null` (all sessions revoked → the old token's session row is deleted → reactive). Mirror A1 E2E test (1)'s reactive-revoke waitFor idiom.
- **console-provider smoke:** compose `consoleEmail()`, spy `console.log`, run `requestOtp` → the server logs and the action returns `{ sent: true }` (the zero-config path works end to end).

### auth-demo UI
- A "Forgot password?" form → `requestPasswordReset` → a reset-code field → `resetPassword` → `setSession`.
- Magic-link + OTP sign-in tabs → `requestMagicLink`/`requestOtp` → paste-code field → `signInWithMagicLink`/`signInWithOtp` → `setSession`.
- A verify banner shown when a sign-in returns `{ needsVerification: true }`: a "Resend verification" button calling `requestEmailVerification`, and a code field calling `verifyEmail`.
- Console provider is fine for the demo (codes print to the `stackbase dev` console); document that at the top of the demo.

### Verification
```bash
bun run build && bun run --filter @stackbase/cli test         # includes auth-email-e2e
bun run --filter auth-demo test
```

---

## Task 6 — Docs + README re-baseline

### Files
- **Modify** `docs/enduser/build/auth.md` — new "Email flows" section.
- **Modify** `components/auth/README.md` — limitations re-baselined (email flows shipped; A3 roadmap → OAuth/JWKS only).

### Content (`docs/enduser/build/auth.md`)
- **Setup:** the `email` block on `defineAuth`; `consoleEmail()` as the zero-config default (codes print to the server console); `resendEmail({ apiKey, from })` for production; the SMTP recipe as a ~15-line custom `{ send }` using `nodemailer` (documented, not a built-in — decision 14).
- **Each flow's client-side usage** (native `@stackbase/*` imports, NOT `convex/*`): verify (`needsVerification` → `requestEmailVerification` → `verifyEmail`), password reset (`requestPasswordReset` → `resetPassword`), magic-link (`requestMagicLink` → `signInWithMagicLink`), OTP (`requestOtp` → `signInWithOtp`). Each redeem returns a mint result the app hands to `createAuthClient.setSession()`.
- **Policy flags:** `requireEmailVerification` (default false), `createUsersOnEmailSignIn` (default true) — what each does, when to flip it.
- **Abuse-defense table:** attempt counter (`otpAttempts` 5), cooldown (`requestCooldownMs` 60s → `EMAIL_COOLDOWN`), global throttle (`emailSendsPerMinute` 100, 0 disables → `EMAIL_THROTTLED`), anti-enumeration (`{ sent: true }` always; generic invalid at redeem). Note the deliberate absence of per-IP limits (no transport identifiers by design).
- **Code shapes / TTLs table:** OTP 8 digits / 10min; magic 32-char / 1h; reset 32-char / 1h; verify 32-char / 24h.

### README re-baseline
- Move "email verification / password reset / magic-link / OTP" from limitations to shipped; A3 note becomes "OAuth + JWKS/OIDC (external identity)" only.

### Verification
```bash
bun run build && bun run typecheck && bun run test
```

---

## Resolved ambiguities (for controller adjudication)

1. **Where the raw code is generated (the headline determinism question) — RESOLVED: inside `_issueCode` (the mutation), returned to the action.** A1's `mintSession` (`components/auth/src/functions.ts:44-69`) already generates the raw session token via `generateToken()` (`randomBytes(32)`, `node:crypto`) INSIDE a mutation and returns the raw value to its caller — the exact precedent. The "no `Math.random()`/`Date.now()` in mutations" rule targets `Math.random()` and wall-clock ordering (`ctx.now()` is the deterministic clock, used for all TTL/cooldown/window math); a `node:crypto` CSPRNG minting a one-shot unsent secret inside a mutation is A1-established and correct (an OCC re-run just mints a fresh unsent secret). Generating action-side and passing IN was REJECTED: it would split ownership of "the value emailed" from "the hash stored", inviting divergence, and the spec itself says "_issueCode … returns the raw code + send-decision to the action." So `_issueCode` owns generation, hashing, storage, AND the returned raw code.

2. **Internal-mutation-from-action calling convention — FOUND: `ctx.runMutation("auth:_issueCode", args)`, `_`-prefixed module, verbatim mirror of `scheduler`.** `components/scheduler/src/facade.ts:307` calls `api.runMutation("scheduler:_enqueue", …)`; `components/scheduler/src/modules.ts` registers `_enqueue` as a normal `mutation` in the module map under key `_enqueue` → path `scheduler:_enqueue`. The `_` prefix makes it non-client-callable (public `runtime.run` blocks `_`; executor.ts:82) but reachable from an action's `runMutation` (which routes through `InlineUdfExecutor.runActionFn`'s `run("mutation")` → `invoke(path,…)`, executor.ts:702-703, permitting `_`). Auth's `request*` actions therefore call `ctx.runMutation("auth:_issueCode", { email, flow })` with `_issueCode` registered in `makeEmailModules`'s returned map. NOTE: unlike scheduler (which uses the `buildAction` ContextProvider seam for a facade method), auth's `request*` are ordinary `action()` functions in the module set — no `buildAction`/ContextProvider needed; they use the plain `ctx.runMutation` on the action ctx directly.

3. **Component test harness — using the SHIPPED A1 idiom (`composeComponents` + `EmbeddedRuntime.create` + `r.run`), NOT `createTestStackbase`.** The spec's Testing section says "`@stackbase/test`," but every shipped A1 auth component test (`lockout.test.ts`, `sign-up-in.test.ts`, etc.) uses `composeComponents([auth]) → EmbeddedRuntime.create → r.run("auth:…")`. A2 needs to inject a capture provider, which is trivial with `defineAuth({ email: { provider: capture, from } })` composed the same way. Following the proven, consistent idiom; noted so the controller can redirect to `createTestStackbase` if desired (no behavioral difference).

4. **`emailVerified` on password reset — set to `true` (minor divergence, flagged).** Spec decision 12 mandates `emailVerified: true` for magic/otp/verify but is silent on reset. This plan sets it true on `resetPassword` too (a reset proves mailbox control identically). Harmless and consistent; a reviewer may prefer to leave it untouched — either is spec-compliant. Flagged for a one-line ruling.

5. **Anonymous-upgrade + verification-gate session survival (the one subtle interaction).** A1's `signUp` upgrade path deletes all anon sessions before minting. Under `requireEmailVerification`, the gate returns `needsVerification` without minting — so the pre-existing anon-session deletion would sign the user OUT, contradicting the spec's "keeps working anonymously until verified." Resolution baked into Task 4: skip the anon-session wipe on the gated anon-upgrade branch (the anon session must survive until `verifyEmail` mints and enforces the credential boundary). Called out explicitly with a dedicated test; flagged because it is the one place the plan adds behavior the spec only implies.
