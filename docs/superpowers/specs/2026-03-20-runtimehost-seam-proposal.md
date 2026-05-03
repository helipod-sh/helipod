# Slice 1 — the `RuntimeHost` seam: research + proposal

**Date:** 2026-03-20
**Status:** PROPOSAL (research + design). No engine code changed. This doc is the groundwork the
`superpowers:writing-plans` step turns into an executable TDD plan.
**Branch:** `slice1/runtimehost-seam-proposal` (from `spike/cloudflare-r2-gate`).
**Scope:** Slice 1 of `docs/superpowers/plans/2026-03-20-cloudflare-do-native-host-roadmap.md` — extract
a host seam so the existing engine runs on both a long-lived process AND a Durable Object, with the
EXISTING process host reimplemented on top of it, **zero behavior change**.

**Reads this builds on:**
- `docs/superpowers/plans/2026-03-20-cloudflare-do-native-host-roadmap.md` (Slice 1 = this scope)
- `docs/dev/research/cloudflare-do-native-host.md` (the 4 named engine changes, the DO hard limits)
- `docs/superpowers/specs/2026-03-20-do-alarm-driver-seam-design.md` (the shipped `WakeHost` seam —
  change #2. The `RuntimeHost` seam must COMPOSE with it, not duplicate it.)

---

## TL;DR (the load-bearing findings, up front)

1. **The engine is already host-neutral.** `packages/runtime-embedded`, `packages/transactor`, and
   `packages/sync` import no host primitive — no `Bun`, no `node:http`, no `ws`, no cloudflare type.
   The host tangle is entirely inside **`packages/cli`** (`server.ts` + `serve.ts` + `boot.ts`). Slice 1
   is really "pull the serving + lifecycle orchestration out of `packages/cli` behind a named seam,"
   NOT "change the engine." That matches the roadmap's own framing ("the server is currently tangled
   into `packages/cli`").

2. **Three of the five sketched `RuntimeHost` members are ALREADY seams and need no rework:** timers
   (`WakeHost` — shipped), storage (`DocStore`/`DatabaseAdapter` — shipped, its own doc-comment even
   names D1 as a swap target), and the clock (`now?: () => number` — already an injected option). The
   ONLY genuinely-new surface Slice 1 must model is **serving** (HTTP + WebSocket).

3. **The single-writer mutex is NOT a Slice-1 problem.** `AsyncMutex`
   (`packages/transactor/src/async-mutex.ts`) is pure promise-chain JavaScript — no OS/process
   primitive. It runs correctly and harmlessly inside a DO isolate (single-threaded → never contends →
   a straight passthrough at ~microsecond cost). The roadmap lists "mutex→serial" in Slice 1's scope,
   but the adversarial finding (§3.1) is that **it forces no engine change in Slice 1**: the transactor
   can be left completely untouched. Dropping the mutex on a DO is a Slice-3 micro-optimization, not a
   correctness requirement, and making it an injectable `WriterGate` is optional. **This is a human
   design decision — flagged in §5.**

4. **Recommendation: Option B — a thin `RuntimeHost` whose only new concept is the serving backend.**
   Do NOT re-bundle the already-clean seams (`WakeHost`/`DocStore`/`now`) into a fat interface (that is
   the roadmap's stated "biggest risk: over-abstracting"). Reference them as-is.

---

## 1. Current-state map (what a DO host must implement differently)

Every claim below is `file:line` against the `spike/cloudflare-r2-gate` tree.

### 1.1 HTTP/WebSocket serving — HARDCODED to a long-lived process (the real Slice-1 target)

All serving lives in **`packages/cli/src/server.ts`**. It is the one place that touches a host I/O
primitive.

- **Two process backends, picked at runtime:** `startDevServer` (`server.ts:465`) dispatches on
  `detectRuntime()` to either `startBunServer` (`server.ts:368`, uses `Bun.serve` — `server.ts:374`)
  or `startNodeServer` (`server.ts:197`, uses `node:http` `createServer` — `server.ts:200` — plus the
  `ws` package's `WebSocketServer` — `server.ts:277`).
- **The server handle is already a neutral shape:** `interface DevServer` (`server.ts:49-55`) =
  `{ url; port; close(): Promise<void>; setRoutes(routes) }`. Both backends return it. This is the
  return type a DO host would also produce (its `url` is the Worker route; `close()`/`setRoutes()` map
  onto DO lifecycle). **Reusable as-is.**
- **HTTP dispatch is already a pure function:** both backends normalize the native request to a plain
  `{ method, path, body, query, authorization, headers }` and call `handleHttpRequest(...)`
  (`server.ts:250` node / `server.ts:405` bun), which returns `{ status, headers, body }`.
  `handleHttpRequest` lives in `packages/cli/src/http-handler.ts` and imports **only** `@stackbase/*`
  plus two local *type* imports (`http-handler.ts:6-13`) — it is engine-neutral in substance. A DO
  Worker's `fetch` would build the same plain request object and call the same function. **Reusable;
  relocation to a neutral package is a Slice-3 concern, not Slice 1.**
- **The WebSocket abstraction the engine exposes is already neutral:** each backend adapts its native
  socket to `interface SyncWebSocket` (`packages/sync/src/handler.ts:44-54` — `send`/`bufferedAmount`/
  `close`/optional `ping`) and drives the engine via `runtime.handler.connect(sessionId, syncSocket)`
  (`server.ts:297` node / `server.ts:434` bun), `handler.handleMessage` (`server.ts:298`/`437`), and
  `handler.disconnect` (`server.ts:299`/`442`). `SyncProtocolHandler.connect/handleMessage/disconnect`
  are `handler.ts:293`/`382`/`303`. **This is exactly the surface a DO sync-DO would drive** — the DO's
  WS-hibernation glue lives *behind* `SyncWebSocket`, invisible to the engine.

**What `startDevServer` owns that is process-specific:** binding a real TCP port (`server.listen` /
`Bun.serve({ port })`), owning the `Bun.serve`/`node:http` handle, and the WS upgrade handshake
(`server.on("upgrade", …)` `server.ts:279` / `server.upgrade(req)` `server.ts:383`). A DO replaces all
three: no port (the Worker owns ingress), Worker `fetch` instead of a serve handle, and
`WebSocketPair` + `state.acceptWebSocket` (hibernation) instead of the upgrade handshake.

**Verdict:** serving is the ONE responsibility hardcoded to a long-lived process that has no seam yet.
It is the core of Slice 1.

### 1.2 The single-writer guarantee — hardcoded, but host-NEUTRAL (see §3.1)

- `AsyncMutex` — a minimal promise-chain lock — is defined at
  `packages/transactor/src/async-mutex.ts:6` (also re-exported from `transactor/src/index.ts:31`).
- It is instantiated **hardcoded, not injected**, as a field of `ShardWriter`:
  `readonly mutex = new AsyncMutex()` (`packages/transactor/src/shard-writer.ts:255`). The commit
  pipeline serializes through `this.mutex.runExclusive(...)` (`shard-writer.ts:358`, `487`, `636`,
  `659`).
- `SingleWriterTransactor` wraps exactly one `ShardWriter` (`single-writer-transactor.ts:32`);
  `ShardedTransactor` builds one `ShardWriter` (thus one mutex) per shard. The runtime picks between
  them at `packages/runtime-embedded/src/runtime.ts:426-435` on `numShards`.
- **Not swappable today** — there is no injection point for the lock.

Crucially (§3.1): the class is pure JS with no process/OS dependency. It is *host-neutral as written*.
The mutex is "hardcoded to a long-lived process" only in the trivial sense of being a `new` in a
constructor — it does not *assume* one.

### 1.3 Timers — ALREADY a seam (`WakeHost`), confirmed

Change #2 shipped. Confirmed:
- `interface WakeHost { armWake(atMs: number | null): void }` — `packages/component/src/define-component.ts:44-46`.
- `DriverContext.setTimer` / `backstopMs` — `define-component.ts:50-64`.
- The runtime multiplexes every live driver timer to one pending wake and only crosses the seam when
  the minimum moves: `rearm()` (`runtime.ts:701-708`), `fireDueTimers()` (`runtime.ts:709-744`, public
  at `runtime.ts:1290`), factory `setTimer` (`runtime.ts:773-789`) — the `setTimeout` default path is
  gated behind `if (!wakeHost)` (`runtime.ts:780`), so a host owns firing entirely when present.
- The runtime option is `wakeHost?: WakeHost` (`runtime.ts:172`); the CLI builds one from config via
  `httpWakeHost(url)` (`packages/cli/src/wake-host.ts:24`), wired in `serve.ts` at `serve.ts:434`
  (`--wake-url`/`STACKBASE_WAKE_URL`) and the backstop floor at `serve.ts:435` (`--backstop-min-ms`).

**Passes through untouched. The `RuntimeHost` seam must carry a `WakeHost`, not redefine it.**

### 1.4 Storage — ALREADY a seam (`DocStore` / `DatabaseAdapter`), confirmed

- `interface DocStore` — `packages/docstore/src/types.ts:119` (the engine's persistence contract:
  `commitWrite`/`commitWriteBatch`/`getGlobal`/`writeGlobalIfAbsent`/`close`, …).
- `interface DatabaseAdapter` — `packages/docstore-sqlite/src/adapter.ts:21` (the narrow synchronous
  SQL seam; its own doc-comment at `adapter.ts:1-6` explicitly names **D1** as a valid swap target).
- The engine never constructs a driver: `boot.ts`'s `makeStore` (`packages/cli/src/boot.ts:52`) picks
  SQLite vs Postgres and hands a `DocStore` to `createEmbeddedRuntime` via `options.store`. Slice 2's
  DO-SQLite adapter slots in here (its `ctx.storage.sql.exec` is synchronous — a direct structural
  match for `DatabaseAdapter`).

**Passes through untouched. `RuntimeHost` carries/constructs a `DocStore`; it does not re-model it.**

### 1.5 Lifecycle — boot / driver-start / shutdown, assumes a long-lived process

- **Boot core (shared by `dev` and `serve`):** `bootProject` → `bootLoaded` in
  `packages/cli/src/boot.ts` (result type `BootResult` at `boot.ts:642-679`). It loads modules,
  composes components, opens the store (`makeStore`, `boot.ts:52`), builds the runtime + admin API. It
  is an **async, one-time** operation.
- **Runtime construction + driver start:** `createEmbeddedRuntime` (`runtime.ts:1431`) constructs the
  transactor (`runtime.ts:426-435`), wires the commit fan-out, and (unless `deferDrivers`) starts
  component drivers at create time. Driver lifecycle: `startDrivers()` (`runtime.ts:1349`),
  `stopDrivers()` (`runtime.ts:1322`), `stopDriversInternal()` (`runtime.ts:1300`). Note
  `stopDriversInternal` deliberately does NOT `armWake(null)` (`runtime.ts:1303-1310`) — the durable
  alarm outlives the process, which is exactly the DO-friendly contract.
- **Graceful shutdown (process-only):** `serve.ts`'s `shutdown` (`serve.ts:661`) is bound to
  `process.on("SIGTERM", …)` / `SIGINT` (`serve.ts:682-683`). Order: stop fleet → `server.close()`
  (which itself calls `runtime.stopDrivers()` — `server.ts:317` node / `server.ts:458` bun) →
  `objectStoreRelease()` → `store.close()` (`serve.ts:665-678`).
- **`dev` wiring:** `cli.ts:54` `bootProject` → `cli.ts:67` `startDevServer` → `cli.ts:76`
  `createWatchLoop`, with hot-reload calling `runtime.setModules(...)` + `server.setRoutes(...)`
  (`cli.ts:89-90`).

**The impedance (detailed in §3.2):** the whole shape assumes *boot happens once, the process lives
forever, and a shutdown signal eventually arrives.* A DO boots on every cold wake (inside
`blockConcurrencyWhile`), hibernates silently, and gets **no** shutdown signal.

### 1.6 What in `EmbeddedRuntime` is host-specific vs host-neutral

- **Host-NEUTRAL (all of it):** `EmbeddedRuntime` already takes `store`, `wakeHost`, `now`,
  `fanoutAdapter`, `drivers`, `numShards` etc. as injected options (`EmbeddedRuntimeOptions`,
  `runtime.ts:135-…`). It imports no host primitive. The transactor's `AsyncMutex` is neutral JS
  (§1.2). The `setTimeout` default path is already gated behind `wakeHost` (`runtime.ts:780`). Its
  serving surface is exposed purely as `handler.connect/handleMessage/disconnect` + `handleHttpRequest`
  — transport-agnostic.
- **Host-SPECIFIC (and all in `packages/cli`, not the runtime):** `server.ts` (`Bun.serve`/`node:http`/
  `ws`), `serve.ts` (`process.on` signals, port binding), `boot.ts` (`process.env` reads, concrete
  adapter construction).

So the map is clean: **already behind a seam** → storage (§1.4), timers (§1.3), clock. **Hardcoded to a
long-lived process** → serving (§1.1, needs the new seam), lifecycle orchestration (§1.5, needs the
seam's contract to allow "no shutdown"). **Hardcoded but neutral, needs nothing in Slice 1** → the
mutex (§1.2).

---

## 2. The `RuntimeHost` interface — 3 options + a recommendation

**CRITICAL RULE (from the roadmap):** the interface must contain **no cloudflare types and no
process-specific types** (`Bun`, `node:http`, `ws`, `DurableObjectNamespace`, `Request`-from-a-specific-
lib). It is the neutral seam. Where a concept cannot be expressed neutrally, §3 says so explicitly.

Shared vocabulary used by all three options (all already exist, no new types):

```ts
// ServerHandle === today's DevServer (packages/cli/src/server.ts:49). Neutral already.
interface ServerHandle {
  readonly url: string;
  readonly port: number;              // a DO host returns 0 / a sentinel — see §3.2
  close(): Promise<void>;
  setRoutes(routes: ResolvedRoute[]): void;
}
```

### Option A — Fat `RuntimeHost` (bundle all five, as the roadmap sketched)

```ts
interface RuntimeHost {
  serve(runtime: EmbeddedRuntime, options: ServeOptions): Promise<ServerHandle>;
  singleWriter(): WriterGate;         // NEW type; process = AsyncMutex-backed, DO = identity
  wake: WakeHost;                     // re-exposed
  storage: DocStore;                  // re-exposed
  now(): number;                      // re-exposed
}
```

- **Existing process host implements it:** `serve` = today's `startDevServer`; `singleWriter` returns
  an `AsyncMutex`-backed gate; `wake`/`storage`/`now` forward the values `boot.ts`/`serve.ts` already
  compute.
- **A future DO host implements it:** `serve` maps Worker `fetch`+WS-hibernation → `handleHttpRequest`
  + `handler.connect`; `singleWriter` returns an identity gate (the DO is serial); `wake` = a
  `storage.setAlarm`-backed `WakeHost`; `storage` = the DO-SQLite `DocStore`; `now` = `Date.now`.
- **Tradeoff:** ONE named thing a host implements — tidy for later slices. BUT it **re-bundles three
  seams that are already clean** (`wake`/`storage`/`now`), and coerces the transactor to consume its
  lock through the host — a large surface, coupling serving (today in `packages/cli`) to storage (today
  in `packages/docstore`). This is precisely the roadmap's stated "biggest risk: over-abstracting."

### Option B — Thin `RuntimeHost`: the serving backend is the only NEW concept (RECOMMENDED)

Model *only* the delta that has no seam yet. Keep `WakeHost`/`DocStore`/`now` exactly where they are —
they remain independent options on `EmbeddedRuntimeOptions`, threaded by `boot.ts` as today.

```ts
// New, in packages/runtime-embedded (see §5 for the where-it-lives decision).
// Contains ZERO process/cloudflare types — only @stackbase/* symbols.
interface RuntimeHost {
  /** Bind this runtime to a transport and start serving. The returned handle's close()/setRoutes()
   *  are the ONLY lifecycle a caller drives post-serve. A host with no shutdown moment (a DO) still
   *  returns a valid handle whose close() may be a no-op — see §3.2. */
  serve(runtime: EmbeddedRuntime, options: ServeOptions): Promise<ServerHandle>;
}

// ServeOptions === today's DevServerOptions (server.ts:57) minus nothing — it is already neutral
// (admin key, dashboard, routes, storageRoutes, deploy, fleet, replicaWriterUrl). It names no host type.
```

The writer-gate question is **explicitly deferred out of the interface** (§3.1 shows it needs no seam
in Slice 1). `wake`/`storage`/`now` are NOT members — they are already injected into the runtime before
`serve()` is ever called.

- **Existing process host implements it:** `class ProcessRuntimeHost implements RuntimeHost` whose
  `serve` IS today's `startDevServer` (the `detectRuntime()` bun/node split becomes its private
  detail). Callers change from `startDevServer(runtime, opts)` to `host.serve(runtime, opts)` — a
  one-line substitution in `cli.ts:67` and `serve.ts:481`.
- **A future DO host implements it (Slice 3):** `class DurableObjectRuntimeHost implements RuntimeHost`
  whose `serve` wires Worker `fetch` → `handleHttpRequest` and `WebSocketPair`/hibernation →
  `handler.connect`; it needs no other member because `wake`/`storage`/`now` were already injected when
  its transactor-DO built the runtime.
- **Tradeoff:** the smallest possible new surface (one method). Does not re-wrap already-clean seams.
  The "cost" is that a host is configured in two places — the already-existing runtime options
  (`store`/`wakeHost`/`now`) AND the new `RuntimeHost.serve`. That is honest: those ARE two different
  concerns (what the engine runs on vs. how bytes reach it), and they already live apart today.

### Option C — No umbrella type: two independent seam extractions

Extract a `ServeBackend` interface (identical to Option B's `RuntimeHost.serve`, just un-named as a
"host") in `packages/cli`, AND separately make the transactor's mutex an injectable `WriterGate`.

- **Tradeoff:** least conceptual weight, but produces **no single named thing** the later slices
  consume — Slice 3's spec would have to reference "the serve backend interface plus the writer-gate
  option" as a pair. A named `RuntimeHost` is easier to build a DO host against and to assert
  neutrality on. Also spends effort on the writer gate that §3.1 shows Slice 1 doesn't need.

### Recommendation: **Option B**

Reasoning:
1. **Resists over-abstraction** (the roadmap's named biggest risk) — one new method, not five members.
2. **Honors what already shipped** — `WakeHost` (change #2) and `DocStore` are seams; re-bundling them
   (Option A) would be churn with no payoff and would risk a merge-drift against the shipped wake work.
3. **Gives later slices exactly one named seam to implement** — better than Option C's nameless pair.
4. **Buildable with zero behavior change** — `serve()` is a rename of `startDevServer`; nothing in the
   engine, transactor, or storage moves.

**Neutrality proof obligation (a Slice-1 gate, §4):** the file defining `RuntimeHost`/`ServeOptions`/
`ServerHandle` must import only from `@stackbase/*` and TS stdlib — no `bun`, `node:*`, `ws`, or
cloudflare. This is asserted mechanically (§4, task 4).

**Impedance mismatch surfaced by the rule (§3):** two concepts do NOT cross the seam cleanly and are
called out rather than papered over — the writer gate (§3.1) and the process-shaped lifecycle (§3.2).

---

## 3. The impedance mismatches (adversarial)

Where the DO model genuinely does not fit behind a clean interface. Slice 1 owns two of the four named
changes' *seam implications*: mutex→serial and lifecycle/hibernation.

### 3.1 Mutex → serial: NOT actually a Slice-1 mismatch (the adversarial finding)

The roadmap and research (change #1) frame "in-memory single-writer mutex → the DO's serial model" as
Slice-1 work. Examined against the code, **it forces no engine change in Slice 1**:

- `AsyncMutex` (`async-mutex.ts`) is pure promise-chain JavaScript. It uses no OS mutex, no
  `SharedArrayBuffer`, no worker, no process primitive. It runs unchanged inside a V8 isolate / a DO.
- On a single-threaded DO it simply never contends: every `runExclusive` finds the chain empty and
  resolves on the next microtask. Correct, ~microsecond overhead, zero behavior difference.
- A DO only hibernates when idle (no in-flight request), so the promise chain is always empty at
  hibernation — nothing in-flight is lost. Safe by construction.

So the mutex is **host-neutral as written** and Slice 1 can leave `packages/transactor` completely
untouched. What change #1 *really* names is the **write-throughput ceiling** (one writer DO ≈ 200–500
w/s) — and the fix for that is **sharding** (`.shardBy`, Slice 6), not the mutex mechanism. The mutex
is not the bottleneck; the single serial DO is. Conflating the two would misdirect Slice 1.

**The genuine (small) mismatch:** if a future DO host wants to shave the microtask overhead, it would
inject an identity `WriterGate`. That is a Slice-3 micro-optimization, not a Slice-1 correctness need.
**Whether to introduce the `WriterGate` seam at all is a human decision — see §5, decision 1.** The
recommendation is: **do not** — leave `AsyncMutex` hardcoded and neutral; revisit only if Slice 3
measures the overhead as material (it will not, at ≤500 commits/s).

### 3.2 Lifecycle / hibernation: the real mismatch — engine assumes a long-lived process

Three concrete assumptions in the current code that a DO breaks. None *block* Slice 1 (there is no DO
yet), but the `RuntimeHost` contract must not bake them in.

1. **"Boot happens once."** `bootProject`/`bootLoaded` (`boot.ts`) and `createEmbeddedRuntime`
   (`runtime.ts:1431`) are async and moderately heavy (load modules, compose components, open + schema
   the store, seed the deployment-id global, start drivers). A process pays this once. A **DO
   reconstructs on every cold wake** (after hibernation/eviction) and must run its async boot inside
   `blockConcurrencyWhile(...)` in the DO constructor. Implication for the seam: `RuntimeHost.serve`
   must not assume the runtime it receives is freshly booted-once — the DO host owns re-running boot per
   wake behind its own door. Slice 1 does not solve DO boot; it must only avoid a contract that says
   "serve is called once per process lifetime." Option B's `serve(runtime, options): Promise<Handle>`
   is called-once-per-*host*-instance, which a DO satisfies (one call per DO incarnation). ✔ neutral.

2. **"A shutdown signal eventually arrives."** `serve.ts` binds teardown to `SIGTERM`/`SIGINT`
   (`serve.ts:682-683`) and runs `server.close()`→`stopDrivers()`→`store.close()`. **A DO gets no such
   signal** — hibernation and eviction are silent. Implication: `ServerHandle.close()` must be
   OPTIONAL-in-effect — a valid host may implement it as a no-op (a DO never "closes"; it hibernates,
   and its durable alarm — the shipped wake seam — is what re-animates driver work). The process host
   keeps calling `close()` on SIGTERM exactly as today. The interface must not *require* that a
   `close()` ever be called. Option B satisfies this: `close()` exists on the handle for hosts that
   have a shutdown moment; the contract does not promise it runs. ✔ neutral, but **must be documented
   on the interface** so a later DO host author does not assume `store.close()`/`stopDrivers()` are
   reliably invoked. (Good news: `stopDriversInternal` already refuses to cancel the durable alarm on
   teardown — `runtime.ts:1303-1310` — so even the process path is already DO-shaped here.)

3. **"Per-session subscription state lives in RAM for the server's lifetime."** `SyncProtocolHandler`
   holds each session's read-set in memory (behind `handler.connect`/`handleMessage`). In a process
   this persists until disconnect. On a DO, **WS hibernation discards in-memory state** — this is
   research change #3 (serialize per-socket read-set into the 16 KB attachment, rehydrate on revival).
   **This is explicitly a Slice-3 sync-DO problem, NOT Slice 1.** The Slice-1 obligation is only
   *negative*: the serving seam must treat `handler.connect(sessionId, socket)` /
   `handler.disconnect(sessionId)` as the transport boundary and **not** design anything that assumes
   the handler's in-memory session map survives a `serve()` lifetime — so a Slice-3 DO host can
   reconstruct a session from the attachment and call `connect` on revival without fighting the seam.
   `port` on `ServerHandle` is the mirror concern: a DO has no TCP port; the field stays for the
   process host, and a DO host returns a sentinel (0). Flagged in §5, decision 3.

**Summary:** §3.1 dissolves (no Slice-1 change). §3.2 is real but is satisfied by Option B *provided*
the interface documents that `close()` may never be called and the session map must not be assumed
persistent. Those two doc-contracts are the actual deliverable of "absorbing the impedance" in Slice 1.

---

## 4. Slice-1 build order (bite-sized, TDD)

Recommended interface = Option B. Each task is independently testable; the suite stays green after
every one. Real paths; assertions named. (The exact test counts in the acceptance gate should be
re-confirmed by running the suite at task 6 — the roadmap cites 83 CLI files / 340 tests, typecheck
72/72 as the baseline.)

**Task 1 — Define the seam (types only).**
- Add `packages/runtime-embedded/src/host.ts` (see §5 decision 2 for the location call) exporting
  `interface RuntimeHost`, `interface ServerHandle`, `interface ServeOptions`. `ServerHandle`/
  `ServeOptions` are lifted verbatim from today's `DevServer`/`DevServerOptions` (`server.ts:49`/`57`)
  so no field changes. Re-export from `packages/runtime-embedded/src/index.ts`.
- TDD: a `packages/runtime-embedded/test/host.contract.test.ts` that only *type-checks* (a `satisfies`
  assertion the process host will fill in task 2). Red → compiles once the types exist.
- Gate: `bun run typecheck` green; no runtime behavior touched.

**Task 2 — Reimplement the process host on the seam (zero behavior change).**
- In `packages/cli/src/server.ts`, wrap the existing `startBunServer`/`startNodeServer` as
  `class ProcessRuntimeHost implements RuntimeHost { serve = startDevServer }` (or a thin object). The
  bun/node `detectRuntime()` split stays its private internal — no logic moves.
- Replace the two call sites: `cli.ts:67` and `serve.ts:481` call `host.serve(runtime, opts)` instead
  of `startDevServer(runtime, opts)`. Keep `startDevServer` as a thin back-compat export (or delete and
  update imports — a mechanical grep; `startDevServer` is imported in `cli.ts:14`, `serve.ts:10`,
  `binary-main.ts`).
- TDD: the existing E2E suite is the oracle — `packages/cli/test/*-e2e.test.ts` (action, http-action,
  deploy, storage, optimistic, outbox, triggers, workflow, …) must pass unchanged, because the wire
  behavior is byte-identical. Add `packages/cli/test/process-host.test.ts` asserting
  `new ProcessRuntimeHost() satisfies RuntimeHost` and that a booted runtime served through it answers
  `GET /api/health` 200 and round-trips a `POST /api/run` mutation + a WS subscribe→commit→push (mirror
  the smallest existing e2e).
- Gate: full `bun run test` green; `docker-config.test.ts` untouched.

**Task 3 — Document the two impedance contracts on the interface (the §3.2 deliverable).**
- Doc-comment on `ServerHandle.close()`: "MAY never be called — a host without a shutdown moment (a
  Durable Object hibernates silently) is valid; do not rely on `close()`/`store.close()` running."
- Doc-comment on `ServeOptions`/`serve`: "the sync handler's per-session state is NOT guaranteed to
  survive a `serve()` lifetime (WS hibernation discards it); a host may reconstruct a session and call
  `handler.connect` on revival." Add `port` sentinel note (a DO returns 0).
- TDD: none (docs). Reviewed at the gate.

**Task 4 — Neutrality assertion (the CRITICAL RULE gate).**
- Add `packages/runtime-embedded/test/host-neutral.test.ts`: read `src/host.ts` and assert its import
  specifiers match only `@stackbase/*` (or type-only TS) — no `bun`, `node:`, `ws`, `cloudflare`,
  `DurableObject`. A simple source-scan test (the same style as `docker-config.test.ts`'s text
  assertions).
- Also assert (grep-style) that `DurableObjectNamespace` appears nowhere under `packages/` or
  `components/` (roadmap acceptance criterion).
- Gate: green.

**Task 5 — Prove `Bun.serve`/`node:http` are no longer owned by the caller.**
- Assert (source-scan test, or just the diff at review) that `Bun.serve` / `createServer` from
  `node:http` are referenced ONLY inside the process-host impl (`server.ts`), and that `cli.ts` /
  `serve.ts` reach serving exclusively through `RuntimeHost.serve`. This is the roadmap's "the server
  no longer directly owns `Bun.serve`/`node:http`" criterion.

**Task 6 — Green the container + R2 path end-to-end through the new seam.**
- Run the full suite + typecheck; re-confirm the counts against the roadmap baseline.
- Boot the container path (`docker compose up` per `docs/enduser/self-hosting.md`) OR the R2 gate
  (`stackbase serve --object-store s3+https://…`, per the wake-seam spec's measured context) and
  confirm `/api/health` + a `POST /api/run` mutation commit + read-back — all now flowing through
  `ProcessRuntimeHost.serve`. Behavior byte-identical.
- Gate = the roadmap's Slice-1 acceptance gate: container+R2 boots+serves through the seam; full suite
  green; no `DurableObjectNamespace` in engine packages; serving no longer directly owned by the caller.

**Explicitly NOT in Slice 1** (deferred, with the reason): the DO host itself (Slice 3); relocating
`http-handler.ts` to a neutral package (do it in Slice 3 when the DO host needs to import it — moving
it now is churn with no consumer); any `WriterGate` seam (§3.1 — not needed); WS-hibernation /
16 KB-attachment work (change #3, Slice 3); the DO-SQLite adapter (Slice 2).

---

## 5. Human design decisions to confirm (do not unilaterally decide)

1. **Writer gate: introduce a `WriterGate` seam, or leave `AsyncMutex` hardcoded?** (§3.1)
   Recommendation: **leave it hardcoded** — it is host-neutral and needs no seam for the DO path; a
   gate is an unneeded abstraction in Slice 1 and a deferrable micro-optimization even in Slice 3. But
   the roadmap listed mutex→serial in Slice 1's scope, so this is a deliberate scope trim that wants a
   yes. *Load-bearing:* if you want the DO host to inject an identity gate later, deciding "no seam now"
   means Slice 3 adds the injection point then.

2. **Where does the `RuntimeHost` type live?** Options: (a) `packages/runtime-embedded` (recommended —
   it is the neutral runtime home the seam serves, and the DO host in Slice 3 will depend on
   `runtime-embedded` anyway); (b) a new tiny `packages/runtime-host` (cleaner dependency story but a
   new package for one interface); (c) stay in `packages/cli` (rejected — the DO host must implement it
   without depending on the CLI). Recommendation: **(a)**.

3. **`ServerHandle.port` on a portless host + the session-persistence contract** (§3.2 item 3).
   Recommendation: keep `port` and let a DO return `0`; document the sync-handler session map as
   non-persistent. Confirm this is acceptable vs. modeling a richer handle now (not recommended —
   YAGNI until Slice 3).

4. **Do the already-clean seams (`WakeHost`/`DocStore`/`now`) get re-bundled into `RuntimeHost`
   (Option A) or referenced as-is (Option B)?** This is the core §2 recommendation. Recommendation:
   **Option B (do not re-bundle).** Flagged because Option A matches the roadmap's literal sketch, so
   choosing B is a deliberate, reasoned divergence from the sketch (which the roadmap itself labels
   "NOT final").

5. **`http-handler.ts` relocation timing.** Recommendation: **defer to Slice 3** (move it to a neutral
   package only when the DO host needs to import it). Confirm you are OK with the DO host depending on
   `packages/cli` transitively in the interim, or prefer to relocate now.

---

## Appendix — evidence index (file:line)

| Concern | Where | Seam status |
|---|---|---|
| Serving dispatch | `packages/cli/src/server.ts:465` (`startDevServer`), `:368`/`:374` (Bun.serve), `:197`/`:200`/`:277` (node+ws) | **No seam — Slice 1 target** |
| Server handle shape | `server.ts:49-55` (`DevServer`) | Reusable as `ServerHandle` |
| HTTP dispatch (pure) | `server.ts:250`/`:405` → `packages/cli/src/http-handler.ts` (imports only `@stackbase/*`, `:6-13`) | Neutral; relocate in Slice 3 |
| WS engine surface | `server.ts:297`/`:434` `handler.connect`; `packages/sync/src/handler.ts:44-54` (`SyncWebSocket`), `:293`/`:382`/`:303` | Already neutral |
| Single-writer mutex | `packages/transactor/src/async-mutex.ts:6`; `shard-writer.ts:255` (`new AsyncMutex()`), used `:358`/`:487`/`:636`/`:659` | Hardcoded but host-NEUTRAL (§3.1) |
| Timers / wake | `packages/component/src/define-component.ts:44-64`; `runtime.ts:172`/`:701-744`/`:773-789`/`:1290`; `cli/src/wake-host.ts:24`; `serve.ts:434-435` | **Already a seam (shipped)** |
| Storage | `packages/docstore/src/types.ts:119` (`DocStore`); `docstore-sqlite/src/adapter.ts:21` (`DatabaseAdapter`, names D1); `boot.ts:52` (`makeStore`) | **Already a seam** |
| Clock | `runtime.ts:160` (`now?: () => number`) | Already an option |
| Boot core | `packages/cli/src/boot.ts` `bootProject`/`bootLoaded`, `BootResult` `:642-679` | Process-shaped lifecycle (§3.2) |
| Runtime create + transactor | `runtime.ts:1431` (`createEmbeddedRuntime`), `:426-435` (transactor pick) | Neutral |
| Driver lifecycle | `runtime.ts:1349` (`startDrivers`), `:1322` (`stopDrivers`), `:1300-1316` (`stopDriversInternal`, no `armWake(null)` `:1303-1310`) | Neutral; DO-shaped already |
| Graceful shutdown | `serve.ts:661` (`shutdown`), `:682-683` (SIGTERM/SIGINT), `:665-678` (order); `server.ts:317`/`:458` (`stopDrivers` in close) | Process-only (§3.2) |
| Dev wiring / reload | `cli.ts:54`/`:67`/`:76`/`:89-90` | Process-only |
