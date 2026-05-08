# Cloudflare Durable-Object feature-completeness audit

**Date:** 2026-04-13
**Status:** INVESTIGATION (written audit, not a build)
**Scope:** Which shipped Stackbase features work on the Cloudflare Durable-Object host
(`packages/runtime-cloudflare`) vs. which are genuinely broken, and why — an evidence-backed gap list so
the follow-on build only touches real gaps.
**Out of scope (deferred by the user):** multi-tenancy / Worker Loader (Slice 4).

## Method

Two methods, both used:

- **(A) Static analysis** — grepped each feature's engine code path for Workers-incompatible primitives
  (`node:fs`, `node:crypto`'s `scryptSync`/cipher, `node:stream`/`net`/`child_process`, `bun:sqlite`, `ws`,
  filesystem, `setInterval`). A path that hits one of these on the DO is broken until fixed.
- **(B) Real-workerd tests** — extended the shipped `vitest.workers.config.ts` harness
  (`@cloudflare/vitest-pool-workers`, a genuine Durable Object in workerd) with a throwaway audit fixture
  (`test-workers/audit-fixture.ts` + `audit.worker.test.ts`, `AUDIT_DO`) that exercises the ambiguous
  features INSIDE a real DO. No Cloudflare login here, so anything needing a live `wrangler deploy` is
  marked **DEPLOY-PENDING**, not faked.

> **Substrate confirmation:** the pre-existing suite (`bunx vitest run --config vitest.workers.config.ts`)
> is green — **12 tests, 4 files** — including the DO-SQLite adapter conformance and the flagship
> subscribe → commit → push reactivity proof inside a real DO (`host.worker.test.ts`). The audit fixture
> adds **6 more, all green** in real workerd.

## The architecture that makes most features work unmodified

The DO host (`durable-object.ts`) reuses the shipped **pure** pieces rather than re-implementing them:

- Non-WS HTTP → `DurableObjectRuntimeHost.fetch` (`host.ts:51`) → the shipped pure dispatcher
  `handleHttpRequest` (`@stackbase/cli/http-handler`), with `routes: this.boot.project.routes`
  (`durable-object.ts:91`). So `/api/run` (query/mutation/**action**), `/api/health`, `/_admin/*`, and
  **user `http.ts` routes** all flow through one shipped code path.
- WS `/api/sync` → the DO's own `WebSocketPair` + hibernation, driving the shipped `SyncProtocolHandler`
  in-process (`durable-object.ts:207`). Reactive fan-out is an in-process call in the write turn, so the
  G1/G4 ordering guarantees hold by construction.
- Driver timers (scheduler/triggers/workflow) → the wake seam: `DoAlarmWakeHost.armWake` →
  `ctx.storage.setAlarm` (`wake.ts:23`), `alarm()` → `runtime.fireDueTimers()` (`durable-object.ts:275`).
  `bootDurableObjectRuntime` sets `disableSyncBackgroundTimers: true` (`boot.ts:88`), disarming the
  process-shaped `setInterval` sweep + `socket.ping` heartbeat that fight hibernation.
- The executor + runtime-embedded are **clean of host I/O primitives by design** (`runtime-embedded/host.ts:9`
  — "NO host I/O primitive — no `bun`, `node:*`, `ws`"). Confirmed by grep: no `node:fs`/`node:stream`/`ws`
  leak in `packages/executor/src` or `packages/runtime-embedded/src`.

The break points are where a feature reaches OUTSIDE those pure pieces: the file-storage byte layer, the
auth OAuth/MFA crypto layer, and the "component/storage routes" HTTP seam — none of which the DO host wires.

---

## Per-feature audit

### 1. Queries / mutations / reactive subscriptions — **WORKS (proven live)**

Proven in real workerd (`host.worker.test.ts`): boot, `/api/health`, a committing `/api/run` mutation +
read-back on real DO-SQLite, and subscribe → commit → push fan-out across a real WebSocket. Node harness
(`test/host.test.ts`) adds hibernation-rehydrate and the per-socket subscription cap. No action needed.

### 2. Actions (`ctx.runAction`, native fetch/Date/Math.random/timers) — **WORKS (PROVEN in real workerd)**

The action executor path has **no `node:` leak** (grep of `packages/executor/src` clean). Actions dispatch
through the same `/api/run` (with `kind:"action"`, `http-handler.ts:241`) and WS `Action` paths the DO
already routes.

**PROVEN** by `audit.worker.test.ts`: an `action` running `Date.now()` + `Math.random()` + `ctx.runMutation`
inside a real DO returns its value via `POST /api/run kind:"action"`, the inner mutation actually commits
(read-back), AND that write **fans out reactively** to a live WebSocket subscription. Native `fetch` (Workers
built-in) was not exercised (no outbound network in the test rig) but is the runtime's native primitive.

### 3. httpAction + the public HTTP router (`http.ts`, `httpRouter()`) — **WORKS (PROVEN in real workerd)**

User `http.ts` routes are resolved by `loadProject` (`project.ts:129-166`) into `project.routes`, which the
DO passes to `handleHttpRequest`. A raw webhook `POST` to a user route is matched there — it does NOT need
`/api/run`.

**PROVEN** by `audit.worker.test.ts`: a bundled `http.ts` router (`POST /hook` → `httpAction` →
`ctx.runMutation`) reached by a raw webhook POST to the DO returns 200 and its write **fans out to a live
subscription**. (Note: the httpAction handler must be a *registered named export* of an app module —
`loadProject` resolves the route handler back to a `path:name` ref, `project.ts:140-148` — a fixture-shape
requirement, not a DO limitation.)

### 4. Scheduler / crons (`@stackbase/scheduler`) — **WORKS (inferred; wake seam proven, no workerd job test)**

`components/scheduler/src` is **clean of `node:`/`setInterval` leaks** (grep clean). It runs on the driver +
wake seam, which the DO wires (`DoAlarmWakeHost` + `alarm()` → `fireDueTimers()`). The wake *mechanism* is
proven in the Node harness (`test/host.test.ts:169`, "fires due driver timers on the alarm"). **Honest gap:**
no *composed* scheduler job has been driven to fire on real workerd (the Node alarm test fires with zero
composed drivers). Architecturally sound; recommend a confirming workerd fixture before claiming "proven live."

### 5. Triggers (`@stackbase/triggers`, onChange) — **WORKS (inferred; same seam, untested in workerd)**

`components/triggers/src` **clean** (grep). Cursor-over-the-MVCC-log driver runs in-process on the same
driver/wake seam as the scheduler (`DriverContext.readLog`). Same status as scheduler: mechanism sound and
seam-wired, but no trigger has been observed firing on a DO commit in real workerd. Recommend a confirming
workerd fixture.

### 6. Workflows (`@stackbase/workflow`, durable multi-step + saga) — **WORKS (inferred; built on scheduler)**

`components/workflow/src` **clean** (grep). Built ON the scheduler (`requires: ["scheduler"]`); deterministic
replay + the journal run in-process in the DO transactor. Inherits the scheduler's verdict: sound, seam-wired,
not yet workerd-proven with a composed workflow.

### 7. File storage (`ctx.storage`, `_storage`, `generateUploadUrl`, byte I/O) — **BROKEN (the biggest gap)**

Three independent breaks, in order of depth:

1. **`ctx.storage` is not wired into the DO at all.** `bootDurableObjectRuntime` (`boot.ts`) never calls
   `storageContextProvider`/`storageRoutes`/`storageReaper` (grep of `packages/runtime-cloudflare/src`
   confirms none present; `boot.ts:14` documents "FILE STORAGE IS OUT OF SCOPE"). The container path wires
   all three in `packages/cli/src/boot.ts:1006-1083`. So on a DO, any function calling
   `ctx.storage.generateUploadUrl`/`getUrl`/`store` fails — the provider isn't registered. The `_storage`
   TABLE exists (so `Id<"_storage">` schemas compile) but nothing moves bytes.
2. **No DO-compatible `BlobStore` exists.** `@stackbase/blobstore-fs` imports `node:fs/promises`
   (`fs-blobstore.ts:3`) → broken on a DO (no filesystem). `@stackbase/blobstore-s3` imports `node:stream`
   `Readable.toWeb` (`s3-blobstore.ts:9,109`) plus the heavy `@aws-sdk/client-s3` → marginal at best, and
   points at S3, not the DO's natural R2. **There is no `@stackbase/blobstore-r2`** (`ls packages` shows only
   `blobstore-fs`/`blobstore-s3`).
3. **The storage serve endpoints (`/api/storage/*`) are unreachable on the DO.** They live in
   `packages/storage/src/http.ts` and are dispatched by the container's `server.ts` (`storageRoute.handler`,
   `server.ts:220`) — **NOT** by the pure `handleHttpRequest` the DO reuses (`handleHttpRequest` takes no
   `storageRoutes` param, `http-handler.ts:144`). So proxied upload / range-GET / confirm all 404 on a DO.
   (Note: the storage capability-token crypto itself is fine — `token.ts:23` uses `createHmac`/`timingSafeEqual`,
   both proven working under `nodejs_compat` below.)

### 8. Auth (`@stackbase/auth`) — **MOSTLY WORKS, with two real gaps**

Session core (A1, the only shipped auth slice) is regular mutations/queries dispatched via `/api/run` / WS —
so the dispatch works. The crypto and route surfaces are where it splits:

| Auth primitive | file:line | Verdict |
|---|---|---|
| Password hash PRIMARY: argon2id via `hash-wasm` | `crypto.ts:1,8` | **WORKS (inferred)** — pure WASM+JS, runs on Workers. Not proven in-harness (hash-wasm isn't a dep of `runtime-cloudflare`, so vitest's esbuild couldn't resolve it — a harness artifact, not a workerd signal). |
| `randomBytes` / `createHash` / `timingSafeEqual` / `createHmac` | `crypto.ts:2`, `token.ts:23` | **WORKS (PROVEN in real workerd)** — `audit.worker.test.ts`. |
| `scryptSync` (legacy password migration verify) | `crypto.ts:2,30` | **WORKS (PROVEN in real workerd)** — `scryptSync("password","salt",64)` returned 64 bytes under `nodejs_compat` (`ok=true`). Corrects the prior assumption that scrypt is unavailable; it is present. |
| MFA secret encryption: `createCipheriv`/`createDecipheriv` (aes-256-gcm) | `mfa/secret-crypto.ts:1` | **BROKEN (PROVEN in real workerd)** — `createCipheriv is not a function` under `nodejs_compat`. TOTP secret storage cannot encrypt/decrypt on a DO. |
| OAuth / external-identity callback routes (`/api/auth/oauth/*`) | see below | **BROKEN** — component-route seam not wired on the DO. |

**The OAuth-callback gap = the same seam gap as storage endpoints.** Auth's OAuth callbacks are
`project.componentRoutes` (`project.ts:41-42`, resolved by `composeComponents`). The container serves them via
`matchComponentRoute` in `server.ts:227,392` — again **outside** `handleHttpRequest`. The DO's
`bootDurableObjectRuntime`/`host.ts` never reference `componentRoutes` (grep clean), and `handleHttpRequest`
has no `componentRoutes` parameter. So any OAuth redirect/callback 404s on a DO. Core password/session flows
(plain functions) are unaffected. (MFA and full external-identity are later auth slices; A1 session core is
what's shipped — this is a forward gap for those slices, not a regression today.)

### 9. Search / vector — **N/A (unbuilt everywhere)**

Not built on any host (CLAUDE.md deferred list). Not a Cloudflare-specific gap; out of scope for parity.

### 10. Deploy experience — **GAP (no turnkey command)**

There is **no `stackbase deploy --cloudflare` / `stackbase build --target worker`** — grep of
`packages/cli/src` for `cloudflare`/`wrangler`/`--target worker`/`generateWorkerEntrySource` is **empty**. The
codegen primitive exists (`generateWorkerEntrySource`, `worker-entry.ts` — the DO-native twin of
`build-entry.ts`; it emits static module imports + the concrete `StackbaseDO` class + the stateless Worker),
but **no CLI wraps it** and **nothing generates `wrangler.jsonc`** (the `nodejs_compat` flag, the
`durable_objects` binding, the `new_sqlite_classes` migration, and — once storage lands — an R2 binding). The
Worker entry + wrangler config are hand-assembled today (as the test harness does manually in
`test-workers/`). No multi-shard entry generator exists yet either (only the single-shard
`generateWorkerEntrySource`; the Slice-6 shard twin is not built).

**DEPLOY-PENDING (cannot verify without a Cloudflare login):** real hibernation eviction timing, cross-datacenter
write latency vs. the container→R2 baseline, and the `SQLITE_FULL` (10 GB) error-shape (`errors.ts:37-45`,
still inferred).

### Also: Slice 6 M2 (`.global()` / D1 cross-shard reads + global-unique) — **known deferred gap**

Already spec'd in `docs/superpowers/specs/2026-03-20-multishard-crossshard-slice6-design.md`. Global-data
features (cross-shard reads, global-unique constraints) are deferred with the rest of Slice 6 sharding. Not
re-spec'd here — referenced as the home for "global data" parity.

---

## Summary table

| # | Feature | Status | Reason + evidence (file:line) | Fix sketch + rough size |
|---|---|---|---|---|
| 1 | Queries / mutations / reactive subs | **WORKS** (proven live) | `host.worker.test.ts` green in real workerd | none |
| 2 | Actions | **WORKS** (PROVEN workerd) | `audit.worker.test.ts`; executor path node-clean | none |
| 3 | httpAction + HTTP router | **WORKS** (PROVEN workerd) | `audit.worker.test.ts`; user routes in `project.routes` → `handleHttpRequest` | none |
| 4 | Scheduler / crons | **WORKS** (inferred) | component node-clean; wake seam proven `host.test.ts:169`; no composed-job workerd test | add confirming workerd fixture (XS) |
| 5 | Triggers (onChange) | **WORKS** (inferred) | `triggers/src` clean; same driver/wake seam | add confirming workerd fixture (XS) |
| 6 | Workflows + saga | **WORKS** (inferred) | `workflow/src` clean; built on scheduler | covered by scheduler fixture (XS) |
| 7 | File storage | **BROKEN** | (a) `ctx.storage` unwired in DO boot (`boot.ts`, no `storageContextProvider`); (b) no R2 `BlobStore` — fs uses `node:fs` `fs-blobstore.ts:3`, s3 uses `node:stream` `s3-blobstore.ts:9,109`; (c) `/api/storage/*` served in `server.ts:220`, not `handleHttpRequest` | R2 BlobStore + wire provider/reaper/routes into DO (M–L) |
| 8a | Auth session core + password (argon2/scrypt) | **WORKS** | argon2 WASM inferred; `randomBytes`/`createHash`/`hmac`/**`scryptSync`** PROVEN workerd | none (optionally prove argon2 bundle) |
| 8b | Auth MFA secret crypto | **BROKEN** (PROVEN workerd) | `createCipheriv is not a function`, `mfa/secret-crypto.ts:1` | swap to WebCrypto `subtle` AES-GCM (S) |
| 8c | Auth OAuth / external-identity callbacks | **BROKEN** | `componentRoutes` unwired on DO; `handleHttpRequest` has no such param; container uses `server.ts:227` | thread componentRoutes through DO dispatch (S) |
| 9 | Search / vector | **N/A** | unbuilt everywhere | out of scope |
| 10 | Turnkey Cloudflare deploy | **GAP** | no CLI (`grep cloudflare/wrangler` empty); `generateWorkerEntrySource` exists but unwrapped; no `wrangler.jsonc` gen | `stackbase deploy --cloudflare` (M) |
| — | Slice 6 M2 `.global()`/D1 | **DEFERRED** | already spec'd `2026-03-20-multishard-crossshard-slice6-design.md` | reference only |
| — | Hibernation/latency/`SQLITE_FULL` shape | **DEPLOY-PENDING** | needs real `wrangler deploy` | human-run deploy E2E |

**Proven in real workerd (this audit):** actions (2), httpAction+router (3), `node:crypto`
createHash/randomBytes/timingSafeEqual/createHmac (8a), `scryptSync` works (8a), `createCipheriv` broken (8b).
**Inferred from static analysis:** scheduler/triggers/workflow (4–6, seam-wired + node-clean), argon2 WASM (8a),
componentRoutes gap (8c), file-storage breaks (7), deploy gap (10).

---

## The one shared root cause worth naming

**Gaps 7c and 8c are the same seam gap.** The DO reuses only the pure `handleHttpRequest` dispatcher, which
handles `routes` (user httpActions) but **not** `storageRoutes` or `componentRoutes` — those are matched in the
container's `server.ts`, which the DO does not use. A single seam change — thread `storageRoutes` +
`componentRoutes` through `handleHttpRequest` (or match them in `DurableObjectRuntimeHost.fetch` before
delegating) — makes both the storage serve endpoints AND the auth OAuth callbacks reachable on the DO. Fixing
this once is a prerequisite for both file storage and external auth.

---

## Recommended build order (real gaps only)

Ordered by dependency and value. Sizes are rough (XS < a day, S ≈ 1–2 days, M ≈ 3–5 days, L ≈ 1–2 weeks).

1. **Thread `componentRoutes` + `storageRoutes` through the DO HTTP dispatch seam** — **size S.**
   Add the two route lists to `handleHttpRequest` (or match them in `DurableObjectRuntimeHost.fetch`), and pass
   `project.componentRoutes` / storage routes from the DO boot. **Unblocks:** the serve half of file storage
   (gap 7c) AND auth OAuth callbacks (gap 8c). **Depends on:** nothing. Do this first — it's the shared
   prerequisite.

2. **`@stackbase/blobstore-r2` + wire `ctx.storage` into the DO boot** — **size M–L (the biggest gap).**
   New `BlobStore` on the R2 binding (native `env.R2.get/put/delete` or the R2 S3 API — avoid `node:stream`
   `Readable.toWeb`; use Web streams / `arrayBuffer`). Wire `storageContextProvider` + `storageReaper` +
   `storageRoutes` into `bootDurableObjectRuntime`; the DO's own `fetch` serves `/api/storage/*` bytes and
   presigned/proxied uploads. Reaper rides the wake seam (already works). **Depends on:** #1 (serve endpoint
   reachability). Prove with a real-workerd fixture binding an R2 (or the R2-over-S3 API against MinIO).

3. **Swap auth MFA secret crypto to WebCrypto** — **size S.**
   Replace `createCipheriv`/`createDecipheriv` in `mfa/secret-crypto.ts` with WebCrypto `subtle` AES-GCM
   (works on Workers; also fine on Node/Bun, so no host fork). scryptSync + argon2 already work, so this is the
   *only* auth-crypto break. Optionally add a workerd test that actually runs `hash-wasm` argon2id to graduate
   8a from inferred to proven. **Depends on:** nothing (parallel with #1/#2).

4. **`stackbase deploy --cloudflare` (turnkey deploy)** — **size M.**
   Wrap `generateWorkerEntrySource` into a CLI command: run codegen, emit the static-import Worker entry, and
   **generate `wrangler.jsonc`** (`nodejs_compat`, the `durable_objects` binding + `new_sqlite_classes`
   migration, an R2 binding when storage is used, the `STACKBASE_ADMIN_KEY`/`STACKBASE_DO_LOCATION_HINT` vars),
   then shell out to `wrangler deploy`. **Depends on:** ideally #2 (so the generated wrangler knows whether to
   bind R2), but the function/schema-only deploy can ship before storage. This is where the DEPLOY-PENDING
   items (hibernation timing, cross-DC latency, `SQLITE_FULL` shape) finally get verified on real Cloudflare.

5. **Scheduler/triggers/workflow confirming workerd fixtures** — **size XS.**
   Not a gap, a proof upgrade: compose a scheduler + a trigger in a workerd fixture and assert a job/trigger
   actually fires off the DO alarm. Graduates gaps 4–6 from "inferred" to "proven live." **Depends on:** nothing.

6. **Slice 6 M2 `.global()` / D1 cross-shard + global-unique** — **already spec'd, deferred.**
   Global-data parity. Track under the existing multishard Slice-6 spec, not this build.

**Net:** actions, httpAction, scheduler/triggers/workflow, queries/mutations/reactive, and auth
session+password already work on the DO — do NOT rebuild them. The real work is the storage seam (#1) + R2
BlobStore (#2), the small MFA crypto swap (#3), and the deploy command (#4). Everything else is a proof
upgrade or an already-deferred item.

---

## Appendix — audit fixture (throwaway)

Added on this branch under `packages/runtime-cloudflare/test-workers/` (clearly labeled throwaway, safe to
delete): `audit-fixture.ts` (an `AuditDO` app with an action + an `httpAction` router) and
`audit.worker.test.ts` (the 6 proofs above), plus `AUDIT_DO` in `test-worker.ts` re-export + `wrangler.jsonc`
binding/migration. Run: `cd packages/runtime-cloudflare && bunx vitest run --config vitest.workers.config.ts`.
Not product code.
