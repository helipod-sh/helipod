# Tier 3 Slice 6 — production CLI/runtime integration (implementation plan)

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Grounded in the design record (§11 rollout
> — "selected by config, same story as --database-url"), Slices 1–5 (shipped), and the recon of the CLI's
> store-selection (`boot.ts` `makeStore`), the serve boot/shutdown lifecycle (`serve.ts`), and the
> recurring-driver seam (`receiptsReaper` as the mirror).

**Goal:** make the object-storage substrate an actually-deployable node: `stackbase serve --object-store
<url>` boots a single-shard writer node over an object store — parse the URL, construct the ObjectStore
adapter, adopt/create globals, `open`+`acquire` the shard's lease, auto-renew it with a heartbeat driver
(and stop serving writes if fenced), serve sync/HTTP as normal, and release the lease on graceful
shutdown. Proven end-to-end through the REAL `stackbase serve` (the locked E2E-through-shipped-entrypoint
bar), fs-backed (hermetic) + MinIO-gated.

**Architecture (mirrors the shipped --database-url / fleet-store-bypass pattern):**
- `boot.ts:288` already does `const store = opts.fleet?.store ?? makeStore(...)` — the fleet path
  bypasses `makeStore` with a pre-constructed store. The `--object-store` path is the same shape: build
  an `ObjectStoreDocStore` (adopt globals → open → acquire the lease) BEFORE that line and use it.
- A `--object-store <url>` flag + `STACKBASE_OBJECT_STORE` env (flag wins), threaded exactly like
  `--database-url` (`serve.ts` env-seed → flag-override → `bootProject`).
- URL → adapter: `s3://…` / `s3+http://…` → `@stackbase/objectstore-s3`'s `S3ObjectStore` (parse
  bucket/endpoint/region; credentials from the URL userinfo OR `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`
  env); `file://<path>` or a bare filesystem path → `@stackbase/objectstore-fs`'s `FsObjectStore`
  (dev/self-host-without-a-bucket, per design §11's two-adapter story). Boot fails fast on an object
  store lacking CAS (the existing `assertCasSupported` probe).
- **Lease-heartbeat driver** (mirror `receiptsReaper`): a built-in `Driver` that on a timer calls
  `store.heartbeat({ now: ctx.now(), leaseTtlMs })`. UNLIKE the reapers (which swallow errors), a
  `heartbeat` `FencedError` means this node LOST the lease → it must STOP serving writes (the store is
  already `poisoned` so commits throw `FencedError`; the driver additionally logs a loud, clear fatal
  and — matching the fleet's lease-loss-relinquish behavior — signals shutdown rather than silently
  continuing to serve stale reads). Registered in the `drivers: [...]` array at `boot.ts` only on the
  object-store path.
- **Boot acquire** with a bounded retry loop: `acquire` succeeds on a fresh/expired lease; if another
  LIVE node holds it, retry until acquired or a timeout, then fail fast with a clear "shard held by
  <writer> until <time>" message (a crashed node's lease expires → a restart takes over — the failover
  story from Slice 4, now at the process level).
- **Graceful shutdown:** `serve.ts`'s SIGTERM/SIGINT handler must `store.release()` (+ stop the
  heartbeat driver) BEFORE `store.close()` — `ObjectStoreDocStore.close()` only closes the local SQLite,
  it does NOT release the lease. Release lets the next node take over immediately (no wait for expiry).

**Scope boundary — the remaining arc tail (NOT in Slice 6, explicitly deferred):**
- **Multi-shard single node** (N lanes behind a routing DocStore) — Slice 6 is `numShards=1`, shard "0"
  (the common single-node object-storage deployment; the proven Slice-2 runtime path). Documented.
- **Replica-serve mode** (`serve --object-store <url> --replica` running the Slice-5 tailer to serve
  read-scaled subscriptions) — a follow-on.
- **gc() as a driver + gc-fencing** against a stale writer (Slice-4 deferred #3) — a follow-on.
- **Reshard tool (B5 Part 1)** + **real-cloud benchmark** — the final follow-on (the reshard tool is its
  own design; the real-cloud bench needs actual cloud credentials, a documented manual run like
  `bench:objectstore`). These complete the arc after this slice.

## Global constraints (+ the whole-arc plan's)
- The engine/CLI never imports an S3 SDK directly — only the `@stackbase/objectstore-*` adapters (the
  `--object-store` selector picks the adapter, same as `blobstore-select` for storage).
- ee-gated: the object-store node path sits behind `license.has("scale")` where the fleet path already
  does (mirror the fleet entitlement gate in `serve.ts`; if the fleet gate is the model, apply the same).
- `now` for `acquire`/`heartbeat` comes from the CLI/driver (wall clock) — the substrate stays clock-free.
- A `writerId` is minted once per process by the CLI (non-determinism is fine in the CLI layer).
- Reuse the shipped substrate API verbatim (`ensureGlobals`/`open`/`acquire`/`heartbeat`/`release`) — no
  substrate changes except, if needed, a thin convenience (e.g. an `acquireWithRetry` helper) built ON
  the existing methods.
- E2E MUST go through the real `stackbase serve` (not just `createEmbeddedRuntime`), fs-backed hermetic +
  MinIO-gated (the carried-note-I2 real-S3 discipline).

## Task 6.1 — `--object-store` URL → ObjectStore adapter selection
**Files:** `packages/cli/src/objectstore-select.ts` (new, mirror `blobstore-select.ts`); tests.
- `resolveObjectStore(url: string | undefined): { objectStore: ObjectStore; kind: "s3" | "fs" } | null`
  (null → object-store mode not requested). Parse:
  - `s3://[key:secret@]host/bucket[?region=…&endpoint=…]` (or a documented shape) → `new S3ObjectStore({
    bucket, endpoint?, region?, accessKeyId, secretAccessKey, forcePathStyle? })`, pulling credentials
    from the URL userinfo else `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`. Decide + document one clear
    URL grammar (study `blobstore-s3`/`blobstore-select` for the endpoint/path-style convention and
    reuse it). Fail fast with a clear error on missing bucket/credentials.
  - `file://<abs-path>` or a bare path → `new FsObjectStore(path)`.
- A helper to derive a stable node/shard config: for Slice 6, `shard = "0"`, `numShards = 1`.
- [ ] 6.1a Failing test: `resolveObjectStore("file:///tmp/x")` → an `FsObjectStore`; `resolveObjectStore(
      undefined)` → null; an `s3://…` URL with creds → an `S3ObjectStore` with the parsed bucket/endpoint
      (assert the parsed config, not live I/O); a malformed/creds-missing s3 URL → a clear throw.
- [ ] 6.1b Implement `objectstore-select.ts`. Run → green. Commit.

**Gate:** a URL selects the right adapter with the right parsed config; unset → null; bad input fails
fast and clearly.

## Task 6.2 — The lease-heartbeat driver
**Files:** `ee/packages/objectstore-substrate/src/heartbeat-driver.ts` (new); `src/index.ts` (export);
tests.
- `leaseHeartbeatDriver(store: ObjectStoreDocStore, opts: { leaseTtlMs: number; heartbeatMs: number;
  onFenced?: (e: FencedError) => void }): Driver` — mirror `receiptsReaper`'s single-timer shape
  (`start(ctx){ this.ctx = ctx; arm(); }`, `arm() → ctx.setTimer(ctx.now()+heartbeatMs, wake)`, `wake()`
  fire-and-forget `.finally(arm)`, `stop()` sets a `stopped` guard + `clearTimer`). `wake()` calls
  `await store.heartbeat({ now: ctx.now(), leaseTtlMs })`. On `FencedError`: do NOT re-arm; log a loud
  fatal ("lease lost for shard … — this node no longer owns it") and call `opts.onFenced?.(e)` (the CLI
  wires this to trigger graceful shutdown). On any OTHER error: log + re-arm (transient object-store
  blip; the lease may still be alive until `leaseExpiresAt`).
- `Driver` type from `@stackbase/component` (the substrate may depend on it — confirm/add the dep).
- [ ] 6.2a Failing test: a fake `DriverContext` (controllable `now()`/`setTimer`) + a real
      `ObjectStoreDocStore` (open+acquire on an fs bucket). Start the driver; advance the fake timer; assert
      the manifest's `leaseExpiresAt` advanced (heartbeat renewed). Then FENCE the store (a second
      instance acquires past expiry); advance the timer; assert the driver's `wake` caught `FencedError`,
      did NOT re-arm, and `onFenced` fired. `stop()` clears the timer.
- [ ] 6.2b Implement. Run → green. Commit.

**Gate:** the driver renews the lease on cadence and, on a fence, stops + signals (never silently keeps a
poisoned node serving).

## Task 6.3 — Wire the object-store writer node into bootProject / serve
**Files:** `packages/cli/src/serve.ts` (flag/env/ServeOptions + shutdown release), `packages/cli/src/
boot.ts` (the store branch + acquire + heartbeat driver registration), possibly a small
`acquireWithRetry` helper; tests where hermetic.
- `serve.ts`: add `--object-store` flag + `STACKBASE_OBJECT_STORE` env to `resolveServeOptions` (env-seed
  then flag-override, exactly like `databaseUrl`); add `objectStoreUrl` to `ServeOptions`; thread into
  `bootProject`. In the SIGTERM/SIGINT `shutdown`: if the object-store store is active, `store.release()`
  + stop the heartbeat driver BEFORE `store.close()`.
- `boot.ts`: when `objectStoreUrl` is set → `resolveObjectStore(url)` → `ensureGlobals(os, { deploymentId:
  <stable, e.g. derived-or-configured>, numShards: 1 })` → `local = makeStore({dataPath})` (the SQLite
  materialize target, reusing the existing local-store construction) → `store =
  ObjectStoreDocStore.open({ objectStore, shard: "0", local })` → `acquireWithRetry(store, { writerId:
  <minted>, leaseTtlMs, now: Date.now(), timeoutMs })` (fail fast with the held-by message on timeout) →
  use this `store` in place of `makeStore(...)` at the `boot.ts:288` seam → append
  `leaseHeartbeatDriver(store, { leaseTtlMs, heartbeatMs, onFenced: <trigger shutdown> })` to the
  `drivers: [...]` array. Gate the whole path behind the same entitlement the fleet path uses.
  - `deploymentId`: a fresh deployment mints one (the CLI can, non-determinism OK) and `ensureGlobals`
    ADOPTS any existing — so a restart/second-node reuses the bucket's identity (Slice-4 carried note I1,
    now exercised in production).
- [ ] 6.3a A hermetic test where practical (the store branch is unit-testable by constructing
      `bootProject`/`bootLoaded` options with a `file://` object-store URL and asserting the runtime
      commits + a fresh boot re-adopts globals). If the boot core isn't easily unit-testable in
      isolation, defer the proof to the 6.4 E2E and keep this task to the wiring + a smoke assert.
- [ ] 6.3b Implement the wiring. Build/typecheck green. Commit.

**Gate:** `serve` with `--object-store` constructs an acquired, heartbeating writer node whose store is
the object-storage substrate; shutdown releases the lease.

## Task 6.4 — Headline E2E: `stackbase serve --object-store` end to end, fs + MinIO
**Files:** `packages/cli/test/objectstore-serve-e2e.test.ts` (mirror the existing serve/deploy E2Es that
boot the REAL server).
- A shared `scenario(objectStoreUrl)` booting the real `stackbase serve` (or `startServe`) with
  `--object-store` + `STACKBASE_ADMIN_KEY` against a small fixture app (reuse an existing CLI-test fixture
  conv的ention):
  1. Boot node A over the object store (fs `file://` for the hermetic arm; a real MinIO bucket for the
     gated arm). Assert `/api/health` (or the `{"ready":…}` line).
  2. Commit a mutation via `POST /api/run` → read it back via a query → the data is in the BUCKET
     (a fresh materialization would see it).
  3. A WebSocket subscription opened before a second mutation FIRES reactively (the commit fan-out works
     over the object-store store — same reactive path as SQLite/PG).
  4. Graceful shutdown (SIGTERM) → node A releases the lease.
  5. Boot node B (fresh local dir, same bucket) → it ADOPTS the deploymentId, `acquire`s (A released, so
     immediate), serves, and SEES A's committed data (materialized from the bucket). Assert read-back.
- [ ] 6.4a fs (always-on) + MinIO-gated (`dockerAvailable() && STACKBASE_OBJECTSTORE_S3==="1"` →
      skip). Build/typecheck/test green (default skips MinIO). If docker available, run the gated arm and
      report. Commit.

**Gate (headline):** a real `stackbase serve --object-store` boots a working reactive node over an object
store — commit → bucket → reactive fan-out → read-back — and a second node takes over the same bucket
after the first releases, adopting the deployment identity. The object-storage tier is a real deployment
mode, proven through the shipped entrypoint on fs AND real MinIO.

## Self-review
- Delivers design §11 (config-selected object-store deployment), the Slice-4 heartbeat-driver deferral,
  and the Slice-4 carried-note-I1 (deploymentId adopt) exercised in production. Multi-shard-node,
  replica-serve, gc-driver/fencing, reshard, and real-cloud bench are explicitly the remaining arc tail.
- Reuse honored: the `--database-url`/fleet-store-bypass boot pattern, `receiptsReaper`'s driver shape,
  the shipped substrate lease API, the existing serve/shutdown lifecycle. No substrate correctness
  changes — only a new driver + CLI wiring.
- Type consistency: `resolveObjectStore` returns an `ObjectStore` (the seam the substrate + adapters
  share); `leaseHeartbeatDriver` returns the `@stackbase/component` `Driver`; `ObjectStoreDocStore` is a
  `DocStore` `createEmbeddedRuntime` already accepts.
- E2E-through-shipped-entrypoint bar met (Task 6.4 through real `stackbase serve`, fs + MinIO).
