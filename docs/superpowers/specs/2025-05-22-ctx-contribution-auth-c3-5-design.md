# C3.5 — `ctx`-Contribution + Ambient Identity (+ Auth Security Floor) Design

**Status:** Approved design (decided via a CTO-vs-Senior-Dev adversarial debate, 2025-05-22). Supersedes the open decision §12.1 of the component-system design.

## 1. Goal

Make the `auth` component (and every future component) *usable by app code*: an app function calls `ctx.auth.getUserId()` with no token threading, and a protected query **re-runs when its session changes** — cross-namespace reactivity. Fold the auth **security floor** in, because for an auth component "security best-practice" is the deliverable, not a follow-up.

This builds on the live component boundary (C0–C3): components already run namespace-isolated; this slice adds the *one sanctioned cross-namespace path* — a component contributes a read-only facade to `ctx`.

## 2. Decisions (from the debate)

| # | Decision | Rationale |
|---|---|---|
| A | **Ambient identity** — session token rides in the per-request execution context, resolved to `userId` at the engine boundary; never exposed raw to app code | Convex-grade DX; the token stays out of args/read-sets/logs |
| B | **General context-provider hook now; public API deferred** — build the general registry mechanism (auth is its first *user*, not a kernel special-case); defer the public, semver-frozen `defineComponent({ context })` surface until a 2nd consumer (cron/authz) | The component ABI is the seam third-party code binds to — a late change is a coordinated breaking release. But ordering/lifecycle can't be designed well with one consumer |
| C | **Defer typed codegen** — ship the runtime mechanism + hand-written stopgap types | Pure DX layer on a stable runtime; no one-way door |
| D1 | **Password hashing → argon2id via `hash-wasm`** (~19 MiB, t=3, p=1); keep scrypt-verify as a fallback with rehash-on-login | `hash-wasm` is pure WASM (Node + Bun, no node-gyp, embeds in `bun build --compile`) — removes the only argument for scrypt; argon2id wins on merit |
| D2 | **Opaque server-side tokens** (reject JWT) | The `sessions` table is a free revocation list — revoke = delete a row |
| D3 | **Transport: two modes, secure default per client class** — browser: `httpOnly + Secure + SameSite=Lax` cookie + double-submit CSRF token for mutations; native/server: in-memory bearer header | httpOnly is defense-in-depth against the app's own XSS; bearer is CSRF-immune by construction |
| D4 | **Absolute expiry only (~30d), stamped from the commit timestamp, lazy-checked on resolve** | **Sliding/idle expiry needs to write `lastSeenAt`, but `getUserId` runs inside read-only queries which cannot write — so idle expiry is deferred** (needs a `touchSession` mutation or Actions) |
| D5 | **Anti-enumeration** — generic `invalid credentials` (done) + constant-time/generic signup-duplicate path | |
| D6 | **Brute-force** — free in-transaction per-account failed-attempt counter now; robust windowed/per-IP limiting deferred (becomes a `ratelimit` component that dogfoods this hook) | |
| D7 | **Uniqueness** — pin the single-writer assumption with a test + loud comment now (done in C3); DB-level unique index on `accounts(provider,accountId)` in the adapter contract before Tier-2 | |

## 3. Architecture

### 3.1 Ambient identity

`RunOptions.identity?: string` → `KernelContext.identity` (the raw session token), set by the runtime from what the sync/HTTP layer extracts (cookie or bearer). Same per-request threading pattern as C2's `namespace`/`privileged`. The token is **resolved at the boundary** — `ctx.auth.getUserId()` returns a `userId`; app code never sees the raw token.

### 3.2 The context-provider hook (the crux)

The mechanic: a component contributes a read-only facade that executes **in its own namespace** but **shares the calling function's transaction** (so its reads land in the caller's read-set → reactivity).

- `ComponentDefinition` gains `context?: (cctx: ComponentContext) => Record<string, unknown>`, where `ComponentContext = { db: ReadonlyDb; identity: string | null }` and `db` is scoped to the component's namespace.
- The **executor**, inside `run()` (where the txn exists), builds — for each enabled context-providing component — a read-only `GuestDatabaseReader` over a `KernelContext` at the component's namespace **sharing the same `txn`/`catalog`/`queryRuntime`/`snapshotTs`** as the running function. It calls `component.context({ db: reader, identity })` and attaches the result as `ctx[component.name]`.
- **Eager attach, lazy read:** building the facade just constructs a closure object; the actual cross-namespace read happens only when the app calls e.g. `ctx.auth.getUserId()`. So unused facades cost ~nothing.
- **Internal seam, designed deliberately** (cheap-now/breaking-later questions answered): duplicate context key **throws** at registration; keys are **reserved-validated** so a plugin can't shadow `ctx.db`/`ctx.auth`; the facade object is **frozen**. **Ordering and lifecycle are deferred** (only answerable with a 2nd consumer), and the public `defineComponent({ context })` API is **not exported/documented** until then — auth uses the same internal hook everyone will.

### 3.3 Auth uses it

```ts
// @stackbase/auth
defineComponent({
  name: "auth",
  context: (cctx) => ({
    getUserId: async (): Promise<string | null> => resolveSession(cctx.db, cctx.identity),
  }),
  // ...schema, modules (signUp/signIn/signOut)
});
```
`resolveSession` is the C3 `getUserId` logic, now reading the ambient `cctx.identity` instead of a token arg, plus the absolute-expiry check (D4).

### 3.4 Cross-component reactivity (free)

Because the facade's read of `auth/sessions` goes through the **caller's** txn, the caller's read-set already contains auth's `sessions` table-id. The existing table-id invalidation re-runs the protected query when the session row changes (e.g. `signOut` deletes it). **Zero new reactivity plumbing** — we're declining to break the existing mechanism, not adding a feature.

### 3.5 Boundary integrity

Facades are the **only** sanctioned cross-namespace path, and v1 facades are **read-only** (a `ReadonlyDb` — no insert/replace/delete). A component still cannot *name* another's table via its own `ctx.db`. Write-contributing facades (e.g. an audit component) + `grants` are a later concern. The facade is the component's own trusted code (in-process now; its own isolate later) — the same trusted-now/sandbox-ready seam.

## 4. Security posture (decided — see §2 D1–D7 for the calls)

Key non-obvious points:
- **Hashing belongs in an Action at scale.** argon2id (like scrypt) blocks the single-writer event loop for tens of ms inside `signUp`/`signIn`. Acceptable for dev/self-host; the real fix is moving the hash to an Action (deferred slice). Document it; don't surprise anyone.
- **Expiry is absolute-only because queries can't write** (D4). `expiresAt = commitTs + 30d` written once at signIn; `resolveSession` rejects when the request's injected `now > expiresAt`. No write on the read path.
- **The request's `now`** comes from the engine (the transactor's clock / request envelope), never from inside a deterministic UDF — determinism preserved.

## 5. Build order (this spec decomposes into focused plans)

Each is its own plan + working slice; build in order.

- **C3.5a — Engine mechanism** *(load-bearing, first)*: `RunOptions.identity` + `KernelContext.identity`; the context-provider hook in the executor (namespace-scoped read-only reader sharing the txn); `ComponentDefinition.context`; the runtime threads identity + enabled providers; **the integration test that proves cross-namespace reactivity** (protected query re-runs on signOut). Auth gets a minimal `context` builder. *This is the slice that makes auth usable.*
- **C3.5b — Auth security upgrade**: argon2id via `hash-wasm` (scrypt-verify fallback + rehash-on-login); absolute expiry (`expiresAt`); per-account failed-attempt counter + lockout; constant-time signup-duplicate path.
- **C3.5c — Client transport + identity extraction**: client SDK `setAuth(token)`; the dev-server/sync layer extracts the token (cookie or bearer) into `RunOptions.identity`; httpOnly+SameSite cookie default + double-submit CSRF for mutations; bearer mode for native.

## 6. Deferred (explicitly out of scope; no one-way door)

Typed codegen (`ctx.auth: AuthContext`, `api.auth.*`); the **public** `defineComponent({ context })` API (until a 2nd consumer); **sliding/idle expiry** (needs a write path / Actions); robust windowed/per-IP rate-limiting (a `ratelimit` component); dead-session sweeping (cron); moving hashing into an Action; the Tier-2 DB-level unique index; OAuth/email providers + refresh tokens.

## 7. Open risks to verify during planning

1. **`hash-wasm` under `bun build --compile`** — verify the WASM embeds and runs in the single binary on both Bun and Node (high confidence; the library targets this, but confirm before committing C3.5b).
2. **Facade reader sharing the txn** — confirm a second `KernelContext` at a different namespace over the same `txn`/`queryRuntime` records reads into the shared read-set exactly like the primary function's reads (it should — read recording is on `txn`, not the kernel).
3. **Hashing latency on the single writer** — measure argon2id 19 MiB; if it's painful in dev, drop to a lower memory cost for the dev profile and document the production target.
