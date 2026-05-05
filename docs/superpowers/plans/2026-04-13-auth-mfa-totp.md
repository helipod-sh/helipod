# Auth slice A4 — MFA / TOTP two-factor (implementation plan)

For agentic workers: use the `superpowers:subagent-driven-development` skill to execute this plan — each task below is an independently reviewable unit; dispatch one subagent per task, in order. Design spec: `docs/superpowers/specs/2026-04-13-auth-mfa-totp-design.md` (read it first; the numbered decisions are binding).

**Goal:** Add TOTP two-factor auth + one-time recovery codes to `@stackbase/auth`: two-phase enrollment, a second-factor gate that wraps (never bypasses) A1's `mintSession` chokepoint, AES-256-GCM-encrypted-at-rest TOTP secrets under a deployment keyring, and disable/regenerate re-auth — all opt-in via `defineAuth({ mfa })` and byte-identical when absent.

**Architecture:** Three new component tables (`mfaEnrollments`, `mfaChallenges`, `mfaRecoveryCodes`). A new `mfa/` subtree: `totp.ts` (hand-rolled RFC 6238 on `node:crypto`), `secret-crypto.ts` (AES-256-GCM keyring envelope), `recovery.ts` (code gen), `functions.ts` (`makeMfaModules(config)`). The gate is a single new `finishSignIn(ctx, config, userId, deviceLabel?)` helper in `functions.ts` that every first-factor path calls instead of `mintSession`; `mintSession` is unchanged and its only new direct caller is `completeMfaSignIn`. Config gains `resolveMfaConfig`.

**Tech Stack:** TypeScript, Bun, Turborepo, vitest under Node, `@stackbase/values`/`@stackbase/executor`/`@stackbase/component` seams, `@stackbase/errors` typed errors, `@stackbase/test` for component tests, `node:crypto` (HMAC-SHA1, AES-256-GCM, CSPRNG). No new npm dependency.

## Global Constraints

Binding values copied from the design spec. Do not relitigate while implementing:

- **TOTP defaults:** SHA1 / 6 digits / 30s period / ±1 step window. Stored per-enrollment (`algorithm`/`digits`/`period`), fixed in the v1 config surface (decision 1).
- **Secret at rest = AES-256-GCM, NOT hashed** (decision 2). Envelope `v1.<keyId>.<iv>.<ct>.<tag>` (base64url); 96-bit random IV per encryption; 128-bit tag; **AAD = the enrollment `userId`** (decision 3).
- **Keyring:** `encryptionKeys[0]` is primary (new encryptions); decrypt dispatches on stored `keyId`. Single `encryptionKey` = a one-entry keyring with `id "1"`. A 32-byte key given as base64 **or** hex; wrong-length/empty/missing-when-`mfa`-configured → **fail fast in `resolveAuthConfig`** (decision 3).
- **The gate is a wrapper, never a bypass** (decisions 5, 12): every gated first-factor success returns `finishSignIn(...)`, which returns `{ mfaRequired: true, pendingToken, expiresAt }` for a **confirmed**-enrolled user, else `mintSession(...)`. `mintSession` stays the only mint; `completeMfaSignIn` is its only new direct caller. Gated sites: `signIn`, verified `signUp`, `verifyEmail`, `signInWithMagicLink`, `signInWithOtp`, `resetPassword`, A3 `_resolveExternalIdentity`(`outcome:"mint"`) + `_consumeHandoff`. **Not** gated: `refresh` (rotates in place, never mints), `signInAnonymously` (direct `mintSession`).
- **Pending state = hashed single-use short-TTL `mfaChallenges` row** (decision 6, the `oauthHandoff` shape) holding NO token; `challengeTtlMs` default 5min. Consume-before-validate. `mfaAttempts` default 5 wrong second-factor guesses delete the challenge via **commit-then-throw** (the A1/A2 lockout mechanism) (decision 10).
- **Recovery codes** (decision 7): `recoveryCodeCount` default 10; hashed at rest (`sha256base64url`); one row each; consume = delete; regenerate replaces the whole `byUserId` set.
- **TOTP replay guard** = monotonic `lastUsedStep`; reject matched step `<= lastUsedStep`, advance on success (decision 9).
- **Disable/regenerate require a fresh valid TOTP or recovery code** (decision 11); `disableMfa` deletes the enrollment + all recovery rows.
- **Error codes** (code-as-message): `MFA_NOT_CONFIGURED`, `MFA_ALREADY_ENROLLED`, `MFA_NOT_ENROLLED`; generic `"invalid code"` for every second-factor / confirm failure (never distinguished).
- **Additive-schema-only:** three new tables, all-optional-where-not-required fields — verify against `packages/cli/src/schema-diff.ts` (new table accepted; new optional field accepted).
- **Determinism:** CSPRNG material (secret, IV, pending token, recovery codes) is generated *inside* mutations — the A1/A2 `mintSession`/`_issueCode` precedent; an OCC replay regenerates harmlessly. TOTP verify is pure over the decrypted secret + deterministic `ctx.now()` step. **Never `Date.now()` in a handler** — use `ctx.now()`.
- **E2E through the real server:** `packages/cli/test/auth-mfa-e2e.test.ts` drives a REAL `@stackbase/client` over a REAL WebSocket against a REAL `stackbase dev` server (the e2e-through-shipped-entrypoint rule).
- **Reference is Apache-2.0 / MIT — adapt with attribution comments, never copy FSL code.**
- **Build ordering:** cross-package tests resolve deps via built `dist/`. After editing `@stackbase/auth` src, `bun run --filter @stackbase/auth build` before running dependents' tests.

Verification commands:

```bash
bun run build
bun run typecheck
bun run --filter @stackbase/auth build
bun run --filter @stackbase/auth test
bun run --filter @stackbase/cli test
```

---

## Task 1 — TOTP + base32 primitive (pure unit, no engine)

Hand-rolled RFC 6238 on `node:crypto`. No dependency, no db, no config — the crypto core the rest builds on.

### Files
- **Create** `components/auth/src/mfa/totp.ts`
- **Create** `components/auth/test/totp.test.ts`

### Interfaces
```ts
// mfa/totp.ts
export function base32Encode(buf: Buffer): string;      // RFC 4648, no padding, uppercase
export function base32Decode(s: string): Buffer;        // tolerant of case/padding/spaces
export function generateTotpSecret(bytes?: number): string;  // default 20 bytes → base32 string
export interface TotpParams { algorithm?: "SHA1"; digits?: number; period?: number; }
export function totpCodeAt(secretBase32: string, stepCounter: number, p?: TotpParams): string;
export function currentStep(nowMs: number, period?: number): number;  // floor(now/1000/period)
// Returns the matched step (for lastUsedStep) or null. Checks steps [now-window, now+window].
export function verifyTotp(
  secretBase32: string, presented: string, nowMs: number,
  opts?: TotpParams & { window?: number },
): number | null;
export function buildOtpauthUri(args: {
  issuer: string; accountName: string; secretBase32: string; algorithm?: string; digits?: number; period?: number;
}): string;
```
Implementation notes: HMAC-SHA1 over an 8-byte big-endian counter (`Buffer.allocUnsafe(8).writeBigUInt64BE`), RFC 4226 dynamic truncation (`offset = hmac[19] & 0x0f`; 31-bit int; `% 10**digits`; zero-pad). `verifyTotp` compares against each candidate step's code with a length-guarded constant-time compare (`crypto.timingSafeEqual` on equal-length buffers).

### TDD steps
1. **RED**: assert `totpCodeAt` matches the RFC 6238 Appendix B published SHA1 vectors (e.g. T=59 → step 1 → `94287082` for the RFC 8-digit seed; use the RFC seed + assert the documented codes). base32 round-trips arbitrary buffers; tolerant decode of lowercase/spaces/padding.
2. **GREEN**: implement.
3. `verifyTotp` returns the matched step for an exact and a ±1-skewed code, `null` for a wrong code; `buildOtpauthUri` produces a spec-shaped `otpauth://totp/...` string that parses.

---

## Task 2 — Secret encryption keyring (pure unit, no engine)

AES-256-GCM envelope with keyId dispatch + AAD binding. Depends on nothing but `node:crypto`.

### Files
- **Create** `components/auth/src/mfa/secret-crypto.ts`
- **Create** `components/auth/test/secret-crypto.test.ts`

### Interfaces
```ts
// mfa/secret-crypto.ts
export interface MfaKey { id: string; key: Buffer; }         // key is 32 bytes
export function decodeKeyMaterial(raw: string): Buffer;       // base64 or hex → 32-byte Buffer; throws if not 32 bytes
export function encryptSecret(keyring: MfaKey[], plaintext: string, aadUserId: string): string; // uses keyring[0]
export function decryptSecret(keyring: MfaKey[], envelope: string, aadUserId: string): string;  // dispatch on keyId
```
Envelope: `v1.<keyId>.<ivB64url>.<ctB64url>.<tagB64url>`. `encryptSecret` → `createCipheriv("aes-256-gcm", key, iv)` with `iv = randomBytes(12)`, `cipher.setAAD(Buffer.from(aadUserId))`, `getAuthTag()`. `decryptSecret` parses the envelope, finds the `MfaKey` whose `id === keyId` (throw a generic error if absent), `setAAD`, `setAuthTag`, decrypt.

### TDD steps
1. **RED**: encrypt→decrypt round-trip returns the plaintext; a wrong `aadUserId` on decrypt throws; a tampered ct/tag throws; a secret encrypted under a one-key ring still decrypts after a second key is prepended (rotation); `decodeKeyMaterial` accepts a 32-byte base64 and hex, rejects a 16-byte value.
2. **GREEN**: implement.

---

## Task 3 — Config + schema + errors

Wire `mfa` into `AuthConfig`, add the three tables, add typed errors. Fail-fast key validation.

### Files
- **Modify** `components/auth/src/config.ts` (add `MfaOptions`/`MfaConfig`, `resolveMfaConfig`, thread through `resolveAuthConfig`)
- **Modify** `components/auth/src/schema.ts` (three new tables + indexes)
- **Modify** `components/auth/src/errors.ts` (`MfaNotConfiguredError`, `MfaAlreadyEnrolledError`, `MfaNotEnrolledError`)
- **Modify** `components/auth/src/index.ts` (export the new config types + errors)
- **Create** `components/auth/test/mfa-config.test.ts`

### Interfaces
```ts
export interface MfaOptions {
  encryptionKey?: string;
  encryptionKeys?: Array<{ id: string; key: string }>;
  issuer?: string; recoveryCodeCount?: number; challengeTtlMs?: number;
  mfaAttempts?: number; window?: number;
}
export interface MfaConfig {
  keyring: MfaKey[];            // decoded, [0] primary
  issuer: string; recoveryCodeCount: number; challengeTtlMs: number;
  mfaAttempts: number; window: number;
  algorithm: "SHA1"; digits: number; period: number;  // 6 / 30 in v1
}
// AuthConfig gains: mfa?: MfaConfig;  AuthOptions gains: mfa?: MfaOptions;
export function resolveMfaConfig(opts: MfaOptions): MfaConfig;  // decode+validate keys; throw on empty/short/absent
```
Defaults: `recoveryCodeCount 10`, `challengeTtlMs 5*60*1000`, `mfaAttempts 5`, `window 1`, `digits 6`, `period 30`, `issuer = opts.issuer ?? "Stackbase"`. `resolveMfaConfig` builds the keyring from `encryptionKeys` (in order) or `[{ id:"1", key: encryptionKey }]`; throws `Error("defineAuth({ mfa }) requires a 32-byte encryptionKey or encryptionKeys")` if neither present, and lets `decodeKeyMaterial` throw on a bad length.

### TDD steps
1. **RED**: `resolveAuthConfig({ mfa: { encryptionKey: <valid 32-byte b64> } })` yields a `config.mfa` with a one-entry keyring + defaults; `mfa` with no key throws; a 16-byte key throws; a keyring preserves order (primary = [0]); `mfa` absent → `config.mfa === undefined`.
2. **GREEN**: implement `resolveMfaConfig` + schema tables + errors.
3. Assert the schema additions pass the additive gate (a small `schema-diff` unit or reuse the existing gate test pattern): three new tables accepted.

---

## Task 4 — `makeMfaModules`: enrollment + management + recovery

The enrolled-user surface (all require `ctx.auth.getUserId()`). No gate wiring yet — that's Task 5.

### Files
- **Create** `components/auth/src/mfa/recovery.ts`
- **Create** `components/auth/src/mfa/functions.ts`
- **Modify** `components/auth/src/index.ts` (export `makeMfaModules`)
- **Create** `components/auth/test/mfa-enrollment.test.ts`

### Interfaces
```ts
// mfa/recovery.ts
export function generateRecoveryCodes(count: number): string[];   // high-entropy, human-groupable
// mfa/functions.ts
export function makeMfaModules(config: AuthConfig): Record<string, RegisteredFunction>;
// exposes: startMfaEnrollment, confirmMfaEnrollment, disableMfa, regenerateRecoveryCodes, getMfaStatus
// helper (exported for Task 5 completeMfaSignIn reuse):
export async function verifyUserSecondFactor(
  ctx: MutationCtx, config: AuthConfig, userId: string, code: string,
): Promise<"totp" | "recovery" | null>;  // advances lastUsedStep / consumes a recovery row on success
```
`startMfaEnrollment`: require userId; if a **confirmed** enrollment exists → `MfaAlreadyEnrolledError`; generate secret, encrypt (AAD=userId), upsert an unconfirmed `mfaEnrollments` row (delete any prior unconfirmed first), return `{ secret, otpauthUri, digits, period, algorithm }` (raw secret returned once, mint precedent). `confirmMfaEnrollment({ code })`: require an unconfirmed enrollment (`MfaNotEnrolledError` if none), decrypt, `verifyTotp`; on success set `confirmedAt` + `lastUsedStep`, `generateRecoveryCodes`, store hashes, return raw codes; wrong code → generic `"invalid code"`. `disableMfa({ code })`: require confirmed enrollment; `verifyUserSecondFactor` must return non-null (else generic invalid); delete enrollment + all `mfaRecoveryCodes.byUserId`. `regenerateRecoveryCodes({ code })`: require confirmed enrollment; TOTP-only check; replace the set, return raw. `getMfaStatus` (query): `{ enrolled, confirmed, recoveryCodesRemaining }`.

`verifyUserSecondFactor`: decrypt the confirmed enrollment's secret; `verifyTotp` (matched step `> lastUsedStep`) → advance `lastUsedStep`, return `"totp"`; else hash the code and look up `mfaRecoveryCodes.byUserCode` (`["userId","codeHash"]`) → delete row, return `"recovery"`; else `null`.

### TDD steps
1. **RED** (component tests via `createTestStackbase` with an authed identity): stored `secretEncrypted` is an envelope, never the raw base32; sign-in stays ungated pre-confirm; a wrong confirm code leaves `confirmedAt` unset; a valid confirm activates + returns 10 recovery codes hashed at rest; `start` on a confirmed enrollment → `MFA_ALREADY_ENROLLED`; re-`start` overwrites an unconfirmed row.
2. **GREEN**: implement `recovery.ts` + `functions.ts`.
3. Recovery consume-once (replay fails); `regenerateRecoveryCodes` invalidates the old set + needs a valid TOTP; `disableMfa` needs a valid factor, removes enrollment + all recovery rows; replay guard: same TOTP twice → second rejected.

---

## Task 5 — The gate: `finishSignIn` + `completeMfaSignIn` + wiring every mint site

The load-bearing task. Interpose `finishSignIn` at every gated first-factor path; add `completeMfaSignIn`; compose `makeMfaModules` into the component.

### Files
- **Modify** `components/auth/src/functions.ts` (add `finishSignIn`, `MfaRequired` type; replace `return mintSession(...)` at gated sites; compose mfa modules in `makeAuthModules`)
- **Modify** `components/auth/src/external.ts` (route `_resolveExternalIdentity` `outcome:"mint"` + `_consumeHandoff` through `finishSignIn`)
- **Modify** `components/auth/src/mfa/functions.ts` (add `completeMfaSignIn`, using `verifyUserSecondFactor` + `mintSession`)
- **Modify** `components/auth/src/component.ts` (`makeAuthModules` already composes; ensure mfa registered iff `config.mfa`)
- **Modify** `components/auth/src/index.ts` (export `MfaRequired`, `finishSignIn`)
- **Create** `components/auth/test/mfa-gate.test.ts`

### Interfaces
```ts
export type MfaRequired = { mfaRequired: true; pendingToken: string; expiresAt: number };
export async function finishSignIn(
  ctx: WriteCtx, config: AuthConfig, userId: string, deviceLabel?: string,
): Promise<MintResult | MfaRequired>;
// gated success arms change from `MintResult | ...` to `MintResult | MfaRequired | ...`
// completeMfaSignIn({ pendingToken, code }) → MintResult | commitThenThrow
```
`finishSignIn`: if `!config.mfa` → `return mintSession(...)` (passthrough, decision 13). Read `mfaEnrollments.byUserId`; a **confirmed** row → mint a raw `pendingToken`, insert `mfaChallenges` (hash, userId, deviceLabel, failedAttempts 0, expiresAt = now + challengeTtlMs), return `{ mfaRequired: true, pendingToken, expiresAt }`; else `mintSession(...)`. `completeMfaSignIn`: lookup `mfaChallenges.byChallengeHash`; missing/expired → generic invalid; `verifyUserSecondFactor(userId, code)` non-null → delete challenge, `mintSession(userId, deviceLabel)`; null → bump `failedAttempts`, at `mfaAttempts` delete the challenge, `commitThenThrow("invalid code")`.

**Wiring checklist** (replace `return mintSession(ctx, config, X, dev)` with `return finishSignIn(ctx, config, X, dev)`): `signIn` (post-password), `signUp` (post-verification mint arm), `verifyEmail`, `adoptOrCreateThenMint` (backs `signInWithMagicLink`/`signInWithOtp`), `resetPassword` (post-revoke mint), `external.ts` `_resolveExternalIdentity` `outcome:"mint"` + `_consumeHandoff`. **Leave alone**: `mintSession` itself, `refresh` (in-place rotate), `signInAnonymously`. Widen each site's return type to include `MfaRequired`.

### TDD steps
1. **RED**: parametrized over every gated entry point — an enrolled+confirmed user gets `{ mfaRequired: true }` with NO `token`; a non-enrolled user gets a normal `MintResult`; `completeMfaSignIn` with the live TOTP then mints a working session; with a recovery code also mints (and consumes the code). A no-`mfa`-config deployment: every path mints directly (passthrough), return types byte-identical.
2. **GREEN**: implement `finishSignIn` + `completeMfaSignIn` + wire all sites.
3. Rate limit: `mfaAttempts` wrong `completeMfaSignIn` guesses delete the challenge (correct code after → generic invalid, pending window destroyed); counter survives via commit-then-throw. Expired challenge → generic invalid. Reset-still-challenges (decision 12) asserted.
4. **Guard test** (the invariant): grep-style assertion in the test — `functions.ts`/`external.ts` contain no `return mintSession(` at a gated site (all route through `finishSignIn`); `completeMfaSignIn` is the only new direct `mintSession` caller.

---

## Task 6 — E2E through the real server + docs

Prove the whole flow end to end and document it.

### Files
- **Create** `packages/cli/test/auth-mfa-e2e.test.ts`
- **Modify** `docs/enduser/build/auth.md` (MFA section)
- **Modify** `components/auth/README.md` (limitations re-baselined: MFA shipped)
- **Modify** `examples/auth-demo/` (enrollment screen w/ QR + recovery display; sign-in 2FA prompt — the reference pattern)

### TDD steps
1. **RED**: E2E — a real `@stackbase/client` over a real WebSocket against a real `stackbase dev` server: sign up/in, `startMfaEnrollment`, derive the live code from the returned secret with `mfa/totp.ts`, `confirmMfaEnrollment`, sign out, sign in → `mfaRequired`, `completeMfaSignIn` → session works + a live subscription sees the identity; a second run signs in with a recovery code; `disableMfa` un-gates. The `stackbase.config.ts` under test composes `defineAuth({ mfa: { encryptionKey: <test key> } })`.
2. **GREEN**: fix any integration gaps surfaced (config threading, codegen of the new function refs).
3. Docs: the enroll/verify/recovery flow, the `mfa` config block + key sourcing (env var, generating a 32-byte key, rotation posture, the loss caveat), the client 2FA round trip, and the non-goals.

---

## Sequencing & review

- Tasks 1–2 are pure units (no engine) and independent — can be built in parallel.
- Task 3 depends on 1–2 (imports `MfaKey`/`decodeKeyMaterial`). Task 4 depends on 3. Task 5 depends on 4 (reuses `verifyUserSecondFactor`). Task 6 depends on 5.
- **Whole-branch review focus** (per the auth-arc lesson that final reviews catch blocker-class holes the per-task reviews miss): (a) the gate invariant — every mint site routed through `finishSignIn`, `completeMfaSignIn` the lone new direct minter, no enrolled-user path reaching `mintSession` on the first factor alone; (b) the encrypted-secret AAD binding + fail-fast key validation; (c) determinism of the in-mutation CSPRNG writes; (d) the reset-still-challenges credential-boundary decision is intentional and tested.
