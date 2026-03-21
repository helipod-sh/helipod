# Auth slice A3 — external identity (OAuth social login + third-party JWT/OIDC) — implementation plan

For agentic workers: this plan is designed to be executed with the `superpowers:subagent-driven-development` skill — one subagent per task, each task independently spec'd, coded complete (no placeholders), and verified end-to-end before the next begins.

**Goal:** Give `@stackbase/auth` its external-identity surface: social OAuth (Google + GitHub via engine-mounted httpAction callbacks, behind a public provider seam) and a third-party-JWT/OIDC verifier (Clerk / Auth0 / any OIDC issuer). Cookie-free (WebSocket-first), account-linking-safe against the classic pre-registration takeover, minting through A1's single `mintSession` chokepoint and composing with A2's `accounts`/`users` model and the first-mailbox-proof rule. Completes the three-slice auth arc (A1 session core, A2 email flows, A3 external identity).

**Architecture.** OAuth callbacks are **engine-mounted reserved httpActions** reached through a NEW generic *component-contributed-routes* seam (Task 1): a component declares `httpRoutes` (parallel to how it declares `driver`/`boot`), `composeComponents` collects them (parallel to its existing `drivers` collection), the boot core binds each to `runtime.runHttpAction` and hands the server engine-owned `{ method, pathPrefix, handler }` closures — the exact shape the always-on storage routes already use, generalized so an *opt-in composed* component (auth) can contribute reserved `/api/…` routes too. A browser redirect cannot hand a session to a WebSocket client and we refuse cookies, so the callback resolves/links the identity, writes a single-use short-TTL `oauthHandoff` row that **authorizes a mint** (never a stored token), and 302-redirects with an opaque handoff code in the URL **fragment**; the app exchanges the code via a `completeOAuthSignIn` action that **mints then** (raw tokens returned directly, never persisted — A1's hashed-at-rest invariant preserved). Third-party JWTs are verified in a `signInWithIdToken` **action** (jose live JWKS verify — network I/O is legal in an action, illegal in a query), which delegates to an internal provision+mint mutation (JIT-provision as `accounts` `provider:"oidc:<issuer>"`). Both the OAuth callback and `signInWithIdToken` funnel through ONE shared Part-3 resolution mutation (`_resolveExternalIdentity`) implementing the returning / link-while-signed-in / verified-autolink-with-first-proof / unverified-no-autolink matrix.

**Tech Stack.** TypeScript, Bun-primary / Node-supported. `oauth4webapi@3.8.6` (panva, MIT, **zero-dependency**, OpenID-Certified) for the OAuth2/OIDC protocol; `jose@6.2.3` (panva, MIT, **zero-dependency**) for JWKS fetch + JWT verification. Both Fetch-based, run under Bun and Node, pinned EXACT (oauth4webapi does not strictly follow semver). Added as `@stackbase/auth` dependencies. Engine seams touched: `@stackbase/component` (`ComponentDefinition.httpRoutes`), `packages/cli` (`compose` collection, `project`, `boot`, `server`, `serve`, `binary-main`). Component work: `components/auth/src/{schema,config,component,index,oauth,jwt,external}.ts`. E2E through the real `stackbase dev`/`serve` server in `packages/cli/test/auth-external-e2e.test.ts` with a local mock OAuth provider + mock OIDC issuer/JWKS (no live third-party network).

---

## Global Constraints (binding — copied verbatim from the design spec's locked values)

- **Libraries.** `oauth4webapi` + `jose`, both panva, **MIT**, **zero-dependency**, Fetch-based, run under Bun and Node. Pinned to EXACT versions (oauth4webapi does not strictly follow semver). Added as `@stackbase/auth` dependencies. Resolved exact: `oauth4webapi@3.8.6`, `jose@6.2.3` (both confirmed zero-dep against the registry).
- **Cookie-free.** WebSocket-first. No cookies anywhere — state lives in ephemeral DB rows; the session is delivered out of the browser redirect via a one-time handoff code in the URL **fragment**, never a cookie.
- **State hashed-at-rest, with the documented PKCE exception.** `oauthState.stateHash` = SHA-256(state) (we only ever COMPARE state). `oauthHandoff.handoffHash` = SHA-256(handoff). BUT `oauthState.codeVerifier` (and `nonce`) are stored **RECOVERABLE** (not hashed): PKCE requires sending the original verifier to the token endpoint — the server needs the value back, it can't compare a hash. Safe because they are single-use, ~10-min-TTL, server-only transaction secrets, never returned to any client, useless without the matching authorization code (exactly what a PKCE cookie would hold). This is a deliberate, documented exception to hashed-at-rest, scoped to non-credential transaction secrets.
- **The handoff AUTHORIZES A MINT, never stores tokens.** `oauthHandoff` holds NO session token. The mint happens at `completeOAuthSignIn` (raw tokens returned directly to the app, never written to a row) — A1's hashed-at-rest invariant preserved end to end.
- **Consume-before-validate + commitThenThrow on every post-consume throw** (the A2 lesson): at the callback (`_consumeOAuthState`) and the handoff exchange (`_consumeHandoff`), the ephemeral row is DELETED first (consume — single winner under single-writer OCC), THEN validated; EVERY throw after a consume MUST route through `commitThenThrow` so the consume commits even when the call fails.
- **Open-redirect allowlist.** `redirectTo` MUST match `oauth.redirectAllowlist` (exact origin + path-prefix match); a non-allowlisted `redirectTo` is rejected at `/start` BEFORE any state write or redirect.
- **Insecure-http is loopback-derived, never an app flag (spec-amended security requirement).** oauth4webapi's `allowInsecureRequests` is set ONLY for a loopback endpoint (`127.0.0.1`/`localhost`/`::1`), derived from the URL being requested — the public `defineAuth({ oauth })` surface exposes NO "allow insecure" boolean a production deployment could flip. A non-loopback http:// provider endpoint is rejected at config-resolution time (`assertProviderEndpointsSecure`): a plain-http OAuth issuer is a MITM vector — a path attacker could forge the token/id_token. https always fine; loopback http tolerated only for local testing (this is what makes the E2E mock work).
- **Account-linking safety.** Verified-email-required-for-autolink; an unverified external email NEVER autolinks (creates a separate user — that is the exact attack vector); link-while-signed-in is trusted (the caller proved both the session and the external identity); a verified-email link is a **first-mailbox-proof** → `markVerifiedRevokingIfFirstProof` (**flip-gated**: wipes the user's sessions only on the `emailVerified` false→true flip, then sets `emailVerified: true` — this covers every attack case, since the takeover only works against an *unverified* existing account, which is exactly when the flip fires; an already-verified user legitimately adding a second provider has no flip → no wipe → stays signed in on their other devices, better UX and still safe). This is the SAME helper A2 uses (spec amended `44314f9`).
- **Third-party JWT = `signInWithIdToken` ACTION** (jose live JWKS verify — signature + `iss` allowlist + `aud` + `exp`/`nbf`) → internal provision+mint mutation (JIT-provision as `accounts` `provider:"oidc:<issuer>"`; an external identity becomes a first-class local `userId`). **Per-request-stateless-JWT is a NON-GOAL** (fights write-in-query / no-I/O-in-query; the exchange model is the native fit — documented divergence from Convex Auth).
- **Conditional registration.** When `oauth`/`jwt` are absent from `defineAuth`, NONE of the A3 functions/routes are registered — the surface stays EXACTLY A1+A2 (same discipline A2 used for `email`; a test proves it).
- **Generic auth errors — no enumeration.** Code-as-message (A1/A2 convention). Generic auth failures never distinguish sub-cases that could leak account existence (unknown-kid / bad-signature / wrong-aud / expired / state-mismatch / unknown-provider all surface as generic).
- **`ctx.now()` in mutations; actions may use wall-clock/`fetch`.** The mint and all row writes happen in mutations using `ctx.now()` (deterministic). The verify/discovery/token-exchange network I/O and clock reads happen in actions/httpActions where wall-clock is legal.
- **E2E through the real server.** The flagship proof drives `/start → provider → /callback → handoff → completeOAuthSignIn → setSession` and a `signInWithIdToken` round-trip through the actual `startDevServer`, with a live `whoami` subscription seeing the new identity, and the verified-email link revocation fanning out reactively.
- **Reference code.** `.reference/convex-auth` (Apache-2.0) and `.reference/better-auth` (MIT) — **adapt with attribution, never copy FSL**. Adopted: verified-email-required-for-autolink + trusted-link-while-signed-in; provider-registry shape. Diverged: no cookies (ephemeral rows + fragment handoff), exchange-model third-party JWT, first-mailbox-proof session revocation on verified-email link.
- **Rebuild before dependent tests.** Cross-package tests import deps via built `dist/`, not `src/`. After editing a package's `src`, `bun run build` (or `bun run --filter <pkg> build`) before any test that resolves it through `dist/`. Component-internal tests import auth via `../src` (no rebuild needed for those).

---

## Resolved ambiguities (adjudicate before execution)

**(1) The component→boot route-mounting seam — CHOSEN: a new generic component-contributed-routes seam collected by `composeComponents` (parallel to `drivers`), mounted by the boot core, dispatched by the server via the existing engine-owned reserved-route mechanism.**

Why not "follow storage exactly": storage is **always-on** — `packages/cli/src/project.ts` unconditionally injects the `_storage` table and `boot.ts` unconditionally builds `storageRoutes(blobStore, deps)` into `BootResult.storageRoutes`. Auth is **opt-in composed** via `stackbase.config.ts`, so its routes must be *collected from the composed component set*, exactly the way `composeComponents` already collects `drivers`/`bootSteps`/`contextProviders` (`packages/component/src/compose.ts:230-231`). Hardcoding auth's reserved paths in `boot.ts`/`http-handler.ts` (option b's "dispatcher entry") would make core `packages/cli`/`packages/executor` statically know about a component — a design-bug per CLAUDE.md ("Never let the engine know which database it's on" generalizes: the engine never knows a component). An app-mounted helper (option c) is impossible: `http.ts`'s `route()` rejects any `/api/*` or `/_*` path at registration (the reserved-path guard, proven in `http-action-e2e.test.ts`), and it would force every app to hand-wire auth — terrible DX. The chosen seam is the *generic* realization of option (b): the engine stays component-agnostic; auth (and any future component) declares reserved routes. Minimal new surface — one optional field, one collection, one boot closure-build, one server dispatch block. Scoped as **Task 1**, de-risked FIRST with its own wiring test.

Concrete mechanism (exact code in Task 1):
- `ComponentDefinition.httpRoutes?: ComponentHttpRoute[]` where `ComponentHttpRoute = { method: string; pathPrefix: string; handler: string }` — a DECLARATION naming an httpAction in this component's own `modules` (mirrors `ResolvedRoute.handlerPath`), NOT a closure.
- `composeComponents` collects + namespaces → `ComposedProject.componentRoutes: ResolvedComponentRoute[]` (`handlerPath = "<component>:<handler>"`), validating each `pathPrefix` starts with `/api/` or `/_` (reserved — an app `http.ts` can't shadow it) and does not collide with an engine built-in prefix, and that `handler` resolves to a registered httpAction.
- `ProjectArtifacts.componentRoutes` carries it; `bootLoaded` converts each to a runtime-bound `{ method, pathPrefix, handler: (request) => runtime.runHttpAction(handlerPath, request, { identity: bearerFrom(request) }) }` closure → `BootResult.componentRoutes: StorageRoute[]` (reusing the `StorageRoute` `{method,pathPrefix,handler}` shape).
- `server.ts` gains a `componentRoutes?` option + a `matchComponentRoute` dispatch block right after the storage block (Node AND Bun bodies), streaming the `Response` back verbatim — identical to how storage routes dispatch. Component routes are FIXED at boot (the component set is fixed at boot per CLAUDE.md; only functions/schema hot-swap), so — like `storageRoutes` — they need no `setRoutes` live-swap.

**(2) Exact oauth4webapi (v3.8.6) / jose (v6.2.3) API calls.** oauth4webapi 3.x differs materially from the v2-flavored names the spec sketch used — client auth is a **separate `ClientAuth` argument** and the OIDC/OAuth2 response processing is **unified**. The exact calls used:
- Discovery (OIDC): `const as = await oauth.processDiscoveryResponse(issuerUrl, await oauth.discoveryRequest(issuerUrl, opts))` where `issuerUrl = new URL(provider.issuer)`. Cached per issuer in a module Map.
- Non-OIDC (GitHub): build `as` as a literal `{ issuer, authorization_endpoint, token_endpoint }` (no discovery).
- `const client: oauth.Client = { client_id: provider.clientId }`.
- `oauth.generateRandomState()`, `oauth.generateRandomNonce()`, `oauth.generateRandomCodeVerifier()`, `const challenge = await oauth.calculatePKCECodeChallenge(verifier)`.
- Authorize URL is built manually (oauth4webapi ships no builder — the panva examples do the same): `new URL(as.authorization_endpoint!)` + `searchParams.set(response_type=code, client_id, redirect_uri, scope, state, code_challenge, code_challenge_method=S256[, nonce])`.
- Callback: `const params = oauth.validateAuthResponse(as, client, new URLSearchParams(url.search), expectedState)` — throws `AuthorizationResponseError` on provider-error or state mismatch; returns validated params. (In v3 `validateAuthResponse` no longer takes the nonce — nonce validation moved to the next call.)
- Token exchange: `const resp = await oauth.authorizationCodeGrantRequest(as, client, oauth.ClientSecretPost(provider.clientSecret), params, redirectUri, codeVerifier, opts)`.
- Process (unified): `const result = await oauth.processAuthorizationCodeResponse(as, client, resp, { expectedNonce })` — pass `expectedNonce: nonce` for OIDC; omit for OAuth2 (defaults to `oauth.expectNoNonce`). Returns `TokenEndpointResponse` (`access_token`, optional `id_token`).
- OIDC identity: `const claims = oauth.getValidatedIdTokenClaims(result)` → `IDToken | undefined` (`sub`, `email`, `email_verified`, `name`).
- GitHub identity: raw `fetch(provider.userinfoEndpoint, { headers: { authorization: 'Bearer '+result.access_token, accept: 'application/vnd.github+json', 'user-agent': 'stackbase' } })` for `/user`, and `provider.emailsEndpoint` for `/user/emails` (pick `primary && verified`).
- `opts` = `{ [oauth.allowInsecureRequests]: allowInsecureForUrl(<the endpoint being requested>) }` — **DERIVED** from whether the URL being hit is loopback http:// (`127.0.0.1`/`localhost`/`::1`), NOT a config flag. A public http:// provider is **rejected at config-resolution time** (`assertProviderEndpointsSecure`): a plain-http OAuth issuer is a MITM vector — a path attacker could forge the token/id_token. https is always fine. There is deliberately NO app-settable "allow insecure" boolean in the public `defineAuth({ oauth })` surface that a production deployment could flip to weaken itself; the loopback mock in the E2E works purely because its endpoints resolve to `127.0.0.1`.
- jose: `const jwks = createRemoteJWKSet(new URL(jwksUrl))` (in-process cached per issuer in a module Map); `const { payload } = await jwtVerify(idToken, jwks, { issuer, audience })` (validates signature + `iss` + `aud` + `exp`/`nbf`; throws on any failure → caught → generic). Extract `payload.sub/email/email_verified/name`. E2E mock issuer uses jose `generateKeyPair("RS256")`, `exportJWK(publicKey)` (served at the mock `jwks_uri`), and `new SignJWT(claims).setProtectedHeader({alg:"RS256",kid}).setIssuedAt().setIssuer().setAudience().setExpirationTime("5m").sign(privateKey)`.

**(3) E2E mock of a provider + OIDC issuer without live network.** Two plain `http.createServer` instances on `127.0.0.1:0` (loopback, ephemeral ports, closed in `afterAll`); the real `startDevServer` boots `defineAuth({ oauth: { providers: { mock: oauthProvider({ kind:"oidc", issuer: mockUrl, clientId, clientSecret }) }, redirectAllowlist:[...] }, jwt: { issuers:[{ issuer: mockUrl, audience, jwksUrl }] } })` — `mockUrl` is `http://127.0.0.1:<port>`, so insecure-http is auto-allowed by the loopback derivation (no flag). The **mock OIDC provider** serves `/.well-known/openid-configuration` (endpoints point at itself), `/jwks` (`{ keys:[exportJWK(pub)] }`), `POST /token` (returns `{ access_token, id_token, token_type:"bearer" }` where `id_token` is jose-signed), and (GitHub variant) `/user` + `/user/emails`. The **nonce trick** (makes it work without a real browser/authorize step): the test drives `GET /api/auth/oauth/mock/start` with `redirect:"manual"`, reads the 302 `Location` (the authorize URL), parses `state` + `nonce`, sets the mock token endpoint to echo that exact `nonce` (and `aud=clientId`, `iss=mockUrl`, `sub`, `email`, `email_verified:true`) into the id_token it will mint, then drives `GET /api/auth/oauth/mock/callback?code=mockcode&state=<state>` (`redirect:"manual"`) — the server's oauth4webapi POSTs to the mock `/token` over loopback (insecure-http auto-allowed because the endpoint host is `127.0.0.1`), validates the nonce, resolves+links, writes the handoff, and 302s to `redirectTo#code=<handoff>`; the test parses the fragment and calls `client.action(api.auth.completeOAuthSignIn, { handoffCode })` → `MintResult` → `client.setAuth(token)` → the pre-opened `whoami` subscription sees the identity (waitFor). The **third-party-JWT** half needs no provider server: the test mints a JWT with jose (signed by the test keypair whose public JWK the mock `/jwks` serves), calls `client.action(api.auth.signInWithIdToken, { idToken })`, and asserts whoami sees the `oidc:<issuer>` identity; negative cases (wrong-aud / expired / wrong-iss) assert the action rejects generically.

**(4) Minor resolutions.**
- **`accounts.secret` is required `v.string()` — NO schema change.** OAuth/OIDC accounts have no password; they insert `secret: ""` (an empty-string sentinel that `v.string()` accepts and D5 runtime validation passes) plus `failedAttempts: 0, lockedUntil: 0`. Password `signIn` only queries `provider:"password"`, so it never reads an OAuth account's sentinel. This keeps `accounts` additive-safe (no field changes).
- **The verified-email LINK (Part-3 case 3) is FLIP-GATED via `markVerifiedRevokingIfFirstProof` — the SAME helper A2 uses (spec amended `44314f9`).** It wipes the user's sessions ONLY on the `emailVerified` false→true flip, then sets `emailVerified: true`. This covers every attack case: the takeover only works against an *unverified* existing account (an attacker's parked unverified password registration of the victim's email), which is exactly when the flip fires and kills the attacker's sessions. An already-verified user legitimately adding a second provider has no flip → no wipe → they stay signed in on their other devices (better UX, still safe — an already-verified account was already proven to belong to whoever verified it). Because the helper is a closure-local in `makeEmailModules` today, Task 4 **hoists it to module scope in `functions.ts` and exports it** (it closes over nothing — only `ctx` + `user`), so both `makeEmailModules` and `external.ts` share one definition.
- **`oauthState`/`oauthHandoff` tables are ALWAYS present in `authSchema`** (schema is static; conditional registration governs MODULES/ROUTES, not tables — two unused tables on an auth-without-oauth deployment are harmless and additive). Only the functions/routes are conditionally registered.
- **The `/start` and `/callback` "two routes" are backed by ONE httpAction** (`oauthHttp`) mounted at the single prefix `/api/auth/oauth/`, which parses `<provider>/<phase>` from the path suffix — this repo's `matchRoute`/route shape has no named path params (storage's `handleServe` parses its id from the suffix the same way), and a single `/api/auth/oauth/` prefix can't discriminate the `start`-vs-`callback` suffix via prefix matching. Documented as one httpAction backing both logical routes.

---

## Task 1 — Dependencies + the component→boot route-mounting seam (the critical de-risk)

**Deliverable:** `oauth4webapi@3.8.6` + `jose@6.2.3` installed (zero-dep, verified); a composed component can declare `httpRoutes` and have a reserved `/api/…` path dispatch to its httpAction through the real `startDevServer`. No auth logic yet — a throwaway wiring test proves the seam.

### Files
- `components/auth/package.json` (add deps)
- `packages/component/src/define-component.ts` (add `ComponentHttpRoute` + `ComponentDefinition.httpRoutes`)
- `packages/component/src/compose.ts` (collect `componentRoutes`)
- `packages/cli/src/project.ts` (thread `componentRoutes` onto `ProjectArtifacts`)
- `packages/cli/src/boot.ts` (build runtime-bound closures → `BootResult.componentRoutes`)
- `packages/cli/src/server.ts` (dispatch component routes — Node + Bun)
- `packages/cli/src/serve.ts`, `packages/cli/src/binary-main.ts` (pass the option through)
- `packages/cli/test/component-routes-e2e.test.ts` (new wiring test)

### Steps

**1.1 Add deps.** Edit `components/auth/package.json` `dependencies` (keep the existing block, add the two EXACT-pinned entries):
```jsonc
  "dependencies": {
    "@stackbase/component": "workspace:*",
    "@stackbase/errors": "workspace:*",
    "@stackbase/executor": "workspace:*",
    "@stackbase/values": "workspace:*",
    "hash-wasm": "^4.12.0",
    "jose": "6.2.3",
    "oauth4webapi": "3.8.6"
  },
```
Then run `bun install` and **verify zero-dep**: `node -e "for (const p of ['oauth4webapi','jose']) { const d=require(require.resolve(p+'/package.json')).dependencies; if (d && Object.keys(d).length) throw new Error(p+' is not zero-dep'); } console.log('both zero-dep')"`. If the registry returns a newer pin than 3.8.6 / 6.2.3, keep these exact versions (the plan's API calls are pinned to them).

**1.2 `ComponentHttpRoute` + `httpRoutes` field.** In `packages/component/src/define-component.ts`, add the type before `ComponentDefinition` and the field inside it (after `driver?: Driver;`):
```ts
/**
 * A reserved engine HTTP route a component contributes (Task A3-1): `{ method, pathPrefix }` mounted
 * by the boot core at a reserved `/api/…` or `/_…` path (an app `http.ts` may not register these —
 * the reserved-path guard rejects them), dispatching to `handler`, a bare httpAction module name in
 * THIS component's `modules`. Collected by `composeComponents` (parallel to `drivers`) and bound to
 * `runtime.runHttpAction` by the boot core — the generic form of how the always-on storage routes
 * mount, for opt-in composed components. Matched by longest/any prefix ahead of user routes; the
 * handler parses any sub-path (`<provider>/<phase>`) itself, as this repo's routes carry no named
 * params (see `@stackbase/executor`'s `matchRoute`, and storage's `handleServe`).
 */
export interface ComponentHttpRoute {
  method: string;
  pathPrefix: string;
  /** Bare httpAction module name within this component's `modules` (namespaced at compose time). */
  handler: string;
}
```
```ts
  /** A recurring driver, started once after boot; woken by commits and/or timers. */
  driver?: Driver;
  /** Reserved engine HTTP routes this component contributes — see `ComponentHttpRoute`. */
  httpRoutes?: ComponentHttpRoute[];
```
Also add a guard inside `defineComponent(def)` (before `return def;`) so a bad declaration fails fast at authoring time:
```ts
  for (const r of def.httpRoutes ?? []) {
    if (!(r.pathPrefix.startsWith("/api/") || r.pathPrefix.startsWith("/_"))) {
      throw new Error(`component "${def.name}" httpRoute pathPrefix "${r.pathPrefix}" must be a reserved path (start with "/api/" or "/_")`);
    }
    if (!def.modules[r.handler] || def.modules[r.handler]!.type !== "httpAction") {
      throw new Error(`component "${def.name}" httpRoute handler "${r.handler}" must name an httpAction in this component's modules`);
    }
  }
```

**1.3 Collect in `composeComponents`.** In `packages/component/src/compose.ts`: add the resolved type + a field on `ComposedProject`, and collect (parallel to the existing `const drivers = …` line). After the `ComposedProject` interface's `drivers: Driver[];`, add:
```ts
  componentRoutes: ResolvedComponentRoute[];
```
Add the type near the top (after `ComposedProject`'s neighbors, e.g. below `ComposeInput`):
```ts
/** A `ComponentHttpRoute` after compose-time namespacing: `handlerPath` is `"<component>:<handler>"`,
 *  ready for `runtime.runHttpAction` to look up in `moduleMap`. */
export interface ResolvedComponentRoute {
  method: string;
  pathPrefix: string;
  handlerPath: string;
}
```
Import `ComponentHttpRoute` alongside the existing component-type imports at the top of the file (the file already imports from `./define-component`):
```ts
import type { ComponentDefinition, BootContext, Driver, ComponentHttpRoute } from "./define-component";
```
Inside `composeComponents`, right after `const drivers = ordered.filter((c) => c.driver).map((c) => c.driver!);`, add the collection + a reserved-collision guard:
```ts
  const RESERVED_ENGINE_PREFIXES = ["/api/run", "/api/health", "/api/sync", "/api/storage/", "/_admin/", "/_fleet/", "/_dashboard"];
  const componentRoutes: ResolvedComponentRoute[] = [];
  const seenRoutePrefixes = new Set<string>();
  for (const c of ordered) {
    for (const r of c.httpRoutes ?? []) {
      if (RESERVED_ENGINE_PREFIXES.some((p) => r.pathPrefix === p || r.pathPrefix.startsWith(p))) {
        throw new Error(`component "${c.name}" httpRoute "${r.pathPrefix}" collides with a built-in engine prefix`);
      }
      if (seenRoutePrefixes.has(`${r.method} ${r.pathPrefix}`)) {
        throw new Error(`duplicate component httpRoute: ${r.method} ${r.pathPrefix}`);
      }
      seenRoutePrefixes.add(`${r.method} ${r.pathPrefix}`);
      componentRoutes.push({ method: r.method, pathPrefix: r.pathPrefix, handlerPath: `${c.name}:${r.handler}` });
    }
  }
```
Add `componentRoutes` to the returned object literal (alongside `bootSteps, drivers`):
```ts
  return { catalog, moduleMap, componentNames: new Set(ordered.map((c) => c.name)), tableNumbers, contextProviders, policyRegistry, policyProviders, relationRegistry, bootSteps, drivers, componentRoutes };
```

**1.4 Thread onto `ProjectArtifacts`.** In `packages/cli/src/project.ts`: import the resolved type, add the field to `ProjectArtifacts` (after `routes: ResolvedRoute[];`), and set it from `composed.componentRoutes` in the returned artifacts.
- Extend the existing `@stackbase/component` import: `import { composeComponents, type ComponentDefinition, type BootContext, type Driver, type ResolvedComponentRoute } from "@stackbase/component";`
- In `ProjectArtifacts`, after `routes: ResolvedRoute[];` add: `  /** Reserved engine routes contributed by composed components (e.g. auth's `/api/auth/oauth/*`). */\n  componentRoutes: ResolvedComponentRoute[];`
- In the `return { … }` at the end of `loadProject`, add `componentRoutes: composed.componentRoutes,` (next to `routes`). (The `routes` array is already assembled from `http.ts`; `componentRoutes` is the component-contributed set — orthogonal.)

**1.5 Build runtime-bound closures in `boot.ts` → `BootResult.componentRoutes`.** In `packages/cli/src/boot.ts`:
- Add to `BootResult` (after `storageRoutes: StorageRoute[];`):
```ts
  /**
   * Reserved engine routes contributed by composed components (e.g. `@stackbase/auth`'s
   * `/api/auth/oauth/*`), each bound to `runtime.runHttpAction` and shaped as an engine-owned
   * `StorageRoute` `{method,pathPrefix,handler}` so `server.ts` dispatches them exactly like the
   * always-on storage routes. Fixed at boot (the component set is fixed at boot — only functions/
   * schema hot-swap), so no `setRoutes` live-swap is needed. Empty when no component declares routes.
   */
  componentRoutes: StorageRoute[];
```
- In `bootLoaded`, right after `const routes = storageRoutes(blobStore, storageRouteDeps);`, build the component-route closures:
```ts
  // Component-contributed reserved routes (Task A3-1): bind each declared httpAction to the runtime
  // and shape it as an engine-owned `StorageRoute`. The raw `Authorization: Bearer <token>` is passed
  // straight through as `identity` (no resolution — same convention `httpAction`/storage use).
  const bearerOf = (request: Request): string | null => {
    const h = request.headers.get("authorization");
    const m = h ? /^Bearer\s+(.+)$/.exec(h) : null;
    return m ? (m[1] ?? null) : null;
  };
  const componentRoutes: StorageRoute[] = project.componentRoutes.map((r) => ({
    method: r.method,
    pathPrefix: r.pathPrefix,
    handler: (request: Request) => runtime.runHttpAction(r.handlerPath, request, { identity: bearerOf(request) }),
  }));
```
- Add `componentRoutes,` to the `return { … }` object (next to `storageRoutes: routes,`).

**1.6 Dispatch in `server.ts` (Node + Bun).**
- Add a matcher next to `matchStorageRoute` (NOT prefix-gated on storage):
```ts
/** Match an engine-owned component-contributed route (e.g. auth's `/api/auth/oauth/*`) — same
 *  `{method,pathPrefix}` shape as a storage route but not gated to the storage prefix. Dispatched
 *  ahead of user `http.ts` routes and the 404, after the storage routes. */
function matchComponentRoute(routes: StorageRoute[] | undefined, method: string, path: string): StorageRoute | undefined {
  if (!routes) return undefined;
  return routes.find((r) => r.method === method && path.startsWith(r.pathPrefix));
}
```
- Add the option to `DevServerOptions` (after `storageRoutes?`):
```ts
  /** Reserved routes contributed by composed components (e.g. auth's OAuth callbacks). Matched
   *  after storage routes, before user routes. Engine-owned `{method,pathPrefix,handler}` closures. */
  componentRoutes?: StorageRoute[];
```
- **Node body** (`startNodeServer`): right after the storage-route dispatch block (the `if (storageRoute) { … return; }`), add:
```ts
        const componentRoute = matchComponentRoute(options.componentRoutes, req.method ?? "GET", path);
        if (componentRoute) {
          const compHeaders = new Headers(headers);
          if (authorization && !compHeaders.has("authorization")) compHeaders.set("authorization", authorization);
          const request = new Request(`http://${compHeaders.get("host") ?? "localhost"}${rawUrl}`, {
            method: req.method ?? "GET",
            headers: compHeaders,
            ...(needsBody && !isStorageRequest && body !== undefined ? { body } : {}),
          });
          const response = await componentRoute.handler(request);
          const outHeaders: Record<string, string> = {};
          response.headers.forEach((v, k) => { outHeaders[k] = v; });
          res.writeHead(response.status, outHeaders);
          res.end(Buffer.from(await response.arrayBuffer()));
          return;
        }
```
- **Bun body** (`startBunServer` / the `bun.serve` fetch): right after `if (storageRoute) return await storageRoute.handler(req);`, add:
```ts
      const componentRoute = matchComponentRoute(options.componentRoutes, req.method, path);
      if (componentRoute) return await componentRoute.handler(req);
```

**1.7 Pass the option through.**
- `packages/cli/src/binary-main.ts` (dev), in the `startDevServer(boot.runtime, { … })` options, add `componentRoutes: boot.componentRoutes,` next to `storageRoutes: boot.storageRoutes,`.
- `packages/cli/src/serve.ts`, in the `startDevServer(runtime, { … })` options, add `componentRoutes: boot.componentRoutes,` (the serve boot result is in scope as the same `boot`/destructured artifacts used for `storageRoutes`; if serve destructures `storageRoutes` from the boot result, destructure `componentRoutes` the same way and pass it). Match whatever local name serve uses for the boot result.

### Test — `packages/cli/test/component-routes-e2e.test.ts` (new)
Prove the seam through the REAL server with a throwaway component, independent of any auth logic:
```ts
import { describe, it, expect, afterAll } from "vitest";
import { defineSchema } from "@stackbase/values";
import { httpAction } from "@stackbase/executor";
import { defineComponent } from "@stackbase/component";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { loadProject, startDevServer, type DevServer } from "../src/index";

const servers: DevServer[] = [];
afterAll(async () => { for (const s of servers) await s.close(); });

const ping = defineComponent({
  name: "ping",
  schema: defineSchema({}),
  modules: {
    hit: httpAction(async (_ctx, request: Request) => {
      const url = new URL(request.url);
      return new Response(JSON.stringify({ ok: true, tail: url.pathname.slice("/api/ping/".length) }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }),
  },
  httpRoutes: [{ method: "GET", pathPrefix: "/api/ping/", handler: "hit" }],
});

it("mounts a composed component's reserved route through the real server", async () => {
  const project = loadProject({ schema: defineSchema({}), modules: {} }, [ping]);
  expect(project.componentRoutes).toEqual([{ method: "GET", pathPrefix: "/api/ping/", handlerPath: "ping:hit" }]);
  const runtime: EmbeddedRuntime = await createEmbeddedRuntime({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog: project.catalog, modules: project.moduleMap, tableNumbers: project.tableNumbers,
    componentNames: project.componentNames, contextProviders: project.contextProviders,
    bootSteps: project.bootSteps, drivers: project.drivers,
  });
  // Bind the closures exactly as boot.ts does (the test doesn't go through bootLoaded).
  const componentRoutes = project.componentRoutes.map((r) => ({
    method: r.method, pathPrefix: r.pathPrefix,
    handler: (request: Request) => runtime.runHttpAction(r.handlerPath, request, { identity: null }),
  }));
  const server = await startDevServer(runtime, { port: 0, ip: "127.0.0.1", componentRoutes });
  servers.push(server);
  const res = await fetch(`${server.url}/api/ping/hello`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, tail: "hello" });
});

it("rejects a component httpRoute on a non-reserved path at defineComponent time", () => {
  expect(() => defineComponent({ name: "bad", schema: defineSchema({}),
    modules: { h: httpAction(async () => new Response("x")) },
    httpRoutes: [{ method: "GET", pathPrefix: "/hello/", handler: "h" }] })).toThrow(/reserved path/);
});
```

### Verification
`bun run build` (component + cli) then `bun run --filter @stackbase/cli test component-routes-e2e` green; `bun run typecheck` green across `@stackbase/component` + `@stackbase/cli`. This de-risks the one critical open before any auth code.

---

## Task 2 — Config blocks (oauth/jwt) + conditional registration + provider builders

**Deliverable:** `defineAuth({ oauth, jwt })` resolves; `OAuthProvider` type + `googleProvider`/`githubProvider`/`oauthProvider` builders exported; `makeAuthModules` registers A3 modules only when `oauth`/`jwt` present; `defineAuth` contributes the `httpRoutes` declaration only when `oauth` present; a test proves absent→surface stays exactly A1+A2. (Module bodies are filled in Tasks 3–6; this task wires the plumbing + provider registry + conditional gates.)

### Files
- `components/auth/src/oauth.ts` (new — types + builders; protocol helpers land in Task 3/5)
- `components/auth/src/config.ts` (oauth/jwt on `AuthConfig`/`AuthOptions` + resolution)
- `components/auth/src/functions.ts` (conditional registration hook)
- `components/auth/src/component.ts` (`httpRoutes` when oauth present)
- `components/auth/src/index.ts` (exports)
- `components/auth/test/external-config.test.ts` (new)
- `components/auth/test/oauth-providers.test.ts` (new)

### Steps

**2.1 `oauth.ts` — types + builders.** New file `components/auth/src/oauth.ts`:
```ts
/**
 * OAuth provider registry (spec Part 1). A provider config is a plain object so a new provider is a
 * config entry, not a code change — only google + github ship built-in; the seam (`oauthProvider`)
 * is public. `oauth4webapi` protocol wiring lives in the callback/start httpAction (Tasks 3/5); this
 * file is pure config + claim-mapping (unit-testable, no network).
 */

/** The normalized identity both the OAuth callback and `signInWithIdToken` produce and hand to the
 *  shared Part-3 resolution mutation. `emailVerified` is a hard boolean (an unverified/absent email
 *  never autolinks — see `_resolveExternalIdentity`). */
export interface ExternalIdentity {
  accountId: string;   // the provider's stable subject id (google `sub`, github numeric id as string)
  email?: string;
  emailVerified: boolean;
  name?: string;
}

export interface OAuthProvider {
  /** "oidc" → discover endpoints + verify an `id_token`; "oauth2" → explicit endpoints + userinfo. */
  kind: "oidc" | "oauth2";
  /** oidc: the discovery issuer (`.well-known/openid-configuration` is fetched from it). */
  issuer?: string;
  /** oauth2: explicit endpoints (github issues no id_token, has no discovery doc). */
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  userinfoEndpoint?: string;
  emailsEndpoint?: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  /** Map the provider's raw claims (`id_token` claims for oidc; the merged `/user`+`/user/emails`
   *  object for github) to the normalized `ExternalIdentity`. */
  mapClaims: (raw: Record<string, unknown>) => ExternalIdentity;
}

/** Generic builder — the public seam for custom providers (and what the E2E uses with a mock issuer). */
export function oauthProvider(opts: Partial<OAuthProvider> & Pick<OAuthProvider, "kind" | "clientId" | "clientSecret">): OAuthProvider {
  return {
    kind: opts.kind,
    issuer: opts.issuer,
    authorizationEndpoint: opts.authorizationEndpoint,
    tokenEndpoint: opts.tokenEndpoint,
    userinfoEndpoint: opts.userinfoEndpoint,
    emailsEndpoint: opts.emailsEndpoint,
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    scopes: opts.scopes ?? ["openid", "email", "profile"],
    mapClaims:
      opts.mapClaims ??
      ((c) => ({
        accountId: String(c.sub ?? ""),
        email: typeof c.email === "string" ? c.email : undefined,
        emailVerified: c.email_verified === true,
        name: typeof c.name === "string" ? c.name : undefined,
      })),
  };
}

/** Google — an OIDC provider (identity from the verified `id_token`). */
export function googleProvider(opts: { clientId: string; clientSecret: string; scopes?: string[] }): OAuthProvider {
  return oauthProvider({
    kind: "oidc",
    issuer: "https://accounts.google.com",
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    scopes: opts.scopes ?? ["openid", "email", "profile"],
    mapClaims: (c) => ({
      accountId: String(c.sub ?? ""),
      email: typeof c.email === "string" ? c.email : undefined,
      emailVerified: c.email_verified === true,
      name: typeof c.name === "string" ? c.name : undefined,
    }),
  });
}

/** GitHub — a NON-OIDC provider (no id_token): explicit endpoints + a `/user`+`/user/emails` mapper.
 *  `mapClaims` receives the merged object `{ ...user, email, emailVerified }` the callback assembles. */
export function githubProvider(opts: { clientId: string; clientSecret: string; scopes?: string[] }): OAuthProvider {
  return oauthProvider({
    kind: "oauth2",
    authorizationEndpoint: "https://github.com/login/oauth/authorize",
    tokenEndpoint: "https://github.com/login/oauth/access_token",
    userinfoEndpoint: "https://api.github.com/user",
    emailsEndpoint: "https://api.github.com/user/emails",
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    scopes: opts.scopes ?? ["read:user", "user:email"],
    mapClaims: (u) => ({
      accountId: String(u.id ?? ""),
      email: typeof u.email === "string" ? u.email : undefined,
      emailVerified: u.emailVerified === true,
      name: typeof u.name === "string" ? u.name : typeof u.login === "string" ? u.login : undefined,
    }),
  });
}
```

**2.2 `config.ts` — oauth/jwt blocks.** Add resolved + user-facing shapes and fold them into `resolveAuthConfig`.
- Import at top: `import type { OAuthProvider } from "./oauth";` and `import { assertProviderEndpointsSecure } from "./oauth";`
- Add resolved types (after `EmailConfig`):
```ts
/** Resolved OAuth config (defaults applied). Present iff `defineAuth({ oauth })` was passed. There is
 *  NO `allowInsecureRequests` field — insecure-http is derived per-endpoint (loopback-only) at request
 *  time, and a non-loopback http:// provider is rejected in `resolveOAuthConfig`. */
export interface OAuthConfig {
  providers: Record<string, OAuthProvider>;
  redirectAllowlist: string[];
  stateTtlMs: number;
  handoffTtlMs: number;
}
/** Resolved third-party-JWT config. Present iff `defineAuth({ jwt })` was passed. */
export interface JwtConfig {
  issuers: Array<{ issuer: string; audience: string; jwksUrl?: string }>;
}
export interface OAuthOptions {
  providers: Record<string, OAuthProvider>;
  redirectAllowlist: string[];
  stateTtlMs?: number;
  handoffTtlMs?: number;
}
export interface JwtOptions {
  issuers: Array<{ issuer: string; audience: string; jwksUrl?: string }>;
}
```
- Add to `AuthConfig` (after `email?: EmailConfig;`):
```ts
  /** Present iff a project configured `oauth` — absent ⇒ A3 OAuth routes/functions are unregistered. */
  oauth?: OAuthConfig;
  /** Present iff a project configured `jwt` — absent ⇒ `signInWithIdToken` is unregistered. */
  jwt?: JwtConfig;
```
- Widen `AuthOptions`:
```ts
export type AuthOptions = Partial<Omit<AuthConfig, "email" | "oauth" | "jwt">> & {
  email?: EmailOptions;
  oauth?: OAuthOptions;
  jwt?: JwtOptions;
};
```
- Add defaults + resolvers, and extend `resolveAuthConfig`:
```ts
const OAUTH_DEFAULTS = { stateTtlMs: 10 * 60 * 1000, handoffTtlMs: 2 * 60 * 1000 };

function resolveOAuthConfig(opts: OAuthOptions): OAuthConfig {
  if (!opts.redirectAllowlist || opts.redirectAllowlist.length === 0) {
    throw new Error("defineAuth({ oauth }) requires a non-empty redirectAllowlist (open-redirect guard)");
  }
  // Reject a non-loopback http:// provider endpoint at config time (MITM risk on OAuth — a path
  // attacker could forge the token/id_token). https always fine; http tolerated ONLY on loopback
  // (127.0.0.1/localhost/::1). Insecure-http is DERIVED per-endpoint at request time — there is no
  // app-settable flag to weaken this.
  for (const [name, p] of Object.entries(opts.providers)) assertProviderEndpointsSecure(name, p);
  return {
    providers: opts.providers,
    redirectAllowlist: opts.redirectAllowlist,
    stateTtlMs: opts.stateTtlMs ?? OAUTH_DEFAULTS.stateTtlMs,
    handoffTtlMs: opts.handoffTtlMs ?? OAUTH_DEFAULTS.handoffTtlMs,
  };
}
```
Extend the existing `resolveAuthConfig`:
```ts
export function resolveAuthConfig(opts?: AuthOptions): AuthConfig {
  const { email, oauth, jwt, ...rest } = opts ?? {};
  const base: AuthConfig = { ...DEFAULTS, ...rest };
  if (email) base.email = resolveEmailConfig(email);
  if (oauth) base.oauth = resolveOAuthConfig(oauth);
  if (jwt) base.jwt = { issuers: jwt.issuers };
  return base;
}
```

**2.3 Conditional registration hook in `functions.ts`.** Add an import of the (Task-3/5/6) external-module factory and gate it on config. At the top of `functions.ts` add: `import { makeExternalModules } from "./external";` (created in Task 3, initially exporting an empty-conditional factory; Tasks 3/5/6 fill it). Change the tail of `makeAuthModules`:
```ts
  const base = { signUp, signIn, signOut, getUserId, refresh, signInAnonymously, listSessions, revokeSession, revokeOtherSessions };
  let modules: Record<string, RegisteredFunction> = base;
  if (config.email) modules = { ...modules, ...makeEmailModules(config) };   // email absent ⇒ A1's surface
  if (config.oauth || config.jwt) modules = { ...modules, ...makeExternalModules(config) };  // A3 absent ⇒ A1+A2's surface
  return modules;
```
(To keep Task 2 independently green before Tasks 3–6 land, create `external.ts` now with a minimal `makeExternalModules(config: AuthConfig): Record<string, RegisteredFunction> => ({})` stub that Tasks 3/5/6 replace — OR land Task 2 and 3 together. Recommended: land 2+3 together so `makeExternalModules` is real from the first commit. The conditional-registration TEST below asserts the observable contract either way.)

**2.4 `component.ts` — declare `httpRoutes` when oauth present.**
```ts
export function defineAuth(options?: AuthOptions): ComponentDefinition {
  const config = resolveAuthConfig(options);
  return defineComponent({
    name: "auth",
    schema: authSchema,
    modules: makeAuthModules(config),
    context: authContext,
    contextType: { import: "@stackbase/auth", type: "AuthContext" },
    ...(config.oauth ? { httpRoutes: [{ method: "GET", pathPrefix: "/api/auth/oauth/", handler: "oauthHttp" }] } : {}),
  });
}
```

**2.5 `index.ts` — exports.** Add:
```ts
export type { OAuthProvider, ExternalIdentity } from "./oauth";
export { googleProvider, githubProvider, oauthProvider } from "./oauth";
export type { OAuthConfig, JwtConfig, OAuthOptions, JwtOptions } from "./config";
```

### Tests
**`components/auth/test/oauth-providers.test.ts`** — builder shape (pure, no network):
```ts
import { describe, it, expect } from "vitest";
import { googleProvider, githubProvider, oauthProvider } from "../src/oauth";

it("googleProvider is OIDC with the right issuer + default scopes", () => {
  const p = googleProvider({ clientId: "id", clientSecret: "sec" });
  expect(p.kind).toBe("oidc");
  expect(p.issuer).toBe("https://accounts.google.com");
  expect(p.scopes).toEqual(["openid", "email", "profile"]);
  expect(p.mapClaims({ sub: "123", email: "a@b.com", email_verified: true, name: "A" }))
    .toEqual({ accountId: "123", email: "a@b.com", emailVerified: true, name: "A" });
  expect(p.mapClaims({ sub: "123", email: "a@b.com", email_verified: false }).emailVerified).toBe(false);
});

it("githubProvider is oauth2 with explicit endpoints + numeric-id→string mapping", () => {
  const p = githubProvider({ clientId: "id", clientSecret: "sec" });
  expect(p.kind).toBe("oauth2");
  expect(p.authorizationEndpoint).toBe("https://github.com/login/oauth/authorize");
  expect(p.tokenEndpoint).toBe("https://github.com/login/oauth/access_token");
  expect(p.userinfoEndpoint).toBe("https://api.github.com/user");
  expect(p.emailsEndpoint).toBe("https://api.github.com/user/emails");
  expect(p.scopes).toEqual(["read:user", "user:email"]);
  expect(p.mapClaims({ id: 42, login: "octo", email: "o@gh.com", emailVerified: true }))
    .toEqual({ accountId: "42", email: "o@gh.com", emailVerified: true, name: "octo" });
});

it("oauthProvider passes custom overrides through", () => {
  const p = oauthProvider({ kind: "oidc", issuer: "http://localhost:9", clientId: "c", clientSecret: "s", scopes: ["openid"] });
  expect(p.issuer).toBe("http://localhost:9");
  expect(p.scopes).toEqual(["openid"]);
});
```
**`components/auth/test/external-config.test.ts`** — conditional registration + config resolution:
```ts
import { describe, it, expect } from "vitest";
import { defineAuth } from "../src/component";
import { makeAuthModules } from "../src/functions";
import { resolveAuthConfig } from "../src/config";
import { googleProvider, oauthProvider } from "../src/oauth";
import { consoleEmail } from "../src/email/provider";

const A1_KEYS = ["signUp","signIn","signOut","getUserId","refresh","signInAnonymously","listSessions","revokeSession","revokeOtherSessions"].sort();

it("no oauth/jwt ⇒ surface stays exactly A1 (+A2 when email present); no httpRoutes", () => {
  expect(Object.keys(makeAuthModules(resolveAuthConfig())).sort()).toEqual(A1_KEYS);
  expect(defineAuth().httpRoutes).toBeUndefined();
});

it("oauth present ⇒ A3 OAuth modules + the httpRoutes declaration are registered", () => {
  const cfg = resolveAuthConfig({ oauth: { providers: { google: googleProvider({ clientId: "i", clientSecret: "s" }) }, redirectAllowlist: ["http://localhost:5173"] } });
  const keys = Object.keys(makeAuthModules(cfg));
  for (const k of ["oauthHttp", "completeOAuthSignIn", "_startOAuth", "_consumeOAuthState", "_resolveExternalIdentity", "_consumeHandoff"]) expect(keys).toContain(k);
  expect(keys).not.toContain("signInWithIdToken");   // jwt absent
  const comp = defineAuth({ oauth: { providers: { google: googleProvider({ clientId: "i", clientSecret: "s" }) }, redirectAllowlist: ["http://localhost:5173"] } });
  expect(comp.httpRoutes).toEqual([{ method: "GET", pathPrefix: "/api/auth/oauth/", handler: "oauthHttp" }]);
});

it("jwt present ⇒ signInWithIdToken registered (+ shared _resolveExternalIdentity); no OAuth routes", () => {
  const cfg = resolveAuthConfig({ jwt: { issuers: [{ issuer: "https://issuer", audience: "aud" }] } });
  const keys = Object.keys(makeAuthModules(cfg));
  expect(keys).toContain("signInWithIdToken");
  expect(keys).toContain("_resolveExternalIdentity");
  expect(keys).not.toContain("oauthHttp");
  expect(defineAuth({ jwt: { issuers: [{ issuer: "https://issuer", audience: "aud" }] } }).httpRoutes).toBeUndefined();
});

it("oauth without redirectAllowlist throws", () => {
  expect(() => resolveAuthConfig({ oauth: { providers: {}, redirectAllowlist: [] } })).toThrow(/redirectAllowlist/);
});

it("a non-loopback http:// provider endpoint is REJECTED at config time (MITM guard); loopback + https are allowed", () => {
  const allow = ["http://localhost:5173"];
  // Public http:// issuer → refused (a prod app can't weaken itself; there is no allow-insecure flag).
  expect(() => resolveAuthConfig({ oauth: { providers: { bad: oauthProvider({ kind: "oidc", issuer: "http://issuer.example.com", clientId: "i", clientSecret: "s" }) }, redirectAllowlist: allow } }))
    .toThrow(/non-loopback http/);
  // A non-loopback http token endpoint on an oauth2 provider → refused too.
  expect(() => resolveAuthConfig({ oauth: { providers: { bad: oauthProvider({ kind: "oauth2", authorizationEndpoint: "https://ok/authorize", tokenEndpoint: "http://ok/token", clientId: "i", clientSecret: "s" }) }, redirectAllowlist: allow } }))
    .toThrow(/non-loopback http/);
  // Loopback http (local testing) → allowed; https → allowed.
  expect(() => resolveAuthConfig({ oauth: { providers: { local: oauthProvider({ kind: "oidc", issuer: "http://127.0.0.1:8080", clientId: "i", clientSecret: "s" }) }, redirectAllowlist: allow } })).not.toThrow();
  expect(() => resolveAuthConfig({ oauth: { providers: { g: oauthProvider({ kind: "oidc", issuer: "https://accounts.google.com", clientId: "i", clientSecret: "s" }) }, redirectAllowlist: allow } })).not.toThrow();
});
```

### Verification
`bun run --filter @stackbase/auth build && bun run --filter @stackbase/auth test oauth-providers external-config` green; `bun run --filter @stackbase/auth typecheck` green. (Land alongside Task 3 so `makeExternalModules` is real.)

---

## Task 3 — `oauthState` machinery + `/start` (state/PKCE/nonce, allowlist, authorize URL)

**Deliverable:** the `oauthState`/`oauthHandoff` tables; `external.ts` with the `_startOAuth` internal mutation + the `/start` phase of the `oauthHttp` httpAction (generate state/PKCE/nonce, allowlist-check `redirectTo`, write the hashed state row, build the authorize URL via oauth4webapi discovery/explicit endpoints, 302 redirect). Callback/resolve/mint come in Tasks 4–6; this task ends with a working, testable `/start`.

### Files
- `components/auth/src/schema.ts` (two new tables)
- `components/auth/src/oauth.ts` (add protocol helpers: `authorizationServerFor`, `buildAuthorizeUrl`)
- `components/auth/src/external.ts` (new — `makeExternalModules`; this task: `_startOAuth` + `oauthHttp` start branch)
- `components/auth/test/oauth-start.test.ts` (new)

### Steps

**3.1 Schema.** In `components/auth/src/schema.ts`, add inside `defineSchema({ … })` (after `authCodes`):
```ts
  // A3 (spec Part 1). Single-use OAuth CSRF/PKCE state, TTL ~10min. `stateHash` = SHA-256(state)
  // (hashed at rest — we only COMPARE state). `codeVerifier`/`nonce` are stored RECOVERABLE (the
  // documented PKCE exception): PKCE requires re-sending the original verifier to the token endpoint,
  // so a hash won't do — safe as single-use, short-TTL, server-only, never-returned transaction secrets.
  oauthState: defineTable({
    stateHash: v.string(),
    provider: v.string(),
    codeVerifier: v.string(),
    nonce: v.optional(v.string()),
    redirectTo: v.string(),
    linkUserId: v.optional(v.id("users")),
    expiresAt: v.number(),
    createdAt: v.number(),
  }).index("byStateHash", ["stateHash"]),
  // A3 (spec Part 1). Single-use mint AUTHORIZATION (holds NO session token), TTL ~2min. `handoffHash`
  // = SHA-256(handoff). The mint happens in `completeOAuthSignIn` (`_consumeHandoff`), tokens returned
  // directly to the app — A1's hashed-at-rest invariant preserved (no raw token ever written).
  oauthHandoff: defineTable({
    handoffHash: v.string(),
    userId: v.id("users"),
    deviceLabelHint: v.optional(v.string()),
    expiresAt: v.number(),
    createdAt: v.number(),
  }).index("byHandoffHash", ["handoffHash"]),
```

**3.2 `oauth.ts` protocol helpers.** Append to `components/auth/src/oauth.ts`:
```ts
import * as oauth from "oauth4webapi";

/** Per-issuer discovery cache — an OIDC `AuthorizationServer` is fetched once per process. */
const asCache = new Map<string, oauth.AuthorizationServer>();

/** Resolve the `AuthorizationServer` for a provider: OIDC → discovery (cached); oauth2 → an explicit
 *  literal from the provider's endpoints. Insecure-http is DERIVED per-URL (loopback-only) — never a
 *  flag; a public http:// endpoint was already rejected in `resolveOAuthConfig`. */
export async function authorizationServerFor(p: OAuthProvider): Promise<oauth.AuthorizationServer> {
  if (p.kind === "oidc") {
    const key = p.issuer!;
    const cached = asCache.get(key);
    if (cached) return cached;
    const issuerUrl = new URL(p.issuer!);
    const as = await oauth.processDiscoveryResponse(
      issuerUrl,
      await oauth.discoveryRequest(issuerUrl, { [oauth.allowInsecureRequests]: allowInsecureForUrl(p.issuer!) }),
    );
    asCache.set(key, as);
    return as;
  }
  return {
    issuer: p.issuer ?? new URL(p.authorizationEndpoint!).origin,
    authorization_endpoint: p.authorizationEndpoint!,
    token_endpoint: p.tokenEndpoint!,
    ...(p.userinfoEndpoint ? { userinfo_endpoint: p.userinfoEndpoint } : {}),
  };
}

/** True iff `raw` is a loopback http:// URL — the ONLY case oauth4webapi's `allowInsecureRequests` is
 *  set. https:// → false (the flag isn't needed). A public http:// endpoint is rejected upstream by
 *  `assertProviderEndpointsSecure`, so this only ever sees loopback http here. */
export function allowInsecureForUrl(raw: string): boolean {
  let u: URL; try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "http:") return false;
  const h = u.hostname;
  return h === "127.0.0.1" || h === "::1" || h === "[::1]" || h === "localhost";
}

/** Reject a non-loopback http:// (or non-http(s)) provider endpoint at config time — a plain-http OAuth
 *  issuer is a MITM vector (a path attacker could forge the token/id_token). https always fine; http
 *  tolerated only on loopback for local testing. Called by `resolveOAuthConfig` for every provider. */
export function assertProviderEndpointsSecure(name: string, p: OAuthProvider): void {
  const endpoints = [p.issuer, p.authorizationEndpoint, p.tokenEndpoint, p.userinfoEndpoint, p.emailsEndpoint]
    .filter((e): e is string => typeof e === "string" && e.length > 0);
  for (const e of endpoints) {
    let u: URL;
    try { u = new URL(e); } catch { throw new Error(`defineAuth oauth provider "${name}" has an unparseable endpoint: ${e}`); }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new Error(`defineAuth oauth provider "${name}" endpoint must be http(s): ${e}`);
    }
    if (u.protocol === "http:" && !allowInsecureForUrl(e)) {
      throw new Error(`defineAuth oauth provider "${name}" uses a non-loopback http:// endpoint (${e}) — refused (MITM risk on OAuth). Use https://, or a loopback (127.0.0.1/localhost) endpoint for local testing.`);
    }
  }
}

/** Build the provider authorization URL (oauth4webapi ships no builder — construct it, as the panva
 *  examples do). `nonce` only for OIDC. */
export function buildAuthorizeUrl(as: oauth.AuthorizationServer, p: OAuthProvider, args: {
  redirectUri: string; state: string; codeChallenge: string; nonce?: string;
}): string {
  const url = new URL(as.authorization_endpoint!);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", p.clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("scope", p.scopes.join(" "));
  url.searchParams.set("state", args.state);
  url.searchParams.set("code_challenge", args.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (args.nonce) url.searchParams.set("nonce", args.nonce);
  return url.toString();
}

/** Exact origin + path-prefix allowlist match (open-redirect guard). Rejects on any parse failure. */
export function isAllowedRedirect(redirectTo: string, allowlist: string[]): boolean {
  let target: URL;
  try { target = new URL(redirectTo); } catch { return false; }
  return allowlist.some((allowed) => {
    let a: URL;
    try { a = new URL(allowed); } catch { return false; }
    return a.origin === target.origin && target.pathname.startsWith(a.pathname);
  });
}

/** The engine callback URL for a provider — the `redirect_uri` registered with the provider and used
 *  identically at `/start` and token exchange (they MUST match). Derived from the inbound request's
 *  own origin so it works under any host/port without extra config. */
export function callbackUri(requestUrl: string, provider: string): string {
  const u = new URL(requestUrl);
  return `${u.origin}/api/auth/oauth/${provider}/callback`;
}
```

**3.3 `external.ts` — `makeExternalModules`, `_startOAuth`, and the `oauthHttp` start branch.** New file `components/auth/src/external.ts` (Tasks 4–6 extend the SAME file; this task lands the start half + the module wiring):
```ts
import { mutation, action, httpAction, commitThenThrow, type ActionCtx, type MutationCtx, type RegisteredFunction } from "@stackbase/executor";
import type { AuthConfig } from "./config";
import type { OAuthProvider } from "./oauth";
import { authorizationServerFor, buildAuthorizeUrl, isAllowedRedirect, callbackUri } from "./oauth";
import { mintSession, normalizeEmail, resolveSession, markVerifiedRevokingIfFirstProof, type MintResult } from "./functions";
import { generateToken, sha256base64url } from "./crypto";

const GENERIC = "authentication failed"; // no enumeration — every OAuth/JWT failure surfaces as this

/** A tiny 302 helper (browser redirect out of the httpAction). */
function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}
/** A generic error page (no enumeration). Kept text/plain — the browser is mid-redirect flow. */
function fail(status: number): Response {
  return new Response(GENERIC, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

/**
 * Build the A3 external-identity module set (spec "Component surface"). Registered by
 * `makeAuthModules` ONLY when `config.oauth`/`config.jwt` is present (conditional registration). OAuth
 * modules gate on `config.oauth`; `signInWithIdToken` on `config.jwt`; `_resolveExternalIdentity` is
 * shared by both and registered when either is present.
 */
export function makeExternalModules(config: AuthConfig): Record<string, RegisteredFunction> {
  const modules: Record<string, RegisteredFunction> = {};

  // ── Part 3 shared resolution (Task 4) — registered when EITHER oauth or jwt is present ──
  modules._resolveExternalIdentity = resolveExternalIdentityMutation(config);

  if (config.oauth) {
    modules._startOAuth = _startOAuth(config);
    modules._consumeOAuthState = _consumeOAuthStateImpl(config);  // Task 5
    modules._consumeHandoff = _consumeHandoffImpl(config);        // Task 5
    modules.completeOAuthSignIn = completeOAuthSignInImpl();      // Task 5
    modules.oauthHttp = oauthHttp(config);
  }
  if (config.jwt) {
    modules.signInWithIdToken = signInWithIdTokenImpl(config);    // Task 6
  }
  return modules;
}

// ─────────────────────────── OAuth `/start` (Task 3) ───────────────────────────

/** Write the hashed state row (+ recoverable verifier/nonce) and resolve `linkUserId` from the caller's
 *  live session token (link-while-signed-in). Called by the `/start` httpAction. Returns null. */
function _startOAuth(config: AuthConfig) {
  return mutation(async (ctx, args: {
    provider: string; stateHash: string; codeVerifier: string; nonce?: string; redirectTo: string; callerToken?: string;
  }): Promise<null> => {
    const now = ctx.now();
    let linkUserId: string | undefined;
    if (args.callerToken) {
      const session = await resolveSession(ctx.db, args.callerToken);
      if (session && now <= (session.expiresAt as number)) linkUserId = session.userId as string;
    }
    await ctx.db.insert("oauthState", compact({
      stateHash: args.stateHash,
      provider: args.provider,
      codeVerifier: args.codeVerifier,
      nonce: args.nonce,
      redirectTo: args.redirectTo,
      linkUserId,
      expiresAt: now + config.oauth!.stateTtlMs,
      createdAt: now,
    }));
    return null;
  });
}

/** The single httpAction backing both `/api/auth/oauth/:provider/start` and `.../callback` (this repo's
 *  routes carry no named params — it parses `<provider>/<phase>` from the path suffix, like storage's
 *  serve handler). Task 3 wires the `start` phase; Task 5 fills `callback`. */
function oauthHttp(config: AuthConfig) {
  return httpAction(async (ctx, request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const tail = url.pathname.slice("/api/auth/oauth/".length); // "<provider>/<phase>"
    const slash = tail.indexOf("/");
    const provider = slash === -1 ? tail : tail.slice(0, slash);
    const phase = slash === -1 ? "" : tail.slice(slash + 1);
    const p = config.oauth!.providers[provider];
    if (!p) return fail(404);

    if (phase === "start") return oauthStart(ctx as ActionCtx, config, request, url, provider, p);
    if (phase === "callback") return oauthCallbackImpl(ctx as ActionCtx, config, request, url, provider, p); // Task 5
    return fail(404);
  });
}

async function oauthStart(ctx: ActionCtx, config: AuthConfig, request: Request, url: URL, provider: string, p: OAuthProvider): Promise<Response> {
  const redirectTo = url.searchParams.get("redirectTo") ?? "";
  if (!isAllowedRedirect(redirectTo, config.oauth!.redirectAllowlist)) return fail(400); // BEFORE any state write

  const state = oauthRandom.state();
  const codeVerifier = oauthRandom.verifier();
  const codeChallenge = await oauthRandom.challenge(codeVerifier);
  const nonce = p.kind === "oidc" ? oauthRandom.nonce() : undefined;

  const as = await authorizationServerFor(p);
  const redirectUri = callbackUri(request.url, provider);

  const callerToken = bearerOf(request);
  await ctx.runMutation("auth:_startOAuth", {
    provider, stateHash: sha256base64url(state), codeVerifier, ...(nonce ? { nonce } : {}), redirectTo,
    ...(callerToken ? { callerToken } : {}),
  });

  return redirect(buildAuthorizeUrl(as, p, { redirectUri, state, codeChallenge, ...(nonce ? { nonce } : {}) }));
}

// oauth4webapi random helpers, isolated so the callback (Task 5) shares them and tests can stub.
import * as oauth from "oauth4webapi";
const oauthRandom = {
  state: () => oauth.generateRandomState(),
  nonce: () => oauth.generateRandomNonce(),
  verifier: () => oauth.generateRandomCodeVerifier(),
  challenge: (v: string) => oauth.calculatePKCECodeChallenge(v),
};

function bearerOf(request: Request): string | null {
  const h = request.headers.get("authorization");
  const m = h ? /^Bearer\s+(.+)$/.exec(h) : null;
  return m ? (m[1] ?? null) : null;
}

/** Drop `undefined` keys — the syscall codec rejects `undefined` (same as functions.ts's `compact`). */
function compact<T extends Record<string, unknown>>(obj: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(obj)) if (val !== undefined) out[k] = val;
  return out as { [K in keyof T]: Exclude<T[K], undefined> };
}
```
**Import note (deduped at file top when the tasks land together):** `external.ts` has ONE `import * as oauth from "oauth4webapi";` at the top (the snippets above/below repeat it only for locality); Tasks 5/6 add `import { exchangeAndExtractIdentity } from "./oauth";` and `import { verifyIdToken } from "./jwt";` to that same top block.

`makeExternalModules` references `resolveExternalIdentityMutation` (Task 4), `_consumeOAuthStateImpl`/`_consumeHandoffImpl`/`completeOAuthSignInImpl`/`oauthCallbackImpl` (Task 5) and `signInWithIdTokenImpl` (Task 6) — all defined in this same `external.ts`. **Recommended: land 3→4→5→6 as sequential commits in this one file**, so every referenced `*Impl` is real. If Task 3 is committed in isolation, stub the Task-5/6 `*Impl` bodies to `throw new Error("unimplemented")` and register only `_startOAuth`+`oauthHttp` (start-only) — but the tests for those tasks won't pass until their real bodies land.

### Test — `components/auth/test/oauth-start.test.ts`
Component-level via `createTestStackbase` (drives `t.fetch` won't reach engine-mounted routes — so this test drives the `oauthHttp` httpAction directly through `runtime.runHttpAction`, and asserts the state row via a privileged raw-table read):
```ts
import { describe, it, expect, afterEach } from "vitest";
import { defineSchema } from "@stackbase/values";
import { composeComponents } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { defineAuth } from "../src/component";
import { oauthProvider } from "../src/oauth";
import { sha256base64url } from "../src/crypto";

// A mock OIDC discovery server so authorizationServerFor() resolves without live network.
import { createServer, type Server } from "node:http";
let mock: Server; let mockUrl = "";
async function startMock(): Promise<void> {
  mock = createServer((req, res) => {
    if (req.url === "/.well-known/openid-configuration") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ issuer: mockUrl, authorization_endpoint: `${mockUrl}/authorize`, token_endpoint: `${mockUrl}/token`, jwks_uri: `${mockUrl}/jwks` }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
  const a = mock.address(); mockUrl = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
}
afterEach(async () => { await new Promise<void>((r) => mock.close(() => r())); });

it("/start allowlisted ⇒ writes a hashed state row + 302s to the authorize URL with S256 + nonce", async () => {
  await startMock();
  const comp = defineAuth({ oauth: { providers: { mock: oauthProvider({ kind: "oidc", issuer: mockUrl, clientId: "cid", clientSecret: "sec" }) }, redirectAllowlist: ["http://localhost:5173"] } });
  const { catalog, moduleMap, componentNames, contextProviders, tableNumbers } = composeComponents({ schemaJson: defineSchema({}).export(), moduleMap: {} }, [comp]);
  const rt = await EmbeddedRuntime.create({ store: new SqliteDocStore(new NodeSqliteAdapter()), catalog, modules: moduleMap, componentNames, contextProviders, tableNumbers });

  const start = new Request("http://127.0.0.1:1/api/auth/oauth/mock/start?redirectTo=" + encodeURIComponent("http://localhost:5173/app"));
  const res = await rt.runHttpAction("auth:oauthHttp", start, { identity: null });
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get("location")!);
  expect(loc.origin + loc.pathname).toBe(`${mockUrl}/authorize`);
  expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
  expect(loc.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:1/api/auth/oauth/mock/callback");
  const nonce = loc.searchParams.get("nonce"); const state = loc.searchParams.get("state")!;
  expect(nonce).toBeTruthy(); expect(state).toBeTruthy();

  // The state row is hashed at rest; the raw state never appears in a row.
  const rows = await rt.runSystem("_test:allOauthState", {}).then((r: any) => r.value); // register a tiny test-only reader, or read via a privileged run
  // (Assert: exactly one row, stateHash === sha256base64url(state), codeVerifier present + non-empty, nonce stored recoverable.)
  await rt.close?.();
});

it("/start with a non-allowlisted redirectTo ⇒ 400, no state row written", async () => {
  await startMock();
  const comp = defineAuth({ oauth: { providers: { mock: oauthProvider({ kind: "oidc", issuer: mockUrl, clientId: "cid", clientSecret: "sec" }) }, redirectAllowlist: ["http://localhost:5173"] } });
  const { catalog, moduleMap, componentNames, contextProviders, tableNumbers } = composeComponents({ schemaJson: defineSchema({}).export(), moduleMap: {} }, [comp]);
  const rt = await EmbeddedRuntime.create({ store: new SqliteDocStore(new NodeSqliteAdapter()), catalog, modules: moduleMap, componentNames, contextProviders, tableNumbers });
  const res = await rt.runHttpAction("auth:oauthHttp", new Request("http://127.0.0.1:1/api/auth/oauth/mock/start?redirectTo=http://evil.example/x"), { identity: null });
  expect(res.status).toBe(400);
});
```
(For the raw-table assertion, mirror the existing auth tests' `systemModules` test-reader pattern — `auth-reactive.test.ts` registers privileged queries against physical `"auth/<table>"` names. Register `_test:allOauthState` reading `"auth/oauthState"` and assert `stateHash === sha256base64url(state)`, `codeVerifier` non-empty, `nonce` present. The full E2E in Task 7 exercises the same through the real HTTP path.)

### Verification
`bun run --filter @stackbase/auth build && bun run --filter @stackbase/auth test oauth-start` green; typecheck green.

---

## Task 4 — `_resolveExternalIdentity` — the Part-3 account-resolution/linking matrix

**Deliverable:** the shared resolution mutation (returning / link-while-signed-in / verified-autolink-with-first-proof / unverified-no-autolink), consumed by both the OAuth callback (Task 5) and `signInWithIdToken` (Task 6). Fully unit-tested independent of transport.

### Files
- `components/auth/src/functions.ts` (hoist + export `markVerifiedRevokingIfFirstProof`)
- `components/auth/src/external.ts` (replace `resolveExternalIdentityMutation`; import the helper)
- `components/auth/test/external-resolve.test.ts` (new — the full matrix)

### Steps

**4.0 Hoist + export `markVerifiedRevokingIfFirstProof`.** It is currently a closure-local inside `makeEmailModules` (functions.ts ~line 557) but closes over NOTHING — only `ctx` + `user`. Move it verbatim to module scope in `functions.ts` and `export` it (its body is unchanged: wipe the user's `byUserId` sessions only when `user.emailVerified !== true`, then `replace(userId, { ...user, emailVerified: true })`), so both `makeEmailModules` (unchanged call sites) and `external.ts`'s case-3 share ONE definition. Exact signature to preserve:
```ts
export async function markVerifiedRevokingIfFirstProof(ctx: MutationCtx, user: Record<string, unknown>): Promise<void> {
  const userId = user._id as string;
  if (user.emailVerified !== true) {
    for (const s of await ctx.db.query("sessions", "byUserId").eq("userId", userId).collect()) {
      await ctx.db.delete(s._id as string);
    }
  }
  await ctx.db.replace(userId, { ...user, emailVerified: true });
}
```
(`makeEmailModules`'s `verifyEmail`/`signInWithMagicLink`/`signInWithOtp`/`adoptOrCreateThenMint` keep calling `markVerifiedRevokingIfFirstProof(ctx, user)` unchanged — the name now resolves to the module-scope export.) Add `markVerifiedRevokingIfFirstProof` to `index.ts`'s `export { … } from "./functions"` line only if a consumer needs it publicly — it does NOT (external.ts imports from `./functions` directly), so keep it out of the public `index.ts` surface.

**4.1 The resolution mutation.** In `external.ts`, implement (replacing the Task-3 placeholder `resolveExternalIdentityMutation`):
```ts
/** Part-3 shared resolution + linking + (optional) mint, called by the OAuth callback (mint deferred
 *  to the handoff → `outcome:"handoff"`) and by `signInWithIdToken` (mint here → `outcome:"mint"`).
 *  No ephemeral consume happens here, so no commitThenThrow — the consume/validate lives in the
 *  callers (`_consumeOAuthState`/`_consumeHandoff`). */
function resolveExternalIdentityMutation(config: AuthConfig) {
  return mutation(async (ctx, args: {
    provider: string; accountId: string; email?: string; emailVerified: boolean;
    linkUserId?: string; deviceLabel?: string; outcome: "handoff" | "mint"; handoffHash?: string;
  }): Promise<{ userId: string } | MintResult> => {
    const now = ctx.now();
    const userId = await resolveUserId(ctx, args);
    if (args.outcome === "mint") return mintSession(ctx, config, userId, args.deviceLabel);
    // outcome === "handoff": authorize a mint for `userId` (holds NO token); the httpAction has the raw code.
    await ctx.db.insert("oauthHandoff", compact({
      handoffHash: args.handoffHash!, userId,
      deviceLabelHint: args.deviceLabel,
      expiresAt: now + config.oauth!.handoffTtlMs, createdAt: now,
    }));
    return { userId };
  });
}

/** The Part-3 decision tree. Returns the resolved `userId`, performing all link/provision/revoke
 *  writes. Attribution: verified-email-required-for-autolink + trusted-link-while-signed-in adapted
 *  from `.reference/convex-auth` (Apache-2.0) + `.reference/better-auth` (MIT); the flip-gated session
 *  wipe on a verified-email link is A2's first-mailbox-proof rule (the shared `markVerifiedRevokingIfFirstProof`). */
async function resolveUserId(ctx: MutationCtx, args: { provider: string; accountId: string; email?: string; emailVerified: boolean; linkUserId?: string }): Promise<string> {
  // 1) Returning identity — this external account is already bound.
  const [existing] = await ctx.db.query("accounts", "byAccount").eq("provider", args.provider).eq("accountId", args.accountId).collect();
  if (existing) return existing.userId as string;

  // 2) Link-while-signed-in — the caller proved both the session AND the external identity.
  if (args.linkUserId) {
    const u = await ctx.db.get(args.linkUserId);
    if (u) { await insertExternalAccount(ctx, args.linkUserId, args.provider, args.accountId); return args.linkUserId; }
    // stale/invalid linkUserId → fall through to email-based resolution
  }

  const normEmail = args.email ? normalizeEmail(args.email) : undefined;

  // 3) VERIFIED email that matches an existing user — LINK + first-mailbox-proof (FLIP-GATED). Add the
  //    external account, then `markVerifiedRevokingIfFirstProof` (the SAME helper A2 uses): it wipes the
  //    user's sessions ONLY on the emailVerified false→true flip, then sets emailVerified:true. Takeover
  //    defense — a pre-registrant's parked UNVERIFIED account flips here, killing the attacker's parked
  //    sessions; an already-verified user legitimately adding a second provider has NO flip, so their
  //    other-device sessions survive (better UX, still safe: the account was already proven to be theirs).
  if (normEmail && args.emailVerified) {
    const [user] = await ctx.db.query("users", "byEmail").eq("email", normEmail).collect();
    if (user) {
      await insertExternalAccount(ctx, user._id as string, args.provider, args.accountId);
      await markVerifiedRevokingIfFirstProof(ctx, user as Record<string, unknown>);
      return user._id as string;
    }
  }

  // 4) No verified-email match (or unverified / no email) — NEVER auto-link. Create a NEW user.
  const userId = (await ctx.db.insert("users", compact({
    email: normEmail, emailVerified: args.emailVerified === true ? true : undefined,
  }))) as string;
  await insertExternalAccount(ctx, userId, args.provider, args.accountId);
  return userId;
}

/** Insert an external (`google`/`github`/`oidc:<issuer>`) `accounts` row. `secret:""` is an unused
 *  sentinel (accounts.secret is a required v.string(); password signIn only ever queries
 *  provider:"password", so it never reads this) — keeps `accounts` additive with no schema change. */
async function insertExternalAccount(ctx: MutationCtx, userId: string, provider: string, accountId: string): Promise<void> {
  await ctx.db.insert("accounts", { userId, provider, accountId, secret: "", failedAttempts: 0, lockedUntil: 0 });
}
```
(`mintSession`, `normalizeEmail`, `compact`, `MintResult` already imported/defined in `external.ts` from Task 3.)

### Test — `components/auth/test/external-resolve.test.ts`
Drive `_resolveExternalIdentity` directly (privileged run) plus `createTestStackbase` for the authed link-while-signed-in case. Cover all four matrix branches + the takeover scenario. Sketch (mirror `session-core.test.ts` idiom — `createTestStackbase({ modules: {}, components:[defineAuth({ oauth:… , jwt:… })], schema:false })`, `t.mutation("auth:_resolveExternalIdentity", args)`, `t.run(ctx => ctx.db.query("auth/…"))` for raw reads, `t.withIdentity(token)` for the authed caller):
```ts
import { describe, it, expect, afterEach } from "vitest";
import { createTestStackbase, type TestStackbase } from "@stackbase/test";
import { defineAuth, googleProvider, type MintResult } from "../src";

const OAUTH = { oauth: { providers: { google: googleProvider({ clientId: "i", clientSecret: "s" }) }, redirectAllowlist: ["http://localhost:5173"] } };
let t: TestStackbase; afterEach(async () => { await t.close(); });

it("1) returning identity ⇒ mints for the bound user, no new account", async () => {
  t = await createTestStackbase({ modules: {}, components: [defineAuth(OAUTH)], schema: false });
  const a = await t.mutation("auth:_resolveExternalIdentity", { provider: "google", accountId: "sub1", emailVerified: true, email: "x@y.com", outcome: "mint" }) as MintResult;
  const b = await t.mutation("auth:_resolveExternalIdentity", { provider: "google", accountId: "sub1", emailVerified: true, email: "x@y.com", outcome: "mint" }) as MintResult;
  expect(b.userId).toBe(a.userId);
  const accts = await t.run(async (ctx: any) => ctx.db.query("auth/accounts", "byAccount").eq("provider", "google").eq("accountId", "sub1").collect());
  expect(accts.length).toBe(1);
});

it("3) VERIFIED email matching a pre-registered UNVERIFIED password account ⇒ links + REVOKES the pre-registrant's parked sessions (takeover defense)", async () => {
  t = await createTestStackbase({ modules: {}, components: [defineAuth({ ...OAUTH, email: undefined })], schema: false });
  // Attacker pre-registers the victim's email (unverified) and parks a session:
  const parked = await t.mutation("auth:signUp", { email: "victim@corp.com", password: "attacker-pw" }) as MintResult;
  // True owner signs in with a VERIFIED Google identity for the same email:
  const owner = await t.mutation("auth:_resolveExternalIdentity", { provider: "google", accountId: "gsub", emailVerified: true, email: "victim@corp.com", outcome: "mint" }) as MintResult;
  // Same user (linked), the parked session is gone, and emailVerified flipped true.
  const live = await t.query("auth:getUserId", { token: parked.token });
  expect(live).toBeNull();                                   // attacker's parked session revoked
  expect(await t.query("auth:getUserId", { token: owner.token })).toBe(owner.userId);
  const user = await t.run(async (ctx: any) => ctx.db.get(owner.userId));
  expect(user.emailVerified).toBe(true);
});

it("3b) already-verified user linking a second verified provider ⇒ NO flip → the user's other sessions SURVIVE (flip-gated UX pin)", async () => {
  t = await createTestStackbase({ modules: {}, components: [defineAuth(OAUTH)], schema: false });
  // First verified sign-in creates the user + flips emailVerified true (its own session wiped-then-minted).
  const first = await t.mutation("auth:_resolveExternalIdentity", { provider: "google", accountId: "g1", emailVerified: true, email: "u@u.com", outcome: "mint" }) as MintResult;
  expect(await t.query("auth:getUserId", { token: first.token })).toBe(first.userId); // `first` is live (already verified)
  // A SECOND verified provider for the same (now already-verified) user links to the same account with
  // NO emailVerified flip — so `first`'s session is NOT revoked (this is exactly what distinguishes the
  // flip-gated helper from an unconditional wipe).
  const second = await t.mutation("auth:_resolveExternalIdentity", { provider: "oidc:https://clerk", accountId: "c1", emailVerified: true, email: "u@u.com", outcome: "mint" }) as MintResult;
  expect(second.userId).toBe(first.userId);
  expect(await t.query("auth:getUserId", { token: first.token })).toBe(first.userId); // SURVIVES — no flip
  const accts = await t.run(async (ctx: any) => ctx.db.query("auth/accounts", "byAccount").eq("provider", "oidc:https://clerk").eq("accountId", "c1").collect());
  expect(accts.length).toBe(1); // the second provider IS linked
});

it("4) UNVERIFIED external email ⇒ NEVER autolinks; creates a SEPARATE user", async () => {
  t = await createTestStackbase({ modules: {}, components: [defineAuth(OAUTH)], schema: false });
  const pw = await t.mutation("auth:signUp", { email: "shared@x.com", password: "pw123456" }) as MintResult;
  const ext = await t.mutation("auth:_resolveExternalIdentity", { provider: "google", accountId: "g9", emailVerified: false, email: "shared@x.com", outcome: "mint" }) as MintResult;
  expect(ext.userId).not.toBe(pw.userId);                    // separate user — the attack vector is closed
  expect(await t.query("auth:getUserId", { token: pw.token })).toBe(pw.userId); // password session untouched
});

it("2) link-while-signed-in ⇒ attaches to the caller's current user", async () => {
  t = await createTestStackbase({ modules: {}, components: [defineAuth(OAUTH)], schema: false });
  const me = await t.mutation("auth:signInAnonymously", {}) as MintResult;
  const linked = await t.mutation("auth:_resolveExternalIdentity", { provider: "google", accountId: "gme", emailVerified: false, linkUserId: me.userId, outcome: "mint" }) as MintResult;
  expect(linked.userId).toBe(me.userId);
});

it("outcome:handoff writes an oauthHandoff row (hashed) and mints NO session", async () => {
  t = await createTestStackbase({ modules: {}, components: [defineAuth(OAUTH)], schema: false });
  const r = await t.mutation("auth:_resolveExternalIdentity", { provider: "google", accountId: "h1", emailVerified: true, email: "h@h.com", outcome: "handoff", handoffHash: "HASH" }) as { userId: string };
  const rows = await t.run(async (ctx: any) => ctx.db.query("auth/oauthHandoff", "byHandoffHash").eq("handoffHash", "HASH").collect());
  expect(rows.length).toBe(1); expect(rows[0].userId).toBe(r.userId);
  const sessions = await t.run(async (ctx: any) => ctx.db.query("auth/sessions", "byUserId").eq("userId", r.userId).collect());
  expect(sessions.length).toBe(0);   // no mint on the handoff path
});
```

### Verification
`bun run --filter @stackbase/auth build && bun run --filter @stackbase/auth test external-resolve` green. This is the security core — the takeover-defense test (case 3) and the never-autolink test (case 4) are the load-bearing assertions.

---

## Task 5 — `/callback` + token exchange + `oauthHandoff` + `completeOAuthSignIn` (mint-at-exchange)

**Deliverable:** the `callback` phase of `oauthHttp` (consume state, exchange code, extract id_token/userinfo incl. GitHub, resolve via Task 4 with `outcome:"handoff"`, 302 with fragment handoff) + `_consumeOAuthState` + `_consumeHandoff` + the `completeOAuthSignIn` action — the full cookie-free session handoff. Consume-before-validate + commitThenThrow throughout.

### Files
- `components/auth/src/oauth.ts` (add `exchangeAndExtractIdentity`)
- `components/auth/src/external.ts` (replace the Task-3 `*Impl` placeholders for callback/consume/complete)
- `components/auth/test/oauth-callback.test.ts` (new — component-level, with the mock provider)

### Steps

**5.1 `oauth.ts` — token exchange + identity extraction.** Append (this lives in `oauth.ts`, where `ExternalIdentity` and `oauth`/`OAuthProvider` are already in scope — no new import):
```ts
/** Exchange the callback code for tokens and produce the normalized `ExternalIdentity`. OIDC → verify
 *  the id_token (nonce-bound) and map its claims; oauth2 (github) → fetch `/user` + `/user/emails`
 *  with the access token and map the merged object. Throws on any protocol failure (caller → generic). */
export async function exchangeAndExtractIdentity(args: {
  as: oauth.AuthorizationServer; provider: OAuthProvider; params: URLSearchParams;
  redirectUri: string; codeVerifier: string; nonce?: string;
}): Promise<ExternalIdentity> {
  const client: oauth.Client = { client_id: args.provider.clientId };
  const clientAuth = oauth.ClientSecretPost(args.provider.clientSecret);
  const resp = await oauth.authorizationCodeGrantRequest(
    args.as, client, clientAuth, args.params, args.redirectUri, args.codeVerifier,
    { [oauth.allowInsecureRequests]: allowInsecureForUrl(args.as.token_endpoint!) },
  );
  const result = await oauth.processAuthorizationCodeResponse(args.as, client, resp,
    args.nonce ? { expectedNonce: args.nonce } : {});

  if (args.provider.kind === "oidc") {
    const claims = oauth.getValidatedIdTokenClaims(result);
    if (!claims) throw new Error("no id_token");
    return args.provider.mapClaims(claims as unknown as Record<string, unknown>);
  }
  // github (oauth2): fetch /user + /user/emails with the access token.
  const accessToken = result.access_token;
  const ghHeaders = { authorization: `Bearer ${accessToken}`, accept: "application/vnd.github+json", "user-agent": "stackbase" };
  const user = (await (await fetch(args.provider.userinfoEndpoint!, { headers: ghHeaders })).json()) as Record<string, unknown>;
  let email = typeof user.email === "string" ? (user.email as string) : undefined;
  let emailVerified = false;
  if (args.provider.emailsEndpoint) {
    const emails = (await (await fetch(args.provider.emailsEndpoint, { headers: ghHeaders })).json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
    const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
    if (primary) { email = primary.email; emailVerified = true; }
  }
  return args.provider.mapClaims({ ...user, email, emailVerified });
}
```

**5.2 `external.ts` — callback, consume, complete.** Replace the placeholders:
```ts
import { exchangeAndExtractIdentity } from "./oauth";
import * as oauth from "oauth4webapi";

async function oauthCallbackImpl(ctx: ActionCtx, config: AuthConfig, request: Request, url: URL, provider: string, p: OAuthProvider): Promise<Response> {
  const state = url.searchParams.get("state");
  if (!state) return fail(400);

  // Consume-before-validate: `_consumeOAuthState` deletes the row FIRST, then validates provider/expiry
  // (commitThenThrow on any post-consume throw). A miss/mismatch → generic.
  let recovered: { codeVerifier: string; nonce?: string; redirectTo: string; linkUserId?: string };
  try {
    recovered = await ctx.runMutation("auth:_consumeOAuthState", { provider, stateHash: sha256base64url(state) });
  } catch { return fail(400); }

  // Exchange + extract identity. oauth4webapi validates state (validateAuthResponse) + nonce
  // (processAuthorizationCodeResponse). Any protocol failure → generic (no enumeration).
  let identity;
  try {
    const as = await authorizationServerFor(p);
    const client: oauth.Client = { client_id: p.clientId };
    const params = oauth.validateAuthResponse(as, client, url.searchParams, state);
    identity = await exchangeAndExtractIdentity({
      as, provider: p, params, redirectUri: callbackUri(request.url, provider),
      codeVerifier: recovered.codeVerifier, ...(recovered.nonce ? { nonce: recovered.nonce } : {}),
    });
  } catch { return fail(400); }

  // Resolve + link + revoke, and authorize a mint via a fresh handoff (holds NO token).
  const handoff = generateToken();
  await ctx.runMutation("auth:_resolveExternalIdentity", {
    provider, accountId: identity.accountId,
    ...(identity.email ? { email: identity.email } : {}), emailVerified: identity.emailVerified,
    ...(recovered.linkUserId ? { linkUserId: recovered.linkUserId } : {}),
    outcome: "handoff", handoffHash: sha256base64url(handoff),
  });

  // 302 to redirectTo with the one-time handoff in the FRAGMENT (never the query — fragments aren't
  // sent to servers or logged in Referer). Only a one-time code transits; tokens never do.
  const target = new URL(recovered.redirectTo);
  target.hash = `code=${handoff}`;
  return redirect(target.toString());
}

/** Consume-before-validate the state row. Miss → plain throw (nothing consumed). Found → delete
 *  (consume), then validate provider + expiry; any failure after the delete → commitThenThrow so the
 *  consume commits (single-winner under single-writer OCC). */
function _consumeOAuthStateImpl(config: AuthConfig) {
  return mutation(async (ctx, { provider, stateHash }: { provider: string; stateHash: string }): Promise<{ codeVerifier: string; nonce?: string; redirectTo: string; linkUserId?: string }> => {
    const [row] = await ctx.db.query("oauthState", "byStateHash").eq("stateHash", stateHash).collect();
    if (!row) throw new Error(GENERIC);                       // nothing consumed
    await ctx.db.delete(row._id as string);                   // consume
    if ((row.provider as string) !== provider || ctx.now() > (row.expiresAt as number)) return commitThenThrow(GENERIC);
    return {
      codeVerifier: row.codeVerifier as string,
      ...(row.nonce !== undefined ? { nonce: row.nonce as string } : {}),
      redirectTo: row.redirectTo as string,
      ...(row.linkUserId !== undefined ? { linkUserId: row.linkUserId as string } : {}),
    };
  });
}

/** Exchange the handoff for the mint — consume-before-validate, then mint (A1 chokepoint). */
function _consumeHandoffImpl(config: AuthConfig) {
  return mutation(async (ctx, { handoffCode }: { handoffCode: string }): Promise<MintResult | ReturnType<typeof commitThenThrow>> => {
    const handoffHash = sha256base64url(handoffCode);
    const [row] = await ctx.db.query("oauthHandoff", "byHandoffHash").eq("handoffHash", handoffHash).collect();
    if (!row) throw new Error(GENERIC);
    await ctx.db.delete(row._id as string);                   // consume
    if (ctx.now() > (row.expiresAt as number)) return commitThenThrow(GENERIC);
    return mintSession(ctx, config, row.userId as string, row.deviceLabelHint as string | undefined);
  });
}

/** The app calls this after reading `#code=<handoff>` off the redirect fragment. Mints THEN (tokens
 *  returned directly, never stored). */
function completeOAuthSignInImpl() {
  return action(async (ctx, { handoffCode }: { handoffCode: string }): Promise<MintResult> => {
    return (ctx as ActionCtx).runMutation<MintResult>("auth:_consumeHandoff", { handoffCode });
  });
}
```

### Test — `components/auth/test/oauth-callback.test.ts`
Component-level with a full mock OIDC provider (discovery + token + jwks, jose-signed id_token) and the nonce-echo trick, driving `runtime.runHttpAction("auth:oauthHttp", …)` for `/start` then `/callback`, then `completeOAuthSignIn`. (This is the Task-7 E2E in miniature at the component layer; Task 7 repeats it through the real socket server + a live subscription.) Assert: callback 302s to `redirectTo#code=<handoff>`; `completeOAuthSignIn(handoff)` returns a `MintResult`; a second `_consumeHandoff` with the same code throws generic (single-use); a callback with a tampered `state` → 400; a replayed callback (same state) → 400 (consumed). Use jose `generateKeyPair`/`exportJWK`/`SignJWT` for the id_token (see Task 7 for the exact mock-server code — factor it into a shared `test/support/mock-oauth-provider.ts` helper both tests import).

### Verification
`bun run --filter @stackbase/auth build && bun run --filter @stackbase/auth test oauth-callback` green.

---

## Task 6 — `signInWithIdToken` action + jose JWKS verify + JIT-provision

**Deliverable:** `signInWithIdToken(idToken, deviceLabel?)` — jose live JWKS verification against configured issuers → delegate to `_resolveExternalIdentity` (`provider:"oidc:<issuer>"`, `outcome:"mint"`) → `MintResult`. Per-request-stateless-JWT is NOT built (exchange model).

### Files
- `components/auth/src/jwt.ts` (new — jose verify + JWKS cache)
- `components/auth/src/external.ts` (replace `signInWithIdTokenImpl`)
- `components/auth/test/jwt-signin.test.ts` (new)

### Steps

**6.1 `jwt.ts`.**
```ts
/** Third-party JWT verification (spec Part 2). An ACTION verifies the token ONCE (jose live JWKS
 *  fetch + signature/iss/aud/exp/nbf), then delegates to a JIT-provision+mint mutation — a short-lived
 *  third-party token is exchanged once, not presented per request (deliberate divergence from Convex's
 *  per-request-JWT-is-identity model; documented). Per-request stateless JWT is a non-goal. */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { JwtConfig } from "./config";

type Jwks = ReturnType<typeof createRemoteJWKSet>;
const jwksCache = new Map<string, Jwks>();

function jwksFor(issuer: string, jwksUrl: string): Jwks {
  const key = `${issuer}|${jwksUrl}`;
  let j = jwksCache.get(key);
  if (!j) { j = createRemoteJWKSet(new URL(jwksUrl)); jwksCache.set(key, j); }
  return j;
}

/** The verified external identity a third-party JWT yields. */
export interface VerifiedIdToken { issuer: string; sub: string; email?: string; emailVerified: boolean; name?: string }

/** Verify `idToken` against the FIRST configured issuer whose `iss` + `aud` + signature match. Throws
 *  (generic to the caller) on any failure. `jwksUrl` defaults to `${issuer}/.well-known/jwks.json`. */
export async function verifyIdToken(idToken: string, config: JwtConfig): Promise<VerifiedIdToken> {
  let lastErr: unknown;
  for (const cfg of config.issuers) {
    const jwksUrl = cfg.jwksUrl ?? new URL("/.well-known/jwks.json", cfg.issuer).toString();
    try {
      const { payload } = await jwtVerify(idToken, jwksFor(cfg.issuer, jwksUrl), { issuer: cfg.issuer, audience: cfg.audience });
      return {
        issuer: cfg.issuer,
        sub: String(payload.sub ?? ""),
        email: typeof payload.email === "string" ? payload.email : undefined,
        emailVerified: (payload as JWTPayload & { email_verified?: unknown }).email_verified === true,
        name: typeof (payload as { name?: unknown }).name === "string" ? (payload as { name: string }).name : undefined,
      };
    } catch (e) { lastErr = e; }
  }
  throw new Error(String(lastErr ?? "invalid token"));
}
```

**6.2 `external.ts` — the action.**
```ts
import { verifyIdToken } from "./jwt";

function signInWithIdTokenImpl(config: AuthConfig) {
  return action(async (ctx, { idToken, deviceLabel }: { idToken: string; deviceLabel?: string }): Promise<MintResult> => {
    let v;
    try { v = await verifyIdToken(idToken, config.jwt!); }
    catch { throw new Error(GENERIC); }                         // generic — no unknown-kid/expired/aud distinction
    if (!v.sub) throw new Error(GENERIC);
    return (ctx as ActionCtx).runMutation<MintResult>("auth:_resolveExternalIdentity", {
      provider: `oidc:${v.issuer}`, accountId: v.sub,
      ...(v.email ? { email: v.email } : {}), emailVerified: v.emailVerified,
      ...(deviceLabel ? { deviceLabel } : {}), outcome: "mint",
    });
  });
}
```

### Test — `components/auth/test/jwt-signin.test.ts`
Local jose keypair + a mock `/jwks` http server; drive `signInWithIdToken` through `runtime.runAction("auth:signInWithIdToken", …)` and assert via `getUserId`/raw reads:
```ts
import { describe, it, expect, afterEach } from "vitest";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { createServer, type Server } from "node:http";
import { composeComponents } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { defineSchema } from "@stackbase/values";
import { defineAuth, type MintResult } from "../src";

let mock: Server; let mockUrl = ""; let priv: CryptoKey; const KID = "test-key";
async function startIssuer() {
  const { publicKey, privateKey } = await generateKeyPair("RS256"); priv = privateKey;
  const jwk = { ...(await exportJWK(publicKey)), kid: KID, alg: "RS256", use: "sig" };
  mock = createServer((req, res) => {
    if (req.url === "/.well-known/jwks.json") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ keys: [jwk] })); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
  const a = mock.address(); mockUrl = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
}
afterEach(async () => { await new Promise<void>((r) => mock.close(() => r())); });

async function mint(claims: { sub: string; email?: string; email_verified?: boolean }, over: { iss?: string; aud?: string; exp?: string } = {}) {
  return new SignJWT({ ...claims }).setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuedAt().setIssuer(over.iss ?? mockUrl).setAudience(over.aud ?? "stackbase").setExpirationTime(over.exp ?? "5m").sign(priv);
}
async function runtime() {
  await startIssuer();
  const comp = defineAuth({ jwt: { issuers: [{ issuer: mockUrl, audience: "stackbase" }] } });
  const { catalog, moduleMap, componentNames, contextProviders, tableNumbers } = composeComponents({ schemaJson: defineSchema({}).export(), moduleMap: {} }, [comp]);
  return EmbeddedRuntime.create({ store: new SqliteDocStore(new NodeSqliteAdapter()), catalog, modules: moduleMap, componentNames, contextProviders, tableNumbers });
}

it("valid third-party JWT ⇒ JIT-provisions oidc:<issuer> + mints; second sight reuses the user", async () => {
  const rt = await runtime();
  const jwt = await mint({ sub: "u1", email: "u@ext.com", email_verified: true });
  const a = (await rt.runAction("auth:signInWithIdToken", { idToken: jwt })).value as MintResult;
  expect(await rt.run("auth:getUserId", { token: a.token }).then((r: any) => r.value)).toBe(a.userId);
  const b = (await rt.runAction("auth:signInWithIdToken", { idToken: await mint({ sub: "u1", email: "u@ext.com", email_verified: true }) })).value as MintResult;
  expect(b.userId).toBe(a.userId);   // same account, byAccount hit
});

it("wrong aud / expired / wrong iss ⇒ generic rejection (no enumeration)", async () => {
  const rt = await runtime();
  await expect(rt.runAction("auth:signInWithIdToken", { idToken: await mint({ sub: "x" }, { aud: "other" }) })).rejects.toThrow(/authentication failed/);
  await expect(rt.runAction("auth:signInWithIdToken", { idToken: await mint({ sub: "x" }, { exp: "-1s" }) })).rejects.toThrow(/authentication failed/);
  await expect(rt.runAction("auth:signInWithIdToken", { idToken: await mint({ sub: "x" }, { iss: "https://evil" }) })).rejects.toThrow(/authentication failed/);
});
```

### Verification
`bun run --filter @stackbase/auth build && bun run --filter @stackbase/auth test jwt-signin` green; full `bun run --filter @stackbase/auth test` green.

---

## Task 7 — E2E through the real server (mock provider + mock issuer/JWKS) + auth-demo

**Deliverable:** `packages/cli/test/auth-external-e2e.test.ts` drives the whole social + JWT flows through the actual `startDevServer` with a live `whoami` subscription; a shared mock-provider helper; auth-demo gains Google/GitHub buttons + a third-party-token example.

### Files
- `packages/cli/test/support/mock-oauth-provider.ts` (new — reusable mock)
- `packages/cli/test/auth-external-e2e.test.ts` (new)
- `examples/auth-demo/stackbase.config.ts` (add oauth/jwt to `defineAuth`)
- `examples/auth-demo/web/main.tsx` (Google/GitHub buttons + handoff-fragment handler + third-party-token example)

### Steps

**7.1 Mock provider helper** — `packages/cli/test/support/mock-oauth-provider.ts`: a `node:http` server exposing `/.well-known/openid-configuration`, `/jwks`, `POST /token`, `/user`, `/user/emails`, plus a jose keypair and helpers `signIdToken(claims)`/`setNextToken({ nonce, sub, email, emailVerified })`. The `/token` handler returns `{ access_token:"gh-access", id_token: <signed with the pending nonce>, token_type:"bearer" }` for OIDC and `{ access_token:"gh-access", token_type:"bearer" }` for the github variant. Export `{ url, jwksUrl, signIdToken, setNextToken, close }`.

**7.2 E2E** — boot via the `auth-session-e2e.test.ts` idiom (`loadProject([defineAuth({ oauth, jwt })])` → `createEmbeddedRuntime` → `startDevServer({ port:0 })`, **passing `componentRoutes`** built exactly as `boot.ts` does — see Task 1's test for the closure). A `whoami` app query (`ctx.auth.getUserId()`) subscribed over a `StackbaseClient(webSocketTransport(wsUrl))`. Flow:
```
1. res = await fetch(`${server.url}/api/auth/oauth/mock/start?redirectTo=${enc("http://localhost:5173/app")}`, { redirect: "manual" });
   loc = new URL(res.headers.get("location")); state = loc.searchParams.get("state"); nonce = loc.searchParams.get("nonce");
2. mock.setNextToken({ nonce, sub: "gsub", email: "e2e@ext.com", emailVerified: true });
3. cb = await fetch(`${server.url}/api/auth/oauth/mock/callback?code=mockcode&state=${state}`, { redirect: "manual" });
   handoff = new URL(cb.headers.get("location")).hash.replace(/^#code=/, "");
4. mintResult = await client.action(api.auth.completeOAuthSignIn, { handoffCode: handoff });
   client.setAuth(mintResult.token);
5. await waitFor(() => seen.at(-1) === mintResult.userId);   // whoami subscription sees the new identity
```
Plus assertions: a second `completeOAuthSignIn(handoff)` rejects (single-use); a tampered `state` → callback 400; the **verified-email link revocation fans out reactively** (pre-register a password user + open a session/subscription, run the OAuth flow for the same verified email, assert the password session's subscription flips to `null`); and the **`signInWithIdToken` round-trip** (mint a JWT with the mock's `signIdToken`, `client.action(api.auth.signInWithIdToken, { idToken })`, assert whoami). Close the mock + server in `afterAll`.

**7.3 auth-demo config** — extend `examples/auth-demo/stackbase.config.ts`'s `defineAuth({ … })` with:
```ts
  oauth: {
    providers: {
      google: googleProvider({ clientId: process.env.GOOGLE_CLIENT_ID ?? "", clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "" }),
      github: githubProvider({ clientId: process.env.GITHUB_CLIENT_ID ?? "", clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "" }),
    },
    redirectAllowlist: ["http://localhost:5173"],
  },
  jwt: { issuers: [{ issuer: process.env.OIDC_ISSUER ?? "https://example.clerk.accounts.dev", audience: process.env.OIDC_AUDIENCE ?? "stackbase" }] },
```
(import `googleProvider`/`githubProvider` from `@stackbase/auth`.)

**7.4 auth-demo web** — in `examples/auth-demo/web/main.tsx`: add "Sign in with Google"/"Sign in with GitHub" buttons that do `window.location.href = \`${serverOrigin}/api/auth/oauth/${provider}/start?redirectTo=${encodeURIComponent(location.origin + location.pathname)}\``; on load, read `#code=<handoff>` off `location.hash`, and if present call `useAction(api.auth.completeOAuthSignIn)({ handoffCode })` → `authClient.setSession(result)` → clear the hash. Add a small "Sign in with a third-party token" textarea calling `useAction(api.auth.signInWithIdToken)({ idToken })` → `authClient.setSession(result)`. (Follow the existing `adopt()`/`useAction` wiring in `main.tsx`.)

### Verification
`bun run build` then `bun run --filter @stackbase/cli test auth-external-e2e` green; the auth-demo `test/` suite still green; manual: `bun run --filter auth-demo dev`, click a provider button (with real creds) or drive the JWT box. E2E must pass through the REAL socket server (memory rule: cross-package features need a test through the real CLI server, not just mechanism unit tests).

---

## Task 8 — Docs + surface sweep

**Deliverable:** `docs/enduser/build/auth.md` gains a real "External identity" section (replacing the roadmap note — finally making the JWKS/OIDC note TRUE); `components/auth/README.md` moves OAuth + third-party-JWT from limitation to shipped; a final `index.ts` export sweep.

### Files
- `docs/enduser/build/auth.md`
- `components/auth/README.md`
- `components/auth/src/index.ts` (final sweep)

### Steps

**8.1 `auth.md`.** REPLACE the `## Roadmap — external identity (not yet shipped)` section (the exact current text: "Third-party identity providers (OAuth) and JWT/JWKS/OIDC token verification … not implemented today. … This page will be updated as that ships.") with a `## External identity` section covering: OAuth setup (the `googleProvider`/`githubProvider`/`oauthProvider` builders, credentials, the required `redirectAllowlist`, the engine-mounted `/api/auth/oauth/:provider/{start,callback}` routes, the fragment-handoff flow + `completeOAuthSignIn`), the third-party-JWT setup (`jwt.issuers`, `signInWithIdToken`, the exchange-not-per-request model + WHY it diverges from Convex — session-centric, reactive revocation, real local `userId`), the account-linking safety rules (verified-required-for-autolink, unverified-never-autolinks, link-while-signed-in, verified-link = first-mailbox-proof → session revocation), and a security table (state CSRF, PKCE, nonce, open-redirect allowlist, hashed-at-rest with the PKCE-verifier exception, no-token-in-URL, consume-before-validate).

**8.2 `README.md`.** Move known-limitation item 4 ("External identity (OAuth, JWKS/OIDC) is not implemented") into the shipped-features list: OAuth (Google + GitHub + custom via the provider seam), engine-mounted cookie-free callbacks + fragment handoff, third-party-JWT/OIDC verification via `signInWithIdToken`, the account-linking/takeover-defense rules. The arc (A1+A2+A3) is complete.

**8.3 `index.ts` sweep.** Ensure the public surface exports everything a consumer needs and nothing internal: `googleProvider`/`githubProvider`/`oauthProvider`, `OAuthProvider`/`ExternalIdentity`, `OAuthConfig`/`JwtConfig`/`OAuthOptions`/`JwtOptions`. Do NOT export `makeExternalModules`, `verifyIdToken`, `_*` internal mutations, or the protocol helpers.

### Verification
`bun run --filter @stackbase/auth build && bun run --filter @stackbase/auth typecheck` green; docs read-through confirms the roadmap note is gone and every documented symbol is exported; `bun run build && bun run test` green across the workspace.

---

## Task dependency order

T1 (seam — de-risk first) → T2 (+T3 recommended together: config/providers + start) → T3 → T4 (resolution matrix — pure, the security core) → T5 (callback+handoff, depends on T4) → T6 (JWT signin, depends on T4) → T7 (E2E, depends on T1+T5+T6) → T8 (docs). T4 is deliberately BEFORE T5/T6 (both consume `_resolveExternalIdentity`) — a reorder from the spec's suggested T4=callback/T5=resolve boundaries, so every task ends with a runnable, independently-testable artifact and the shared resolution is proven before either transport wires to it.

## Reference implementations consulted
`.reference/convex-auth` (Apache-2.0), `.reference/better-auth` (MIT). Adopted (with attribution, never copied): verified-email-required-for-autolink + trusted-link-while-signed-in (the takeover defense both converge on); provider-registry shape. Diverged: no cookies (ephemeral rows + fragment handoff), exchange-model third-party JWT (vs Convex per-request), first-mailbox-proof session revocation on verified-email link (stronger than either reference, consistent with our A1/A2 credential-boundary rule).
