# Incremental Push (serve target) — Design Spec

**Date:** 2026-05-15
**Status:** Design (pre-plan). Brainstorming complete; awaiting user review before the implementation plan.
**Slice:** Follow-on #1 to the DeployTarget seam ([[deploy-target-seam-shipped]]). Scope: the `serve` deploy target's push protocol only — `cloudflare`/`docker` are package-and-provision, untouched.

## Goal

Make `stackbase deploy` (serve target) ship a **delta** instead of the whole `convex/` tree on every redeploy: send only changed modules plus hashes of unchanged ones. Convex-parity, using Convex's proven **server-negotiate** model. Fully back-compatible with a server that predates the feature.

## Why (and the honest scope note)

Today `serveTarget.push` transpiles the whole tree via `packageApp` and POSTs every file to `/_admin/deploy` each time. Unlike Convex — whose `changedModules` are full esbuild **bundles with node_modules inlined** (large) — our payload is *transpiled-but-unbundled* source with import specifiers untouched (bare `@stackbase/*` resolve on the server), so it's typically small. The delta win is therefore modest until an app grows large, but the user chose **full Convex-parity incremental push** (over compress-only) for scale-readiness and parity. This spec builds that.

## Current state this builds on

- **Client:** `packages/deploy/src/targets/serve.ts` — `push()` calls `ctx.packageApp()` (→ `{ files: [{path, code}] }`, transpiled JS) and `POST`s `{ files }` to `<url>/_admin/deploy` with `Bearer <adminKey>`. On HTTP 404 → "not enabled (--allow-deploy)". `preflight` requires url + adminKey.
- **Server route:** `packages/cli/src/http-handler.ts:303` handles `POST /_admin/deploy` → `deploy.apply(files)`.
- **Server apply:** `packages/cli/src/deploy-apply.ts` `applyDeploy(deps, files)` — writes the full tree under `deployRoot/<rev>/convex`, `loadConvexDir → push`, `diffSchema` (additive gate), atomic swap. `rev = sha256(JSON.stringify(files)).slice(0,12)`.
- **Server wiring:** `packages/cli/src/serve.ts:462` builds the `deploy` object (`{ apply }`) only when `allowDeploy`. The `ServeOptions.deploy` seam type lives in `packages/runtime-embedded/src/host.ts`.

## Design

### 1. Wire protocol (two round trips)

- **New** `GET /_admin/deploy/modules` — same `Bearer STACKBASE_ADMIN_KEY` auth, same `--allow-deploy` gate as the POST. Returns `200 { "<path>": "<sha256hex>", ... }`: the per-path hashes of the modules from the **last push in this server lifetime** (empty `{}` if none yet). Returns `404` when deploy is disabled OR the endpoint doesn't exist (old server) — the two are indistinguishable to the client on purpose (§5).
- **`POST /_admin/deploy`** gains an alternative body. Either (legacy) `{ files: [{path, code}] }` OR (delta) `{ changed: [{path, code}], unchanged: [{path, sha256}] }`. The **union** `changed ∪ unchanged` (by path) is the complete module tree — so **deletions are implicit**: a removed file appears in neither list.

### 2. Hash definition

`sha256(code)` as lowercase hex over the utf8 **transpiled `.js` `code` string** — the exact bytes `packageApp` emits and the client would send. Client and server hash identically by construction (server hashes the `code` it received/retained, never a re-transpile). A single pure helper `sha256Hex(code: string): string` shared by both sides.

### 3. The boot-hash characteristic (deliberate)

The client hashes transpiled `.js`; a freshly-booted server loaded the app's `.ts` from disk (via `loadConvexDir`) and never ran the client's esbuild transpile — so boot-time hashes are NOT comparable. Rather than make the server re-transpile (fragile, must match esbuild settings exactly), the server tracks the module set **from the last deploy, not from boot**: `currentPushedModules` starts **empty each server lifetime**. Consequence — documented, not a bug:

> **The first deploy after a (re)start is effectively a full push; every deploy after that within that server's lifetime is a true delta.**

`GET` returns `{}` before the first push → the client marks everything `changed` → the server records the full pushed set → subsequent `GET`s return real hashes → deltas.

### 4. Server: state, reconstruction, integrity

- **State:** `currentPushedModules: Map<path, { code: string; sha: string }>` — held in the `serve.ts:462` closure that builds the `deploy` object (captured across `apply` calls; lives for the server lifetime). This tracks the **user-pushed** modules only — NOT the always-on `_storage:*` built-ins that `withStorageModules` injects server-side (the client never sends or diffs those).
- **`deploy` seam grows a method:** `modules(): Record<string, string>` returns `{ path: sha }` from `currentPushedModules` (`{}` when empty). `ServeOptions.deploy` type gains `modules?: () => Record<string, string>`.
- **Data flow (no cross-file reach):** the state lives in `serve.ts`; `applyDeploy` (in `deploy-apply.ts`) stays pure w.r.t. it. `applyDeploy` **receives** the current set (via its deps/param, e.g. `currentModules: Map<path,{code,sha}>`, read-only) for reconstruction and, on success, **returns** the new full set in its `DeployResult`; the `serve.ts` caller stores it. `deploy.modules()` reads the same `serve.ts`-held map.
- **Reconstruction in `applyDeploy`:** accept `files` OR `{ changed, unchanged }`. For the delta form, rebuild the full `files`: take `changed` as-is; for each `unchanged {path, sha}`, look up `currentModules.get(path)` and **verify `entry.sha === sha`**. If the path is missing or the sha disagrees → return `{ ok:false, kind:"stale-base", error }` (the client retries full — §5). Then proceed exactly as today (write tree → `loadConvexDir` → `diffSchema` → swap).
- **Update on success:** `applyDeploy` returns the new full set (`path → {code, sha}`) alongside `{rev, functions}`; `serve.ts` replaces its `currentPushedModules` with it so the next `GET` reflects it. `rev` is still computed over the full reconstructed `files`, unchanged.

### 5. Client: flow + fallbacks (`serveTarget.push`)

1. `GET <url>/_admin/deploy/modules`.
2. **404** (old server, or deploy disabled) → **full push**: POST `{ files }` exactly as today (and a disabled server then 404s the POST → the existing "not enabled (--allow-deploy)" error surfaces — correct).
3. **200 `{...}`** → partition local files against the returned hashes: a file is `unchanged` iff the server has the same `path` with an equal `sha256`, else `changed` (new or modified). POST `{ changed, unchanged }`.
4. On a **`stale-base`** response → **transparently retry once as a full push** (`{ files }`), then report its result. Robust against the rare GET/POST race.

A small pure `partitionModules(local: FileTree, remote: Record<string,string>)` helper does step 3, unit-testable in isolation.

### 6. Back-compat matrix (all four combinations)

| Client | Server | Behavior |
|---|---|---|
| new | new | GET 200 → delta POST |
| new | old | GET 404 → full push (`{ files }`) |
| old | new | old client POSTs `{ files }` → server's legacy path |
| old | old | unchanged |

## Files

- **Modify** `packages/deploy/src/targets/serve.ts` — GET-then-partition-then-delta push, full-push fallback, stale-base retry.
- **New** `packages/deploy/src/module-hash.ts` — pure `sha256Hex(code)` + `partitionModules(local, remote)`; exported from `index.ts`.
- **Modify** `packages/cli/src/deploy-apply.ts` — accept `{changed, unchanged}`, reconstruct + verify, `stale-base` error, return the new full module set so the caller can update state.
- **Modify** `packages/cli/src/serve.ts` — hold `currentPushedModules`; build `deploy.modules()`; update state after a successful `apply`.
- **Modify** `packages/cli/src/http-handler.ts` — add the `GET /_admin/deploy/modules` branch beside the POST (same auth/gate).
- **Modify** `packages/runtime-embedded/src/host.ts` — `ServeOptions.deploy` gains `modules?: () => Record<string, string>`.

## Testing

- **Unit (fast lane):** `partitionModules` (unchanged/changed/new/deleted-by-omission); `sha256Hex` determinism; server reconstruction (delta → full tree), sha-mismatch → `stale-base`, missing-path → `stale-base`.
- **E2E (serial lane, through the real `serve --allow-deploy`):** deploy v1 (full, first-per-lifetime), deploy v2 changing exactly one module (assert the POST body's `changed` has one entry and `unchanged` the rest, the new function is live AND fans out reactively to a pre-open subscription), a forced `stale-base` → transparent full-push retry succeeds, and an old-server (no GET route) → GET-404 → full-push path. Reuse the serve-boot helper from `packages/cli/test/deploy-e2e.test.ts`.

## Non-goals

- `cloudflare`/`docker` targets (package-and-provision, not push).
- A persisted content-addressed store surviving restarts (in-memory per-lifetime is sufficient; the first-deploy-per-lifetime-is-full characteristic is accepted).
- Brotli body compression (a separate, orthogonal optimization — not bundled here).
- Client-side push cache (the server-negotiate model deliberately needs none).
