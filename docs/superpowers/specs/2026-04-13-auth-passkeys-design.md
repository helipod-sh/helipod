# Auth follow-up N1 — passkeys / WebAuthn (design)

**Date:** 2026-04-13
**Status:** Design (for review before implementation)
**Arc context:** The three-slice auth arc is shipped and merged — A1 session core (`4fd0ac1`:
`mintSession`, hashed access+refresh pairs, rotation/reuse detection, device management, anonymous +
in-place upgrade), A2 email flows (`e0b595f`: `EmailProvider` seam, verify/reset/magic-link/OTP, the
`authCodes` ephemeral-row machinery, anti-enumeration, the first-mailbox-proof credential boundary),
A3 external identity (`0d2ff7c`: social OAuth + third-party-JWT, the `httpRoutes` engine seam, the
shared `_resolveExternalIdentity` linking core), plus the more-providers follow-on (`4553dc6`:
Microsoft/Discord/Facebook/Apple on the A3 seam). This slice (N1) adds **passkeys (WebAuthn/FIDO2)**:
passwordless registration + primary sign-in. Everything mints through A1's `mintSession` — a passkey
sign-in mints exactly like every other flow — and composes with the A2 `accounts`/`users` model.

**Goal:** Give `@stackbase/auth` a **passwordless passkey** surface: an authenticated user **registers**
a passkey (WebAuthn *attestation*), and a returning user **signs in** with it (WebAuthn *assertion*) —
including **discoverable/usernameless** sign-in (no email typed first). Cookie-free and WebSocket-first
(the ceremony is app-JS-driven over the existing sync connection, not a browser redirect), with
signature-counter **clone detection**, per-user credential limits, device management (list/rename/revoke),
and A2-parity anti-enumeration. Passkey-as-**second-factor** (MFA step-up) is explicitly deferred to a
follow-on (N2) — see Non-goals; N1 ships the register + authenticate primitives an MFA slice reuses.

## Library (locked)

- **`@simplewebauthn/server`** (v13.3.2, MIT, the de-facto-standard WebAuthn server library) — the
  attestation/assertion verification engine: `generateRegistrationOptions`, `verifyRegistrationResponse`,
  `generateAuthenticationOptions`, `verifyAuthenticationResponse`. Pinned **exact** (`13.3.2`), matching
  the auth package's conservative posture for its other crypto/protocol deps (`oauth4webapi@3.8.6`,
  `jose@6.2.3`). Its transitive deps are pure-JS (`@peculiar/*`, `@hexagon/base64`, `@levischuck/tiny-cbor`)
  — no native addon — so it runs under **both Bun and Node** (engines `node>=20`; our runtime baseline).

  **Why a library, not hand-rolled (the oauth4webapi-vs-Arctic-shaped decision):** we hand-rolled OAuth
  on `oauth4webapi` (a thin protocol driver) because OAuth's per-provider surface is config, not crypto.
  WebAuthn is the opposite: verification means CBOR-decoding authenticator data, parsing COSE public keys,
  validating the `attestationObject`/`clientDataJSON`, checking the RP-ID hash, the UP/UV flags, the
  signature, **and** the signature counter — a broad, subtle crypto surface whose failure mode is *silent*
  (accept a forged credential). The task's own guidance ("lean toward `@simplewebauthn` unless there's a
  strong zero-dep case; WebAuthn crypto is subtler than OAuth") applies: there is **no** strong zero-dep
  case here, and `@simplewebauthn/server` is the OSS reference implementation the entire ecosystem
  (including `better-auth`'s passkey plugin) builds on. Hand-rolling would be a security liability for zero
  DX or portability gain. **Decision: depend on `@simplewebauthn/server`.**

- **No client-package dependency.** `@simplewebauthn/browser` (`startRegistration`/`startAuthentication`,
  which wrap `navigator.credentials.create()/get()`) is an **app-side** dependency, documented in the
  example/recipe — it is **not** pulled into `@stackbase/client`. Passkey sign-in produces an ordinary A1
  `MintResult` the app hands to `createAuthClient.setSession(...)`, exactly as A1 established ("sign-in
  flows stay ordinary app mutations; the app hands the mint result to `setSession`"). See "Client surface".

## Transport (locked): client-driven actions, no httpAction, no handoff

A3 had **two** transports: OAuth used engine-mounted **httpActions** (a browser *redirect* hits our
server directly, so there is no client SDK in the loop and a cookie-free **handoff** row is needed to
deliver the session out of a redirect); the third-party-JWT half used a plain **client-called action**
(`signInWithIdToken`) because the client already holds the token and a live WebSocket.

Passkeys are like the **JWT half, not the OAuth half.** The whole ceremony runs in the app's own JS
(`navigator.credentials.create()/get()`), and the app already has a live `StackbaseClient`. So each
ceremony is **two ordinary client round trips** over the existing sync connection — a `begin*` action
(issue a challenge) and a `finish*` action (verify + act) — with **no** engine-mounted route, **no**
redirect, **no** handoff row, **no** cookies. `@stackbase/auth`'s `httpRoutes` contribution is
**unchanged** by this slice (passkeys add zero routes).

**Every `@simplewebauthn/server` call lives in an ACTION; every DB write + the mint live in an internal
mutation.** This is the exact A3-JWT rule ("the action does the library/crypto work, an internal mutation
does the DB + `mintSession`") and it keeps the heavier crypto libraries **out of the transactor's
deterministic executor** — sidestepping any question of whether `@peculiar/x509` etc. load inside the
(today in-process, tomorrow V8-isolate) executor. Challenge *generation* also lives in the action layer
(it is random); challenge *storage* is an internal mutation (`ctx.now()` TTL, `ctx.db` write).

## The two ceremonies

### Registration (attestation) — add a passkey to an authenticated user

Registration requires an **authenticated caller** (any session, *including anonymous* — see decision 8):
you first exist as a user (email/password, OAuth, magic-link, or `signInAnonymously`), then attach a
passkey. It does **not** mint a new session.

1. **`beginPasskeyRegistration({ deviceName? })`** — ACTION. Resolves the caller's `userId` (via the
   internal mutation, which reads the ambient session — an unauthenticated caller is rejected generically),
   loads the user's existing passkeys as `excludeCredentials` (so the same authenticator can't double-register),
   calls `generateRegistrationOptions({ rpName, rpID, userName, userID: <userId bytes>,
   excludeCredentials, attestationType: "none", authenticatorSelection: { residentKey, userVerification } })`,
   and writes a single-use `webauthnChallenge` row (`kind: "register"`, bound to `userId`) via an internal
   mutation. Returns the **options JSON** to the client.
2. **Client:** `startRegistration(options)` (`@simplewebauthn/browser`) → `navigator.credentials.create()`
   → the **attestation response** (`{ id, rawId, response: { clientDataJSON, attestationObject, transports }, … }`).
3. **`finishPasskeyRegistration({ response, deviceName? })`** — ACTION. Decodes `challenge` out of
   `response.response.clientDataJSON`, **consumes** the matching `webauthnChallenge` row (consume-before-validate
   — a replay finds no row), then `verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin:
   <origins>, expectedRPID: rpID, requireUserVerification })`. On `verified`, extracts `{ credentialID,
   credentialPublicKey, counter, credentialBackedUp }` + `response.response.transports`, and writes the
   `passkeys` row via `_savePasskey` (enforces the per-user limit + rejects a duplicate `credentialId`).
   Returns `{ registered: true, passkeyId }`.

### Authentication (assertion) — sign in with a passkey

1. **`beginPasskeyAuthentication({ email? })`** — ACTION. **Discoverable/usernameless** (no `email`):
   `allowCredentials: []` — the authenticator picks a resident credential. **Non-discoverable** (`email`
   given): loads that user's passkey `credentialId`s as `allowCredentials`. Either way calls
   `generateAuthenticationOptions({ rpID, allowCredentials, userVerification })` and writes a single-use
   `webauthnChallenge` row (`kind: "authenticate"`). **Anti-enumeration:** an `email` with no user / no
   passkeys returns a normal-looking options object with **empty `allowCredentials`** — byte-shape-identical
   to a usernameless request — so `begin` can never be used as an existence oracle (decision 5). Returns
   the **options JSON**.
2. **Client:** `startAuthentication(options)` → `navigator.credentials.get()` → the **assertion response**
   (`{ id, rawId, response: { clientDataJSON, authenticatorData, signature, userHandle }, … }`).
3. **`finishPasskeyAuthentication({ response })`** — ACTION. Decodes `challenge` from `clientDataJSON`,
   **consumes** the matching `webauthnChallenge` row (consume-before-validate), looks up the credential by
   `response.id` (via `runQuery` — an unknown credential → generic failure), reads its `publicKey`/`counter`/
   `userId`, then `verifyAuthenticationResponse({ response, expectedChallenge, expectedOrigin, expectedRPID,
   credential: { id, publicKey, counter, transports }, requireUserVerification })`. On `verified`, hands
   `authenticationInfo.newCounter` to the internal mutation **`_finishPasskeyAuth`**, which **atomically**
   (single-writer OCC, one transaction) re-reads the row, applies the **counter clone-detection** rule
   (decision 6), updates `counter` + `lastUsedAt`, and **`mintSession(userId)`** — the A1 chokepoint.
   Returns the A1 `MintResult` → the app calls `createAuthClient.setSession(...)`.

The credential's `userId` is authoritative (`response.userHandle`, which we set to the `userId` at
registration, is only cross-checked). Passkey auth **bypasses the email-verification gate** (possession of
a registered passkey *is* the proof of control — same as magic-link/OTP/OAuth, which also mint without the
password-gate; decision 7).

## Locked design decisions (numbered)

1. **`@simplewebauthn/server@13.3.2`, pinned exact**, added as an `@stackbase/auth` dependency. Every call
   into it happens in an **action** (never a query/mutation) — mirroring A3's `signInWithIdToken`/jose split.
2. **Transport = two client-driven actions per ceremony** (`begin*`/`finish*`) over the existing WebSocket;
   **no httpAction, no redirect, no handoff, no cookies.** `httpRoutes` is unchanged.
3. **`attestationType: "none"`** (N1). We authenticate *possession of a key bound to our RP*, not the make/model
   of the authenticator. `none` means verification is **pure local crypto with no network** (no cert chain, no
   FIDO MDS lookup), which is what keeps `finish*` a clean action → internal-mutation split. Attestation-format
   verification + enterprise-attestation policy are a Non-goal (N2+).
4. **Challenge storage:** a single-use `webauthnChallenge` row, TTL ~5 min, `consume-before-validate`. The
   `challenge` is stored **recoverable** (not hashed) — the **same documented exception** A3 made for
   `oauthState.codeVerifier`/`nonce`: `verifyRegistrationResponse`/`verifyAuthenticationResponse` need the
   original value as `expectedChallenge`, so a hash won't do. Safe: single-use, short-TTL, server-only, never
   returned to a client after issuance, **not a bearer credential** (useless without the matching authenticator
   signature). Lookup is `byChallenge` (the challenge is already high-entropy server-issued randomness — the
   direct analogue of A3's `state`).
5. **Anti-enumeration parity with A2:** `beginPasskeyAuthentication({ email })` for an unknown email returns a
   valid options object with **empty `allowCredentials`** (indistinguishable from usernameless); every `finish*`
   failure surfaces one **generic** error (no unknown-credential / bad-signature / wrong-challenge / counter
   distinction). Registration is authed → no enumeration surface.
6. **Signature-counter clone detection.** `_finishPasskeyAuth` compares the verified `newCounter` to the stored
   `counter` **atomically in the mint transaction**: if `storedCounter === 0 && newCounter === 0` the authenticator
   does not use counters (all modern synced passkeys report 0) → **accept**; otherwise require `newCounter >
   storedCounter` and on success persist it. A **regression** (`newCounter <= storedCounter`, both not zero) is a
   possible cloned authenticator → **reject the sign-in generically, mint nothing, change no state** (the
   single-use challenge is already burned; there is no replay-DoS on this path because a replayed old assertion
   fails the challenge lookup *first*). We deliberately do **not** auto-revoke sessions or delete the credential on
   a counter regression (that would be a destructive false-positive response with a DoS-ish blast radius);
   a stricter response (disable-credential / revoke-sessions) is a documented config follow-on, not N1 default.
7. **Passkey auth mints unconditionally through `mintSession`** — it is **not** subject to
   `requireEmailVerification` (possession of the registered passkey is the credential proof, exactly like
   magic-link/OTP/OAuth). It is the A1 chokepoint like every other flow (hashed pair at rest, device label,
   TTLs, reactive revocation).
8. **Registration requires an authenticated caller — including an anonymous one.** The supported passwordless
   *bootstrap* is `signInAnonymously()` → `registerPasskey()`: a brand-new visitor gets a durable passkey bound
   to their (anonymous) user, and later `signInWithPasskey()` mints back into that same account. A **dedicated
   passkey sign-UP that also captures + verifies an email** for a never-before-seen user is **deferred** (it needs
   an identity/email-capture + anti-enumeration story cleaner to settle alongside MFA) — see Non-goals.
9. **Per-user credential limit** (`maxCredentialsPerUser`, default 20), enforced in `_savePasskey`; plus
   `excludeCredentials` at `begin` so an already-registered authenticator can't double-register.
10. **Device management mirrors A1's session management verbatim:** `listPasskeys` (query), `renamePasskey`,
    `revokePasskey` (mutations) — all **authed + ownership-checked**, ranging the **`byUserId` index (never a
    table scan)** so the reactive read-set / OCC conflict range stays scoped to one user's credentials.
    `listPasskeys` **never** returns `publicKey`/`counter` — only `{ passkeyId, deviceName, transports,
    backedUp, createdAt, lastUsedAt }`.
11. **Discoverable AND non-discoverable both ship in N1.** Registration defaults to `residentKey: "preferred"`,
    `userVerification: "preferred"`; authentication supports both the email-scoped (`allowCredentials`) and
    usernameless (empty `allowCredentials`, resolved via `userHandle` = `userId`) begin. Passkeys *are*
    discoverable — usernameless is a first-class N1 path, not a deferral.
12. **Conditional registration** (same discipline as `email`/`oauth`/`jwt`): when `defineAuth({ passkeys })` is
    absent, **none** of the passkey functions are registered — the surface stays exactly A1+A2+A3. A test pins
    the default-inert contract. `rpID` + `rpName` + `origins` are **required** when `passkeys` is present (the
    WebAuthn analogue of `oauth.redirectAllowlist`).
13. **`createAuthClient` is unchanged.** Passkey auth is an ordinary app-driven action pair that yields a
    `MintResult`; the app hands it to `setSession(...)`, exactly as A1 documents for every sign-in. The
    two-round-trip wiring + `@simplewebauthn/browser` usage ships as a documented recipe + the auth-demo, not as
    core-client code.

## Schema (component tables, additive)

```ts
// N1 (this spec). A registered WebAuthn credential. publicKey/counter are the verification material;
// everything else is management metadata. base64url strings (rows are JSON — never raw bytes).
passkeys: defineTable({
  userId: v.id("users"),
  credentialId: v.string(),            // base64url of the raw credential id (== assertion `response.id`)
  publicKey: v.string(),               // base64url of the COSE public key bytes (@simplewebauthn Uint8Array)
  counter: v.number(),                 // signature counter; clone detection (decision 6)
  transports: v.optional(v.array(v.string())),  // ["internal","hybrid","usb","nfc","ble"] — begin hints
  deviceName: v.optional(v.string()),  // user-supplied label ("iPhone", "YubiKey 5")
  backedUp: v.optional(v.boolean()),   // credentialBackedUp (synced/multi-device passkey flag) — display only
  createdAt: v.number(),
  lastUsedAt: v.optional(v.number()),
})
  .index("byCredentialId", ["credentialId"])  // finish-auth lookup by response.id
  .index("byUserId", ["userId"]),             // exclude/allow lists, per-user limit, device mgmt (never a scan)

// N1. Single-use WebAuthn ceremony challenge, TTL ~5min, consume-before-validate. `challenge` is stored
// RECOVERABLE (the documented exception, same as oauthState.codeVerifier): verify* needs it back as
// `expectedChallenge`. Not a bearer credential — useless without the matching authenticator signature.
webauthnChallenge: defineTable({
  challenge: v.string(),               // base64url; the server-issued random challenge
  kind: v.string(),                    // "register" | "authenticate"
  userId: v.optional(v.id("users")),   // register: the authed caller; authenticate(email-scoped): the target
  expiresAt: v.number(),
  createdAt: v.number(),
}).index("byChallenge", ["challenge"]),
```

Uniqueness of `credentialId` is enforced by the application-level guard in `_savePasskey` (relying on
single-writer OCC serialization, the same note `accounts` carries) — a multi-writer engine (Tier 2+) would
need a storage-level unique index. `passkeys` composes with the existing `users`/`accounts`/`sessions` model
unchanged; passkey credentials are **not** `accounts` rows (they carry key material + a counter that
`accounts` has no shape for, and they never participate in the password/email flows) — a first-class table.

## Config surface (extends A1/A2/A3 `defineAuth`)

```ts
defineAuth({
  // ...A1 + A2 + A3 options unchanged,
  passkeys?: {
    rpID: string,                       // the Relying Party ID (effective domain: "example.com" | "localhost")
    rpName: string,                     // human-readable, shown in the authenticator/OS UI
    origins: string[],                  // allowed origins (expectedOrigin allowlist; dev + prod)
    challengeTtlMs?: number,            // default 5 * 60 * 1000
    maxCredentialsPerUser?: number,     // default 20
    userVerification?: "required" | "preferred" | "discouraged",  // default "preferred"
    residentKey?: "required" | "preferred" | "discouraged",       // default "preferred"
  },
})
```

`resolvePasskeyConfig` requires a non-empty `rpID`/`rpName`/`origins` (throws otherwise, like
`resolveOAuthConfig`'s `redirectAllowlist` guard). `origins` are validated with the **same
`assertUrlIsSecure` predicate** A3 reuses (loopback `http://` allowed for dev; non-loopback must be
`https://`) — a plaintext non-loopback origin is a downgrade an attacker could exploit. When `passkeys` is
absent, `AuthConfig.passkeys` is `undefined` and no passkey module is registered (decision 12).

## Component surface

- **Actions** (client-callable over the sync connection):
  `beginPasskeyRegistration({ deviceName? })`, `finishPasskeyRegistration({ response, deviceName? })`,
  `beginPasskeyAuthentication({ email? })`, `finishPasskeyAuthentication({ response })`.
- **Queries/mutations** (client-callable, authed, ownership-checked — mirror A1's session mgmt):
  `listPasskeys()` (query), `renamePasskey({ passkeyId, deviceName })`, `revokePasskey({ passkeyId })`.
- **Internal mutations** (not client-callable, `_`-prefixed, reachable from the actions via `runMutation` —
  the `scheduler:_enqueue` convention): `_storeChallenge` (write the ephemeral row; also resolves + returns
  the authed `userId` for `register`), `_consumeChallenge` (consume-before-validate a challenge by value),
  `_savePasskey` (write the credential; per-user limit + duplicate guard), `_finishPasskeyAuth` (the atomic
  counter-check + `mintSession`).
- **`@simplewebauthn/server` is imported in exactly one module** (`components/auth/src/webauthn.ts`, a thin
  typed wrapper) so the actions call our seam, not the library directly — one place to test, one place a
  future version bump touches (the A3 `oauth.ts` pattern).
- **No new engine seam and no new exports beyond types** — the `PasskeyOptions`/`PasskeyConfig` types are
  exported from `@stackbase/auth`; there are no provider-builder-style exports (unlike A3's `googleProvider`).

## Security / correctness

- **Challenge = CSRF/replay defense**, exactly as A3's `state`: a `finish*` whose `clientDataJSON.challenge`
  doesn't match a live single-use row is rejected; consume-before-validate makes it single-winner under
  single-writer OCC. TTL bounds the window.
- **Origin + RP-ID pinning**: `expectedOrigin` is the configured allowlist and `expectedRPID` is `rpID` —
  `@simplewebauthn` rejects an assertion whose `clientDataJSON.origin` / RP-ID hash doesn't match, which is
  what binds a credential to *our* site (the WebAuthn analogue of the redirect allowlist). Non-loopback
  origins must be `https://`.
- **Signature verification is the trust boundary** — the stored `publicKey` is immutable, so verifying the
  assertion signature in the action (against the key fetched via `runQuery`) has no TOCTOU; only the
  **counter** is mutable, and its monotonic check + update happen **atomically in `_finishPasskeyAuth`'s
  transaction** (decision 6) — the clone-detection guarantee holds under concurrency.
- **`userVerification: "preferred"`/`"required"`** flows through both `generate*` and `verify*`
  (`requireUserVerification` mirrors the configured level) so a deployment that mandates UV (biometric/PIN)
  is enforced at verification, not just requested.
- **Hashed-at-rest invariant preserved**: no raw session token is ever written (the mint happens in
  `_finishPasskeyAuth`, tokens returned directly to the client). The `publicKey` is *public* by definition;
  the `challenge` is the single recoverable-secret exception (decision 4), scoped and bounded.
- **`listPasskeys` never leaks key material** (decision 10). Management ops are ownership-checked; a
  foreign/absent `passkeyId` is a generic reject (like `revokeSession`).
- **DoS/read-set hygiene**: every per-user op ranges `byUserId`; every credential lookup is a `byCredentialId`
  index equality (never a table scan) — same discipline as A1's session indexes.

## Testing

- **Component-level (`@stackbase/test` + the real embedded runtime)** with a **software authenticator helper**
  (`components/auth/test/support/mock-authenticator.ts`, mirroring `mock-oauth-provider.ts`): a WebCrypto
  P-256 keypair that produces valid `none`-attestation registration responses and assertion responses for a
  given `challenge`/`rpID`/`origin` (this is the standard way to exercise WebAuthn without a browser). Cases:
  registration verify happy path; wrong-challenge / wrong-origin / wrong-RP-ID reject; `excludeCredentials`
  double-register reject; per-user limit reject; authentication mint happy path; **usernameless** sign-in via
  `userHandle`; **counter-regression** reject (no mint, no state change); unknown-credential reject;
  **anti-enumeration** (`begin` for an unknown email returns empty-`allowCredentials` options, shape-identical
  to usernameless); `listPasskeys` never returns `publicKey`; ownership on rename/revoke; **conditional
  registration** (passkeys absent → functions unregistered).
- **`webauthn.ts` wrapper unit tests** — the seam's `generate*`/`verify*` pass-through + option shaping,
  driven by the mock authenticator (no network).
- **E2E through the real `stackbase dev` server** (`packages/cli/test/auth-passkeys-e2e.test.ts`,
  `e2e-through-shipped-entrypoint`): a real `@stackbase/client` over a real WebSocket — sign in
  (anonymously) → `beginPasskeyRegistration` → mock authenticator creates → `finishPasskeyRegistration`;
  then a fresh connection `beginPasskeyAuthentication` (usernameless) → mock authenticator asserts →
  `finishPasskeyAuthentication` → `setSession` → a live `whoami` subscription (opened *before*) sees the
  `userId`; plus a counter-regression reject and the reactive fan-out.
- **Bun + Node**: the wrapper + verify path smoke under both runtimes (the lib is pure-JS; `bun run test`
  runs vitest under Node, so the Bun path gets a `bun run` smoke in the auth package, per `tests-run-under-node`).

## Non-goals (N1)

- **Passkey as a second factor (MFA step-up).** Deferred to **N2**. MFA needs an orthogonal policy +
  enforcement layer — a per-user/per-deployment "require second factor" flag, a *pending-elevation* session
  state, `signIn` integration, and a step-up ceremony that **elevates** an existing session rather than
  minting a new one — which is a larger surface than the ceremonies themselves. N1's `passkeys` table +
  `finishPasskeyAuthentication` verification path are exactly the primitives N2 reuses (the step-up variant
  swaps `mintSession` for a session-elevation write). Reserved seam, not built.
- **Attestation-format verification / enterprise attestation / FIDO MDS metadata policy.** N1 is
  `attestationType: "none"` (decision 3). Verifying `packed`/`tpm`/`apple`/… attestation statements and
  gating on authenticator model/AAGUID via the metadata service is a compliance feature for a later slice.
- **Dedicated passkey sign-UP for a never-before-seen user** (create + email-capture + verify in one passkey
  ceremony). N1's bootstrap is `signInAnonymously` → `registerPasskey` (decision 8). The email-capturing
  variant settles alongside MFA/identity work.
- **Conditional UI / autofill (`mediation: "conditional"`) and the browser autofill recipe** — a client-side
  concern (`@simplewebauthn/browser`); documented, not a server feature.
- **`createAuthClient` passkey helpers baked into the core client** — the wiring is a documented recipe + the
  example (decision 13); `@simplewebauthn/browser` stays an app dependency.
- **Cross-device/hybrid (caBLE) transport orchestration** — handled entirely by the platform authenticator;
  we only record `transports` as a `begin` hint.

## Reference implementations consulted

`@simplewebauthn/server` + `@simplewebauthn/browser` docs and the SimpleWebAuthn example server (the
canonical register/authenticate ceremony shapes, `attestationType: "none"`, the counter rule, the software
authenticator test approach). `.reference/better-auth` (MIT) passkey plugin (schema shape — `credentialID`/
`publicKey`/`counter`/`transports`/`backedUp`, the `webauthnChallenge`-equivalent, per-user credential list).
The W3C WebAuthn Level 2/3 spec (the attestation/assertion ceremonies, signature-counter clone-detection
guidance, RP-ID/origin binding). `.reference/convex-auth` has no passkey surface — this is net-new for the
Stackbase auth arc. Adopted: verified library over hand-rolled crypto (the SimpleWebAuthn consensus); the
recoverable-challenge exception (our own A3 `oauthState` precedent); mint-through-the-A1-chokepoint and
A2-parity anti-enumeration (our own arc invariants). Diverged from `better-auth`: no cookies (client-driven
actions over the WebSocket); passkeys as a first-class table, not an `accounts` row.
