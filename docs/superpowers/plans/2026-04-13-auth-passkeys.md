# Auth follow-up N1 — passkeys / WebAuthn (implementation plan)

**Date:** 2026-04-13
**Branch:** `worktree-deferred-features` (git worktree off `main`; auth arc A1+A2+A3 + more-providers merged)
**Spec:** `docs/superpowers/specs/2026-04-13-auth-passkeys-design.md` (read it first — this plan
implements it verbatim)
**Slice:** Ship passwordless passkey **registration** (WebAuthn attestation) + primary **sign-in**
(WebAuthn assertion, discoverable + non-discoverable), signature-counter clone detection, per-user limits,
device management (list/rename/revoke), and A2-parity anti-enumeration — all client-driven over the
existing sync connection (no httpAction, no redirect, no handoff). Passkey-as-second-factor (MFA) is
out of scope (N2); this slice ships the primitives it will reuse.

## For agentic workers

Execute this plan with **`superpowers:subagent-driven-development`** — the tasks are ordered so each is an
independent, reviewable unit with its own tests. Recommended flow: one subagent per task (T1→T7 in order),
each running `bun run --filter @stackbase/auth build` + its targeted tests before handing back, with a
review checkpoint between tasks. **T2 is the security-critical seam** (the `@simplewebauthn/server` wrapper
+ the software-authenticator test helper) — give it the closest review; T3/T4/T5 build on it, T6 (E2E)
depends on T2's helper. **Rebuild before dependent tests** (`tests-resolve-deps-via-dist`: cross-package
tests resolve `@stackbase/auth` via built `dist/`, so `bun run --filter @stackbase/auth build` must run
before `packages/cli` E2E tests pick up a source change).

## Goal

A new `components/auth/src/webauthn.ts` seam over `@simplewebauthn/server`, two new schema tables, a
`passkeys` config block with conditional registration, four ceremony actions + four internal mutations +
three device-management functions, a software-authenticator test helper, an E2E through the real
`stackbase dev` server, and end-user docs — **without weakening any A1/A2/A3 invariant** (mint through the
A1 chokepoint, A2-parity anti-enumeration, conditional registration, `byUserId`/`byCredentialId` index
hygiene, hashed-at-rest).

## Architecture

The passkey surface is **client-driven actions**, not httpActions (spec "Transport"): each ceremony is a
`begin*` action (issue a random challenge, store an ephemeral `webauthnChallenge` row) + a `finish*` action
(consume the challenge, call `@simplewebauthn/server`'s verify, delegate the DB write / `mintSession` to an
internal `_`-mutation). **Every `@simplewebauthn/server` call lives in an action** (mirroring A3's
`signInWithIdToken`/jose split) so the crypto libraries stay out of the transactor; challenge storage + the
counter-check + the mint live in internal mutations (`ctx.now()`/`ctx.db`). `httpRoutes` is unchanged
(passkeys add zero routes). Data flow: identity always derives from the **signature-verified** assertion +
the immutable stored `publicKey`; the mutable `counter` is checked + updated atomically in the mint
transaction (clone detection under single-writer OCC).

## Tech Stack

- **`@simplewebauthn/server@13.3.2`** (MIT, pure-JS deps, runs under Bun + Node) — `generateRegistrationOptions`,
  `verifyRegistrationResponse`, `generateAuthenticationOptions`, `verifyAuthenticationResponse`. **Pinned
  exact**, matching `oauth4webapi@3.8.6`/`jose@6.2.3`. Imported in exactly one module (`webauthn.ts`).
- Base64url ↔ bytes via Node `Buffer` (`Buffer.from(bytes).toString("base64url")` /
  `Buffer.from(str, "base64url")`) — no new helper dep; the auth package already uses `node:crypto`.
- Tests: `vitest` under Node (`tests-run-under-node`); component-level tests drive the embedded runtime /
  `@stackbase/test`; the E2E drives a real `@stackbase/client` over a real WebSocket to a real `stackbase
  dev` server (`e2e-through-shipped-entrypoint`). A **software authenticator** helper (WebCrypto P-256)
  stands in for a browser/authenticator.

## Global Constraints

Binding values from the spec's "Locked design decisions". Every task obeys all of these:

1. **Every `@simplewebauthn/server` call is in an action**, never a query/mutation. Challenge generation is
   in the action layer (random); challenge storage, the counter-check, and `mintSession` are in internal
   mutations.
2. **`attestationType: "none"`** — no attestation-format/MDS verification in N1 (verify is pure local crypto,
   no network).
3. **Consume-before-validate** the `webauthnChallenge` (single-use, ~5min TTL); the challenge is stored
   **recoverable** (the documented `oauthState.codeVerifier` exception) and looked up `byChallenge`.
4. **Anti-enumeration:** `beginPasskeyAuthentication({ email })` for an unknown email returns valid options
   with **empty `allowCredentials`** (shape-identical to usernameless); every `finish*` failure is one
   **generic** error.
5. **Mint through `mintSession`** (the A1 chokepoint) — passkey auth **bypasses** `requireEmailVerification`
   (possession is the proof). No raw session token is ever persisted.
6. **Counter clone detection is atomic** in `_finishPasskeyAuth`'s transaction: `0/0` → accept; else require
   `newCounter > storedCounter`; a regression → **generic reject, mint nothing, change no state**.
7. **Index hygiene:** per-user ops range `byUserId`; credential lookups are `byCredentialId` equality — never
   a table scan. `listPasskeys` never returns `publicKey`/`counter`.
8. **Conditional registration** (like `email`/`oauth`/`jwt`): `passkeys` absent → zero passkey functions
   registered; a test pins default-inert. `rpID`/`rpName`/`origins` required when present; non-loopback
   origins must be `https://` (reuse `assertUrlIsSecure`).
9. **Registration requires an authenticated caller** (incl. anonymous); it does **not** mint. Ownership
   checked on rename/revoke.
10. **E2E through the real server** + **rebuild-before-dependent-tests** (see "For agentic workers").

---

## Task 1 — schema + config + conditional-registration wiring + dependency

Land the additive tables, the `passkeys` config block, the `makePasskeyModules` registration hook (bodies
stubbed), and the dependency — proven by a config test + a default-inert proof. No ceremony logic yet.

### Step 1.1 — add the dependency

`components/auth/package.json` `dependencies`: add `"@simplewebauthn/server": "13.3.2"` (exact, alongside
`jose`/`oauth4webapi`). `bun install`.

### Step 1.2 — schema (`components/auth/src/schema.ts`)

Add the two tables from the spec's "Schema" section to `authSchema`: `passkeys` (indexes `byCredentialId`,
`byUserId`) and `webauthnChallenge` (index `byChallenge`). Copy the field set + doc comments verbatim from
the spec. All new tables — no change to existing tables, live-deploy-additive.

### Step 1.3 — config (`components/auth/src/config.ts`)

- Add `PasskeyConfig` (resolved: `rpID`, `rpName`, `origins`, `challengeTtlMs`, `maxCredentialsPerUser`,
  `userVerification`, `residentKey`) and `PasskeyOptions` (user-facing: `rpID`/`rpName`/`origins` required,
  rest optional).
- `AuthConfig.passkeys?: PasskeyConfig`; `AuthOptions` gains `passkeys?: PasskeyOptions` (extend the
  `Omit<…, "email" | "oauth" | "jwt">` to also omit `passkeys`, mirroring the existing pattern).
- `PASSKEY_DEFAULTS = { challengeTtlMs: 5*60*1000, maxCredentialsPerUser: 20, userVerification: "preferred",
  residentKey: "preferred" }`.
- `resolvePasskeyConfig(opts)`: throw if `rpID`/`rpName` empty or `origins` empty (the
  `redirectAllowlist`-style guard); validate every origin with **`assertUrlIsSecure`** (imported from
  `./oauth`, already exported — loopback `http://` ok, non-loopback must be `https://`); apply defaults.
- `resolveAuthConfig`: destructure `passkeys` out of `opts`; `if (passkeys) base.passkeys =
  resolvePasskeyConfig(passkeys)`.

### Step 1.4 — registration hook (`components/auth/src/functions.ts`)

- New module `components/auth/src/passkeys.ts` exporting `makePasskeyModules(config: AuthConfig):
  Record<string, RegisteredFunction>` — for T1 return an object with the **module keys present but bodies
  stubbed** (e.g. each a `mutation`/`action`/`query` throwing `"not implemented"`), so
  `passkeys-config.test.ts` can pin the registered-key contract now and T3–T5 fill the bodies without
  changing the shape. Keys: `beginPasskeyRegistration`, `finishPasskeyRegistration`,
  `beginPasskeyAuthentication`, `finishPasskeyAuthentication`, `listPasskeys`, `renamePasskey`,
  `revokePasskey`, `_storeChallenge`, `_consumeChallenge`, `_savePasskey`, `_finishPasskeyAuth`.
- In `makeAuthModules`, after the `oauth || jwt` line, add:
  `if (config.passkeys) modules = { ...modules, ...makePasskeyModules(config) };`

### Step 1.5 — exports (`components/auth/src/index.ts`)

Export the config types: add `PasskeyConfig`, `PasskeyOptions` to the `config` type export line. No
value/builder exports (unlike A3).

### Step 1.6 — tests `components/auth/test/passkeys-config.test.ts` (new)

- `resolvePasskeyConfig` applies defaults; throws on empty `rpID`/`rpName`/`origins`; rejects a non-loopback
  `http://` origin (via `assertUrlIsSecure`), accepts `https://` + loopback `http://localhost`.
- **Default-inert proof:** `defineAuth()` (no `passkeys`) registers **none** of the passkey keys;
  `defineAuth({ passkeys: { rpID, rpName, origins } })` registers **all eleven** keys. (Assert against the
  composed module map, the way `external-config.test.ts` pins the OAuth surface.)
- `httpRoutes` is unchanged by adding `passkeys` (still exactly the A3 GET/POST oauth entries, or absent when
  no `oauth`).

### Step 1.7 — verify

`bun run --filter @stackbase/auth build && bun run --filter @stackbase/auth test`. Green.

---

## Task 2 — the `webauthn.ts` seam + software-authenticator test helper (security-critical)

The single module that imports `@simplewebauthn/server`, plus the WebCrypto software authenticator every
later test uses. No ceremony wiring yet — just the seam + its unit tests.

### Step 2.1 — `components/auth/src/webauthn.ts` (new)

Thin typed wrappers (the A3 `oauth.ts` pattern — one import site):

```ts
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type { PasskeyConfig } from "./config";
```

- `b64u(bytes: Uint8Array): string` / `unb64u(s: string): Uint8Array` — `Buffer` base64url helpers.
- `buildRegistrationOptions(config, { userId, userName, existing: {credentialId, transports?}[] })` →
  `generateRegistrationOptions({ rpName: config.rpName, rpID: config.rpID, userName, userID:
  unb64u(base64url(userId)) /* stable bytes from userId */, attestationType: "none", excludeCredentials:
  existing.map(...), authenticatorSelection: { residentKey: config.residentKey, userVerification:
  config.userVerification } })`. Return the options object (challenge included) — the caller stores
  `options.challenge` and returns `options` to the client.
- `verifyRegistration(config, { response, expectedChallenge })` →
  `verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin: config.origins, expectedRPID:
  config.rpID, requireUserVerification: config.userVerification === "required" })`; on `verified` normalize
  to `{ credentialId: string, publicKey: string, counter: number, transports?: string[], backedUp: boolean }`
  (base64url the `credential.id`/`credential.publicKey`).
- `buildAuthenticationOptions(config, { allowCredentials })` →
  `generateAuthenticationOptions({ rpID: config.rpID, allowCredentials, userVerification:
  config.userVerification })`.
- `verifyAuthentication(config, { response, expectedChallenge, credential })` →
  `verifyAuthenticationResponse({ response, expectedChallenge, expectedOrigin: config.origins,
  expectedRPID: config.rpID, credential, requireUserVerification: config.userVerification === "required" })`;
  return `{ verified, newCounter }`.
- `challengeOf(clientDataJSON: string): string` — decode the base64url `clientDataJSON`, `JSON.parse`, return
  `.challenge` (base64url). Used by `finish*` to find the stored row. Defensive: return `""` on any parse
  failure (→ a generic no-match downstream).

Pin the exact `@simplewebauthn/server` types (`RegistrationResponseJSON`/`AuthenticationResponseJSON`) on
the wrapper signatures so the actions stay type-clean.

### Step 2.2 — software authenticator `components/auth/test/support/mock-authenticator.ts` (new)

A WebCrypto (`node:crypto` `subtle`) helper mirroring `mock-oauth-provider.ts`. Generates an EC **P-256**
keypair and produces:

- `createRegistration({ challenge, rpID, origin, userId }): RegistrationResponseJSON` — assemble
  `authenticatorData` (RP-ID SHA-256 hash + flags `UP|UV|AT` + a zero/rolling counter + attested credential
  data with a random `credentialId` + the COSE-encoded P-256 public key), a `none` `attestationObject`
  (CBOR `{ fmt: "none", attStmt: {}, authData }`), and `clientDataJSON` (`{ type:
  "webauthn.create", challenge, origin }`). Return the `@simplewebauthn`-shaped JSON (base64url fields).
- `createAssertion({ challenge, rpID, origin, credentialId, counter }): AuthenticationResponseJSON` —
  assemble `authenticatorData` (RP-ID hash + `UP|UV` flags + `counter`), `clientDataJSON` (`{ type:
  "webauthn.get", challenge, origin }`), and a P-256 `signature` over `authenticatorData || SHA-256(clientDataJSON)`
  with the keypair's private key. Set `response.userHandle` = `userId`. Expose `counter` control so T4 can
  drive a **regression** (assert with a counter ≤ the stored one).

Keep it minimal but spec-correct — CBOR for `attestationObject` (a tiny hand-rolled encoder or
`@levischuck/tiny-cbor`, already transitively present, is fine) and COSE key encoding for a P-256 EC2 key
(kty=2, alg=-7, crv=1, x/y). This is the standard browserless-WebAuthn test approach; it exists once and is
shared by every later test.

### Step 2.3 — wrapper unit tests `components/auth/test/webauthn.test.ts` (new)

Drive `buildRegistrationOptions` → `mockAuthenticator.createRegistration` → `verifyRegistration` (happy);
wrong-challenge / wrong-origin / wrong-RP-ID → not `verified` / throws. Then `buildAuthenticationOptions` →
`createAssertion` → `verifyAuthentication` (happy, `newCounter` returned); tampered signature → not verified.
`challengeOf` extracts the challenge from a `clientDataJSON`. No network, no DB.

### Step 2.4 — verify

`bun run --filter @stackbase/auth build && bun run --filter @stackbase/auth test`. Green. Add a
`bun run`-under-Bun smoke of `webauthn.test.ts`'s happy paths (the lib is pure-JS; confirms the Bun path —
`tests-run-under-node`).

---

## Task 3 — registration ceremony (attestation)

Fill `beginPasskeyRegistration`/`finishPasskeyRegistration` + `_storeChallenge`/`_consumeChallenge`/
`_savePasskey` in `passkeys.ts`.

### Step 3.1 — internal mutations

- `_storeChallenge({ kind, challenge, callerToken? })` — for `kind:"register"`, resolve the caller's `userId`
  from the ambient session (`currentSessionOf`/`resolveSession`, reused from `functions.ts` — export the
  helper or replicate the tiny resolve); **reject generically if unauthenticated**. Insert a
  `webauthnChallenge` row (`compact`, `expiresAt = now + config.passkeys.challengeTtlMs`). Return `{ userId }`
  (register) so `begin` knows whom to build options for. (Auth flows pass no token in `kind:"authenticate"`.)
- `_consumeChallenge({ challenge, kind })` — consume-before-validate: look up `byChallenge`, `delete` it,
  then validate `kind` + `expiresAt` (`commitThenThrow` on a post-delete failure, the `_consumeOAuthState`
  pattern); return `{ userId? }`. A miss → plain generic throw.
- `_savePasskey({ userId, credentialId, publicKey, counter, transports?, backedUp?, deviceName? })` — enforce
  the **per-user limit** (`byUserId` count ≥ `maxCredentialsPerUser` → throw generic) and **duplicate
  guard** (`byCredentialId` exists → throw generic); insert the `passkeys` row (`createdAt = now`). Return
  `{ passkeyId }`.

### Step 3.2 — actions

- `beginPasskeyRegistration({ deviceName? })` — read the caller's bearer (the A3 `bearerOf`-style token
  threading, or `ctx.auth`); `runMutation("auth:_storeChallenge", { kind: "register", challenge: <generated>,
  callerToken })`. Sequence: build options first (`buildRegistrationOptions` — it generates the challenge),
  then store `options.challenge`. So: build options → `runMutation _storeChallenge({ challenge:
  options.challenge, ... })` → return `options`. (Load `excludeCredentials` via a `runQuery` of the user's
  passkeys — a new internal `_listPasskeyDescriptors({ userId })` query, or fold it into `_storeChallenge`'s
  return. Prefer a small internal query so `begin` stays a pure action.)
- `finishPasskeyRegistration({ response, deviceName? })` — `challengeOf(response.response.clientDataJSON)` →
  `runMutation _consumeChallenge({ challenge, kind: "register" })` (→ `{ userId }`) → `verifyRegistration`
  (throw generic on `!verified`) → `runMutation _savePasskey({ userId, ...normalized, deviceName })`. Return
  `{ registered: true, passkeyId }`.

### Step 3.3 — tests `components/auth/test/passkeys-register.test.ts` (new)

Using the embedded runtime + mock authenticator (drive the actions via `runAction`, seed an authed session
first — reuse the auth-session test harness): happy registration writes a `passkeys` row with the right
`userId`/`transports`/`backedUp`; wrong-origin/challenge → generic reject, **no** row; a second registration
of the **same** credentialId → duplicate reject; the (N+1)th registration past `maxCredentialsPerUser` →
limit reject; an **unauthenticated** `begin` → generic reject.

### Step 3.4 — verify

`bun run --filter @stackbase/auth build && bun run --filter @stackbase/auth test`. Green.

---

## Task 4 — authentication ceremony (assertion) + clone detection + mint

Fill `beginPasskeyAuthentication`/`finishPasskeyAuthentication` + `_finishPasskeyAuth`.

### Step 4.1 — `_finishPasskeyAuth` (the atomic counter-check + mint)

`_finishPasskeyAuth({ credentialId, newCounter, deviceLabel? })` — re-read the credential `byCredentialId`
(missing → generic throw). Apply the **clone rule** (spec decision 6): `if (stored === 0 && newCounter === 0)`
accept; `else if (newCounter > stored)` accept + `replace` counter; `else` **generic throw, no write, no
mint** (regression). On accept, set `counter = newCounter`, `lastUsedAt = now`, then
`return mintSession(ctx, config, row.userId, deviceLabel)` — the A1 chokepoint (bypasses the
email-verification gate by construction; passkey auth never consults it).

### Step 4.2 — actions

- `beginPasskeyAuthentication({ email? })` — if `email`: `runQuery` the user + their passkey descriptors
  (`allowCredentials`); **if none, use `[]`** (anti-enumeration — shape-identical to usernameless). If no
  `email`: `allowCredentials: []` (discoverable). `buildAuthenticationOptions(config, { allowCredentials })`
  → `runMutation _storeChallenge({ kind: "authenticate", challenge: options.challenge })` → return `options`.
- `finishPasskeyAuthentication({ response })` — `challengeOf(clientDataJSON)` →
  `runMutation _consumeChallenge({ challenge, kind: "authenticate" })` → `runQuery
  _getPasskeyByCredentialId({ credentialId: response.id })` (→ `publicKey`/`counter`/`userId`/`transports`;
  missing → generic reject) → `verifyAuthentication(config, { response, expectedChallenge: challenge,
  credential: { id: response.id, publicKey: unb64u(publicKey), counter, transports } })` (throw generic on
  `!verified`) → `runMutation _finishPasskeyAuth({ credentialId, newCounter })`. Return the `MintResult` →
  the app calls `setSession`. Cross-check `response.userHandle` == `userId` (mismatch → generic reject).

### Step 4.3 — tests `components/auth/test/passkeys-authenticate.test.ts` (new)

Register a passkey (T3 path), then: **usernameless** happy sign-in mints a session for the right `userId`
(resolved via `userHandle`); **counter regression** (assert with a stale counter) → generic reject, **no
mint, counter unchanged**; an **unknown credentialId** → generic reject; **anti-enumeration** —
`beginPasskeyAuthentication({ email: <unknown> })` returns options whose `allowCredentials` is `[]`, the same
shape as a usernameless begin (assert byte-shape equality of the returned shape sans challenge); an
already-verified user's email-scoped begin returns their credential descriptors. Confirm the mint respects
A1 (hashed pair at rest — no raw token in the `sessions` row).

### Step 4.4 — verify

`bun run --filter @stackbase/auth build && bun run --filter @stackbase/auth test`. Green.

---

## Task 5 — device management (list / rename / revoke)

Fill `listPasskeys`/`renamePasskey`/`revokePasskey` — the A1 `listSessions`/`revokeSession` mirror.

### Step 5.1 — functions

- `listPasskeys()` — query. `currentSessionOf` → `userId` (unauthed → `[]`). Range **`byUserId`** (never a
  scan); map to `{ passkeyId, deviceName, transports, backedUp, createdAt, lastUsedAt }` — **never**
  `publicKey`/`counter`. Reactive (revoking a passkey elsewhere updates a live `listPasskeys`).
- `renamePasskey({ passkeyId, deviceName })` — mutation, authed, **ownership** (`get` the row; foreign/absent
  → generic `"passkey not found"`); `replace` `deviceName`.
- `revokePasskey({ passkeyId })` — mutation, authed, ownership; `delete` the row.

### Step 5.2 — tests `components/auth/test/passkeys-manage.test.ts` (new)

`listPasskeys` returns the caller's credentials and **omits `publicKey`/`counter`** (assert the key set);
`renamePasskey`/`revokePasskey` reject a **foreign** `passkeyId` (ownership); a revoked passkey can no longer
authenticate (T4 finish → generic reject); a subscribed `listPasskeys` re-runs on a revoke (reactive — drive
via `@stackbase/test`'s `t.subscribe`).

### Step 5.3 — verify

`bun run --filter @stackbase/auth build && bun run --filter @stackbase/auth test`. Green.

---

## Task 6 — E2E through the real `stackbase dev` server

`packages/cli/test/auth-passkeys-e2e.test.ts` (new), modeled on `auth-external-e2e.test.ts` /
`auth-session-e2e.test.ts` (`loadProject` + `startDevServer` + a real `@stackbase/client` over a real
WebSocket + event-driven `waitFor`). Uses the T2 `mock-authenticator.ts` (copy/import into
`packages/cli/test/support/` if the component test-support isn't resolvable cross-package — mirror how
`mock-oauth-provider.ts` is shared).

Compose `defineAuth({ passkeys: { rpID: "localhost", rpName: "Test", origins: ["http://localhost:5173"] } })`
+ a `whoami.get` query. Flow:

1. `client.action(beginPasskeyRegistration)` while **signed in anonymously** →
   `mockAuthenticator.createRegistration(options)` → `client.action(finishPasskeyRegistration)` →
   `{ registered: true }`.
2. A **fresh** client connection: open a live `whoami.get` subscription (sees `null`), then
   `client.action(beginPasskeyAuthentication)` (**usernameless**) →
   `mockAuthenticator.createAssertion(options)` → `client.action(finishPasskeyAuthentication)` → hand the
   `MintResult` to `createAuthClient.setSession` → `waitFor` the `whoami` subscription to flip to the
   registered `userId` (the reactive fan-out).
3. **Counter regression** — a second assertion with a stale counter → `finishPasskeyAuthentication` rejects,
   `whoami` stays as-is.

Per `auth-external-e2e.test.ts`, a composed component's client-callable actions dispatch through the sync
connection normally — passkeys add **no** `componentRoutes` (no httpAction), so unlike the OAuth E2E there
is no route-closure wiring to build.

**Rebuild `@stackbase/auth` before running** (`tests-resolve-deps-via-dist`).

`bun run --filter @stackbase/cli test auth-passkeys` (after the auth build). Green.

---

## Task 7 — docs + example + README

### Step 7.1 — end-user docs `docs/enduser/build/auth.md`

New "Passkeys" section: the `defineAuth({ passkeys })` config (rpID/rpName/origins, the defaults), the two
ceremonies (register while authed; sign in — usernameless + email-scoped), the client wiring recipe using
`@simplewebauthn/browser` (`startRegistration`/`startAuthentication`) + `client.action(...)` +
`authClient.setSession(...)`, the anonymous→register passwordless-bootstrap path, device management
(`listPasskeys`/`renamePasskey`/`revokePasskey`), and the security notes (challenge/origin/RP-ID binding,
counter clone detection, anti-enumeration). Canonical imports `@stackbase/*` (not `convex/*`).

### Step 7.2 — example (`examples/auth-demo`)

Add "Register a passkey" + "Sign in with a passkey" (usernameless) buttons wiring the recipe end-to-end
against the demo's own auth config (add `@simplewebauthn/browser` as the example's dependency).

### Step 7.3 — `components/auth/README.md`

Move passkeys from any roadmap/limitations line to shipped; note MFA/second-factor + attestation-format
verification as the reserved N2 follow-ons.

### Step 7.4 — verify

`bun run build && bun run typecheck && bun run test` at the root — full green. Spot-check the example builds.

---

## Definition of done

- `@simplewebauthn/server@13.3.2` pinned; imported only in `webauthn.ts`.
- Two additive tables (`passkeys`, `webauthnChallenge`); `passkeys` config with conditional registration
  (default-inert proven).
- Register + authenticate (discoverable + non-discoverable) ceremonies; mint through `mintSession`; counter
  clone detection atomic; A2-parity anti-enumeration; per-user limit; device mgmt (no key-material leak).
- Component tests + `webauthn.ts` wrapper tests + an E2E through the real `stackbase dev` server (register →
  usernameless sign-in → reactive `whoami` → counter-regression reject), all green under Node, Bun smoke on
  the wrapper.
- Docs + example + README updated. No A1/A2/A3 invariant weakened; `httpRoutes` unchanged.
- **Out of scope (N2):** passkey-as-second-factor / MFA step-up, attestation-format/MDS verification,
  dedicated email-capturing passkey sign-up, conditional-UI autofill — all reserved, not built.
