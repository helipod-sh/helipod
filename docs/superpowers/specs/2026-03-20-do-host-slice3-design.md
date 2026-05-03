# Slice 3 — the single-shard Durable Object host: design spec

**Date:** 2026-03-20
**Status:** DESIGN SPEC (no engine code changed). Turns into a `superpowers:writing-plans` TDD plan next.
**Branch:** from `spike/cloudflare-r2-gate`.
**Scope:** Slice 3 of `docs/superpowers/plans/2026-03-20-cloudflare-do-native-host-roadmap.md` — assemble the
shipped seam (Slice 1), the shipped DO-SQLite adapter (Slice 2), and the shipped wake seam into ONE
runnable Cloudflare-native host: a Durable Object that owns the writer + DO-SQLite + WebSockets + the
subscription index, fronted by a stateless Worker, proven end-to-end against **real** Cloudflare.

**Reads this builds on (all committed on this branch):**
- Roadmap Slice 3 (`…/plans/2026-03-20-cloudflare-do-native-host-roadmap.md:113-138`)
- Research: hard limits + decomposition (`docs/dev/research/cloudflare-do-native-host.md`)
- Slice 1 `RuntimeHost` seam — SHIPPED (`packages/runtime-embedded/src/host.ts`, proposal
  `docs/superpowers/specs/2026-03-20-runtimehost-seam-proposal.md`)
- Slice 2 DO-SQLite adapter — SHIPPED (`packages/docstore-do-sqlite/`, its `README.md`)
- Wake seam — SHIPPED (`docs/superpowers/specs/2026-03-20-do-alarm-driver-seam-design.md`)
- `SyncProtocolHandler` (`packages/sync/src/handler.ts`)
- References: Lunora `ShardDO`/`SessionDO`/`SocketAttachment`/`subscription-delivery.ts`
  (`.reference/lunora/packages/do/src/`), Concave `ConcaveDO`/`SyncDO`
  (`.reference/concave-docs-raw/llms-full.txt:2218-2257`, `:184-208`).

---

## TL;DR — the load-bearing findings, up front

1. **ONE DO for Slice 3, not two.** The roadmap and research both sketch a transactor-DO + sync-DO
   split ("Concave splits them"). Read against the actual references, that split is a **multi-region
   scale-out artifact, not a single-shard requirement** — and adopting it in Slice 3 would *manufacture*
   the very DO-to-DO RPC ordering problem the roadmap then asks us to solve. **Lunora's `ShardDO` holds
   the writer, DO-SQLite, the WebSockets, AND the subscription index in one object** (`.reference/lunora/
   packages/do/src/shard-do.ts` — a single 363 KB class; `SessionDO` is auth-only, NOT a sync-DO — see
   §1.3, an adversarial correction to the research doc's mapping). For single-shard, one DO is simpler,
   has one less hop, and makes the invalidation path an **in-process function call** — so the shipped
   G1/G4 frontier ordering guarantees survive **because there is no RPC hop to cross** (§2). Recommend
   one DO; defer the split to Slice 6 where cross-region sync sharding actually needs it.

2. **The 16 KB attachment stores the subscription *definition*, never the read-set.** Lunora's
   `SocketAttachment.subs` persists `{ functionPath, args, sinceSeq, sinceEpoch }` per subscription
   (`.reference/lunora/packages/do/src/types.ts:204-285`) — the *recipe to re-derive* the read-set, not
   the read-set itself. On revival the DO re-runs the query, which re-records the read-set the engine
   already tracks. This is what makes 16 KB realistic, and it maps **exactly** onto our shipped
   subscription-resume path (`sinceTs` + content fingerprint → `QueryUnchanged`; `handler.ts:444`). §3.

3. **Boot-per-wake is real but bounded.** App modules are **statically bundled into the Worker at deploy**
   (the `stackbase build` static-import-entrypoint pattern, already shipped — see §4), so per-wake boot
   is *compose components + open the store handle + start drivers*, not *scan a directory + transpile*.
   It runs in `blockConcurrencyWhile` in the DO constructor. Measure it in the E2E; if it dominates,
   `deferDrivers` is the release valve.

4. **Inline execution works in a DO isolate for Slice 3.** The engine's executor is pure JS over the
   isolate-ready syscall ABI; no `node:*` I/O primitive on the mutation/query path. Worker Loader
   sandboxing is Slice 4 — inline-in-the-DO first, exactly as the roadmap says (`:126`). §5.

5. **The honest gate is a real-Cloudflare E2E** — `wrangler deploy` a fixture app, subscribe over a real
   WebSocket, commit a mutation, assert the reactive push, and **measure write latency** to confirm the
   co-located DO-SQLite path beats the ~1.5 s container→R2 number. Plus land the deferred
   `vitest-pool-workers` `runInDurableObject` conformance run for `docstore-do-sqlite` here (§6).

6. **Named frictions the shipped pieces DON'T just absorb** (§ throughout, collected in §8): the
   handler's `setInterval` sweep + `socket.ping` heartbeat are **process-shaped and must be disarmed on a
   DO** (hibernation kills them; keepalive moves to `setWebSocketAutoResponse`); `node:crypto`'s
   `createHash` in the handler needs `nodejs_compat`; the commit fan-out must stay **inline in the write
   turn** (not `waitUntil`-deferred) to preserve G4; and the `SQLITE_FULL` message text stays UNVERIFIED
   until this slice's real-DO run.

---

## 1. The DO decomposition — ONE DO (the load-bearing decision)

### 1.1 What the two references actually do

**Lunora — unified.** `ShardDO` is a single Durable Object class that owns *everything* for a shard: the
SQLite database (`state.storage.sql`), the OCC writer (its single thread IS the mutex), the hibernatable
WebSockets (`state.acceptWebSocket`, `shard-do.ts:7339`), the subscription index (the union of every live
socket's attachment — `getWebSockets()` + `deserializeAttachment()`, `shard-do.ts:6104`), and the wake
alarm (`storage.setAlarm`, `shard-do.ts:197`). A write's fan-out is a plain method call inside the same
object: the write handler snapshots the changed-table set (`shard-do.ts:2045`) and calls
`flushChangedTables()` (`:2068` / `:5950`), which re-runs the affected live subscriptions
(`refreshSubscriptions`, `:6103`) and pushes frames — **no RPC, no second DO**. `SessionDO`
(`.reference/lunora/packages/do/src/session-do.ts`) is a *separate* concern entirely: auth-session
storage keyed by token prefix, HTTP-only, never a sync socket in it.

**Concave — split.** `ConcaveDO` (execution: run mutation, compute read/write ranges, "**Notifies SyncDO
of affected ranges**") and `SyncDO` (subscriptions: track each client's read ranges, "**Receives write
notifications from ConcaveDO**", intersect, push) — `llms-full.txt:2222-2239`. The Worker routes `/api` →
a **singleton** `ConcaveDO` and `/sync` → a `SyncDO` **shard chosen by hash**, with per-region SyncDO
instances (`llms-full.txt:1523-1531`). The split exists so that **many** region-local SyncDOs can fan a
single writer's output out to WebSockets near the clients — a multi-region sync-scale topology.

### 1.2 Recommendation: one DO for Slice 3

Adopt **Lunora's unified model**. The transactor-DO and sync-DO live in the same object; call it
`StackbaseDO` (the writer + DO-SQLite + WebSockets + subscription index + wake alarm). Reasoning:

- **Slice 3 is single-shard by mandate** (roadmap Global Constraints, `:38-39`). Concave's split buys
  cross-region sync fan-out and independent sync scaling — neither of which a single shard has. Paying
  for it now is scope the slice explicitly defers.
- **It makes §2 (invalidation ordering) trivially correct.** With one DO, "transactor computes changed
  ranges → subscription index intersects read-sets → pushes" is the *same in-process call the container
  path already makes*. The shipped G1/G4 guarantees hold **by construction** — there is no RPC hop to
  reorder across (§2). Splitting first would *create* the ordering problem, then require re-proving G1/G4
  across a hop, for zero single-shard benefit.
- **The subscription index is free.** `getWebSockets()` returns the live sockets; each carries its
  subscription definitions in its attachment. There is no separate index structure to persist and no
  index to keep coherent across a DO boundary.
- **One less cold start on the write path.** A `/api/run` mutation that must also notify a *separate*
  sync-DO pays a second DO wake + RPC per write. Unified, it doesn't.

The Concave split is the **Slice 6** shape: when `.shardBy(key)` creates N writer-DOs and sync sockets
must live in region-local objects, the sync tier separates and the RPC-invalidation protocol (below,
kept as a documented forward-design so Slice 6 doesn't start cold) becomes load-bearing. **Design Slice 3
so the seam between "compute changed ranges" and "notify the subscription index" is a single named method
(`notifyWrites(invalidation)`), so Slice 6 can later make that method an RPC without touching the engine.**

> **Human decision 1 (§7):** one DO vs. two for Slice 3. Recommendation: **one**. This is THE call.

### 1.3 Adversarial correction to the roadmap/research mapping

Both the research doc (`cloudflare-do-native-host.md:53`) and the roadmap (`:131`) map "**sync-DO** (Concave
`SyncDO` / Lunora `SessionDO`)". **Lunora's `SessionDO` is not a sync-DO** — it is auth-session storage
(`session-do.ts:1-37`, "Durable Object that owns auth session state"). Lunora's sync tier is *inside*
`ShardDO`, unsplit. The evidence therefore does **not** show "both references split transactor from sync";
it shows Concave splits and **Lunora does not**. This strengthens the one-DO recommendation: the closest
reference to what we're building (Lunora, a Convex-shaped reactive engine on DO-SQLite) chose unified.

### 1.4 The stateless Worker router — what routes to what

The Worker holds no state; it terminates HTTP/WS and forwards to the (single, for Slice 3) DO instance,
addressed by a fixed name (e.g. `idFromName("default")` — one shard). Routing table:

| Incoming | Forwarded to | Notes |
|---|---|---|
| `GET /api/health` | DO `fetch` | liveness; boots the DO if evicted |
| `POST /api/run` | DO `fetch` | query/mutation/action — the transactor path |
| `POST /api/storage/*` | DO `fetch` | engine-owned file-storage endpoints (reserved routes, §ServeOptions) |
| `GET /sync` (Upgrade: websocket) | DO `fetch` → `WebSocketPair` + `acceptWebSocket` | the reactive socket |
| user `http.ts` routes (exact + prefix) | DO `fetch` | `httpAction`s; the DO owns the resolved route table |
| `/_admin/*` (incl. `/_admin/wake`) | DO `fetch`, admin-key gated | dashboard + the wake fire endpoint |
| dashboard SPA (`/`, assets) | Worker static assets OR DO | key-less, like `serve` (§4) |

The Worker owns ingress; the DO returns `port: 0` from its `ServerHandle` (the shipped sentinel,
`host.ts:34`). One Worker script, one DO class, bundled together (§4). This mirrors Concave's
`getConcaveNamespace`/`getSyncNamespace` binding shape (`llms-full.txt:190-191`) collapsed to a single
namespace.

---

## 2. The invalidation path across the DO boundary — and why there IS no boundary in Slice 3

### 2.1 What the engine does today (in-process)

A mutation commits in the transactor → the commit fan-out computes the `WriteInvalidation` (written
tables + write ranges) → `SyncProtocolHandler.notifyWrites` recomputes every subscription whose recorded
read-set intersects and pushes a version-bracketed `Transition` (`handler.ts` header, `:1188` fan-out
loop). Critically, the shipped **G4 origin-frontier** guarantee threads the committing session's `origin`
tag through the commit's `OplogDelta.origin` so the fan-out advances *that* session's own `version.ts`
past its commit even when it read nothing it subscribes to (`handler.ts:91-107` `runMutation` doc); **G1**
enqueues subscribe-response processing onto the per-session notify tail to close a base-regression race.
Both are properties of a **single ordered fan-out over an in-RAM session map**.

### 2.2 In a unified DO, this path is unchanged

Because the writer and the subscription index are the **same object**, the DO's `/api/run` handler runs
the mutation and then calls the *same* `notifyWrites` on the *same* handler instance in the *same* turn.
The DO's single-threaded execution model means no other request interleaves between the commit and the
fan-out (`shard-do.ts` uses `state.blockConcurrencyWhile` for exactly this serialization, `:171`,
`:2716`). **G1/G4 survive because nothing crosses a process/RPC boundary — it is byte-for-byte the
container path's ordering, running inside a DO.** This is the single biggest reason to pick one DO (§1.2).

**One concrete pitfall to NOT copy from Lunora:** Lunora defers its fan-out off the response path via
`state.waitUntil(this.drainSubscriptionRefreshes())` (`shard-do.ts:5992-5996`) to keep write tail-latency
flat. **We must NOT defer the fan-out that way** — our G4 contract requires the committing session's
frontier to advance *before or exactly as* the client is told its mutation committed
(`MutationResponse.ts`). A `waitUntil` macrotask runs *after* the response is sent, which would let the
`MutationResponse` reach the client before its own origin-frontier advance — the exact G4 violation the
shipped code prevents. **The fan-out stays inline in the write turn, before the `/api/run` response
resolves.** (Coalescing bursts is fine and desirable; deferring past the response is not.) This is a
named divergence from the reference and a load-bearing correctness note for the plan.

### 2.3 Forward-design for Slice 6 (documented, NOT built here)

When Slice 6 splits sync into region-local DOs, `notifyWrites` becomes a DO-to-DO RPC:
transactor-DO computes the `WriteInvalidation` → RPC to each sync-DO holding subscribers → each sync-DO
intersects locally and pushes. To preserve G1/G4 across that hop it must carry the **origin session id +
the commit `ts`** in the RPC payload and the sync-DO must apply the origin-frontier advance *before*
delivering the committing client's `MutationResponse` — i.e. the `MutationResponse` for a
cross-DO write must be gated on the origin sync-DO acknowledging the frontier advance (the same "response
after frontier" ordering, now spanning a hop). **Slice 3 keeps `notifyWrites` a single named method with
an `origin`-carrying payload so this is a later swap, not a rewrite.** Do not build it now.

---

## 3. WS hibernation + the 16 KB attachment (research change #3)

### 3.1 The problem, precisely

`SyncProtocolHandler` holds each session's state in an in-RAM `Map` — `this.sessions.set(sessionId, {
socket, version, identity, privileged, bp, hb, supportsQueryDiff })` (`handler.ts:299`) — plus the
per-session subscriptions with their recorded read-sets (in `SubscriptionManager`). A DO **hibernates
after ~seconds idle and discards all in-memory state** while keeping the WebSockets alive
(`cloudflare-do-native-host.md:24`). On revival the handler is a fresh instance with an empty `sessions`
map, but `state.getWebSockets()` still returns the live sockets. The read-set — being derived state — is
gone and cannot be serialized cheaply (it's index-range intervals, potentially large).

### 3.2 What goes in the attachment: the definition, not the derivation

Follow Lunora exactly (`types.ts:204-285`). Per socket, `serializeAttachment` persists a
`StackbaseSocketAttachment`:

```jsonc
{
  "connectionId": "…",           // stable per-socket id minted at upgrade (Lunora shard-do.ts:7359)
  "identity": "<bearer token|null>", // the verified identity to replay to handler.setAuth on revival
  "subs": {                      // keyed by client subscription id — the RECIPE, not the read-set
    "sub-1": { "udfPath": "messages:list", "args": {…}, "sinceTs": 1234, "fingerprint": "ab12…" }
  }
}
```

- `udfPath` + `args` + `identity` = enough to call `handler.connect` + replay the `Subscribe` and let the
  engine **re-derive** the read-set by re-running the query (the read-set is recorded on every run —
  `handler.ts` `SyncUdfExecutor.runQuery` returns `readRanges`, `:91`).
- `sinceTs` + `fingerprint` = the SHIPPED subscription-resume tokens (`handler.ts:444` DLR Stage 3 resume;
  the content fingerprint → `QueryUnchanged`). On revival we replay the subscribe *carrying the persisted
  `sinceTs`/fingerprint*, so an unchanged query answers with a tiny `QueryUnchanged` instead of a full
  re-send — **the reconnect-resume mechanism doubles as the hibernation-rehydrate mechanism for free.**
- **NOT stored:** the read-set/interval ranges, the backpressure/heartbeat controller state, the
  `byIdRowMap`, the `version` object (re-seeded to the resume `sinceTs`). All are re-derived.

This is what fits 16 KB: N subscriptions × (a function path string + small args + two short tokens). A
typical socket with a handful of live queries is well under 1 KB.

### 3.3 The overflow strategy (16 KB is a real bound)

A socket with many or large-args subscriptions can exceed 16 KB. Strategy, in order:

1. **Cap subscriptions per socket** (Lunora: `MAX_SUBSCRIPTIONS_PER_SOCKET`, enforced at subscribe with a
   typed `TOO_MANY_SUBSCRIPTIONS` error — `shard-do.ts:2213-2217`). Adopt the same cap; it bounds the
   common case and is a clean client-visible error, not a silent truncation.
2. **Externalize the overflow to DO-SQLite.** The DO already owns a 10 GB SQLite. When an attachment
   would exceed a safe budget (say 12 KB, leaving headroom), spill the `subs` map to an internal
   `_ws_subscriptions` table keyed by `connectionId`, and store only `{ connectionId, spilled: true }` in
   the attachment. On revival, a socket whose attachment says `spilled` reloads its subs from SQLite.
   This trades a SQLite read on revival for an unbounded subscription count — and byte I/O is free here
   because we're already in the DO that owns the DB. **Lunora does not do this** (it relies on the cap);
   we add it because our large-args queries (structured filters, pagination cursors) make the cap alone
   riskier. Flag as **human decision 2**: ship the cap-only (simpler, matches Lunora) vs. cap + SQLite
   spill (robust, one more table). Recommendation: **cap-only for Slice 3**, spill deferred to a
   follow-on unless the E2E fixture trips the cap — YAGNI until measured.
3. **A `serializeAttachment` throw is caught and degrades, never crashes** (Lunora swallows it —
   `shard-do.ts:2185-2189`, `:7442`). The subscription still works this turn; it just won't survive the
   next hibernation, and the client's normal reconnect-resume re-establishes it. Loud-log it.

### 3.4 Revival: reconstructing the in-memory session before serving

When any event wakes the DO (a client frame via `webSocketMessage`, or a write-notification turn, or an
alarm), the handler's `sessions` map may be empty for a socket that hibernated. The DO host owns a
**lazy rehydrate**:

```
on webSocketMessage(ws, msg) / before any fan-out touches ws:
  if handler has no session for ws.connectionId:
     att = ws.deserializeAttachment()
     handler.connect(att.connectionId, doSocketWrapper(ws))   // re-creates session state (handler.ts:293)
     if att.identity: handler.setAuth(att.connectionId, att.identity)
     for (subId, sub) of att.subs (or SQLite spill):
        handler.handleMessage(att.connectionId, Subscribe{ subId, udfPath, args, sinceTs, fingerprint })
  // now the session is live; process the actual message / fan-out
```

`handler.connect` re-creates the backpressure + heartbeat controllers and re-seeds `version`
(`handler.ts:297-300`); replaying each `Subscribe` re-derives the read-set and (via `sinceTs`/fingerprint)
sends `QueryUnchanged` for anything unchanged since hibernation. This reuses shipped code paths — the DO
host adds the *orchestration* (deserialize → connect → replay), not new engine surface.

**Important:** rehydrate must be **idempotent and complete before fan-out reads the session**. In a write
turn that fans out to a hibernated socket, the DO must rehydrate that socket's session *first* (so the
read-set exists to intersect against). Lunora sidesteps this by re-reading each socket's attachment inside
`refreshSubscriptions` (`shard-do.ts:6104` reads attachments directly). Our handler intersects against an
in-RAM read-set, so the DO host must rehydrate-then-notify. Simplest correct rule: **on every DO wake,
before serving anything, rehydrate every `getWebSockets()` socket that lacks a live session.** For a shard
holding thousands of idle sockets this is the one genuinely expensive revival step — measure it; if it
dominates, rehydrate lazily per-socket only when the fan-out actually targets that socket (requires
matching against the persisted definition, not the in-RAM read-set, for the *first* post-wake write — a
documented micro-design for the plan).

> **Human decision 3 (§7):** eager rehydrate-all-on-wake (simple, correct, O(sockets) per cold wake) vs.
> lazy per-socket rehydrate (cheaper wake, more complex first-write matching). Recommendation: **eager for
> Slice 3**, revisit under the connection-scale bench.

---

## 4. Boot-per-wake

### 4.1 The impedance (from Slice 1's contract)

Slice 1 §3.2 item 1: a DO reconstructs the runtime on **every cold wake** inside
`blockConcurrencyWhile`, whereas `bootProject`/`createEmbeddedRuntime` are async and moderately heavy
(load modules, compose components, open store, seed the deployment-id global, start drivers)
(`runtimehost-seam-proposal.md:316-324`). The `ServerHandle.close()` may never run
(`host.ts:36-42`); the session map is not persistent (§3).

### 4.2 How app code gets INTO the DO — static bundling at deploy

A DO cannot dir-scan `convex/` at runtime (no filesystem; the Worker is a bundle). App modules must be
**statically imported into the Worker bundle at deploy time** — this is *exactly* the problem
`stackbase build` already solved: `bun build --compile` "only bundles static imports, so the entrypoint
statically imports every module/schema/`stackbase.config.ts`… instead of the dir-scan `stackbase dev`
uses" (CLAUDE.md, single-binary entry). **Slice 3 reuses that static-import-entrypoint codegen**, retargeted
to emit a Worker entry (`worker.ts`) that:

- statically imports every app module + `schema.ts` + `stackbase.config.ts` + the composed components, and
- `export default { fetch }` (the Worker) + `export class StackbaseDO extends DurableObject` (the DO),
- with the module registry handed to the runtime as an in-memory map (the `ModuleRegistry` shape Concave's
  `moduleLoader` also uses — `llms-full.txt:180`, `:193-195`), not a directory.

So the app's functions/schema are **baked into the deployed Worker script**, versioned with it. A new
deploy = a new Worker bundle (there is no hot-swap in Slice 3; `stackbase deploy --allow-deploy` live
push is a container-path feature and is out of scope — like the single binary, "functions, schema, and
the component set are fixed at build time").

### 4.3 What runs per wake, and what's cached

The DO constructor runs boot inside `state.blockConcurrencyWhile(async () => { … })` (Lunora does its
schema/migration setup the same way — `shard-do.ts:2716`). Per-wake cost breakdown:

| Step | Per-wake cost | Mitigation |
|---|---|---|
| Load app modules | **~free** — already static in the bundle; it's a map lookup, no transpile, no I/O | none needed (this is the win over dir-scan) |
| Open the store | cheap — `new DoSqliteAdapter({ sql: ctx.storage.sql, transactionSync: ctx.storage.transactionSync.bind(ctx.storage) })` + `SqliteDocStore` over it (`docstore-do-sqlite/README.md:15-22`); `setupSchema()` is idempotent DDL | run `setupSchema` only when a schema-version marker in SQLite is stale |
| Compose components | moderate — `composeComponents` builds the driver set (scheduler/triggers/storage-reaper) | pure in-memory; unavoidable, measure it |
| `createEmbeddedRuntime` + start drivers | moderate — wires transactor + fan-out, `startDrivers()` peeks tables + arms the wake alarm | `deferDrivers` if it dominates cold-start (drivers re-arm from durable table state anyway — wake-seam design §"Error handling") |

**Nothing durable needs rebuilding that isn't cheap**, precisely because storage is the DO's own
`ctx.storage.sql` (no network open) and modules are pre-bundled. The genuinely-unbounded revival cost is
**session rehydrate** (§3.4), not boot. The E2E must measure cold-wake wall-time end to end; the roadmap's
own container numbers (4.5 s warm cold-start) are the bar to beat, and a DO with no container image pull
should be far under that.

**`close()` may never run** (`host.ts:36-42`) — the DO host's `ServerHandle.close()` is effectively a
no-op; drivers' durable alarms outlive the object (wake-seam design; `runtime.ts:1303-1310`
`stopDriversInternal` already refuses to cancel the alarm on teardown). Good — the shipped code is already
DO-shaped here.

---

## 5. User function execution — inline in the DO isolate

For Slice 3, run user query/mutation JS **inline in the DO** (roadmap `:126`: "Worker Loader (Slice 4) can
be stubbed here — run user JS inline first"). The engine's inline executor is pure JS over the
isolate-ready syscall ABI (CLAUDE.md: "the inline executor runs in-process; the syscall ABI is
isolate-ready"). The mutation/query path touches **no `node:*` I/O primitive** — it reads/writes through
the `DatabaseAdapter` (now `DoSqliteAdapter`, synchronous `sql.exec`) and records read/write ranges. So it
runs unmodified inside the DO's V8 isolate.

- **Syscall-back path stays as-is.** Inline, the executor's syscalls resolve against the same in-DO
  transactor — no marshalling. When Slice 4 moves user JS into a Worker Loader isolate, those same
  syscalls marshal across the isolate boundary (the ABI is already serializable); Slice 3 changes nothing
  about the ABI.
- **Confirm in the E2E**, not by assertion: the real-DO run must execute a real user mutation handler
  inline and commit. This is also where an accidental `node:*`/`Date.now()`-in-a-query determinism leak or
  a workerd API gap would surface (see §8).

One thing to verify against workerd: the handler's `createHash` (`node:crypto`, `handler.ts:9`) used for
the drift checksum / content fingerprint. workerd supports `node:crypto` **only under the
`nodejs_compat` compatibility flag** — the `wrangler.jsonc` must set it (§6.2). Flagged in §8.

---

## 6. The test harness — the honest gate

Slice 2 proved **API-shape only** (conformance against an in-process `node:sqlite` stand-in —
`docstore-do-sqlite/README.md:72-96`). Slice 3 owns the **real-DO** proof. Two deliverables:

### 6.1 The deferred `runInDurableObject` conformance run (the known gap)

Slice 2's README names this explicitly as deferred "like the container smoke was for `serve`… run this
same conformance suite inside a real Durable Object via `@cloudflare/vitest-pool-workers`
(`runInDurableObject`) once the DO host lands (Slice 3)" (`README.md:93-96`). Land it here. Setup required:

- A `vitest.config.ts` using `@cloudflare/vitest-pool-workers` (runs tests inside **workerd**, the real
  runtime, not Node).
- A minimal `wrangler.jsonc` (test fixture) declaring the DO class binding + `compatibility_date` +
  `compatibility_flags: ["nodejs_compat"]` + a `durable_objects` migration (`new_sqlite_classes`, since
  DO-SQLite needs the SQLite-backed class migration tag).
- A test DO that, inside `runInDurableObject(stub, (instance, state) => …)`, constructs
  `DoSqliteAdapter` over the **real** `state.storage.sql` + `state.storage.transactionSync` and drives the
  **existing shared docstore conformance suite** (`@stackbase/docstore/test-support/conformance`) against
  it. Green here = the adapter speaks real DO-SQLite, closing the "SQLite version quirks / real
  `SQLITE_FULL` message text / 10 GB behavior unverified" gap the README names (`:89-91`).
- **Explicitly confirm the `SQLITE_FULL` classifier's real message text** (`docstore-do-sqlite/src/errors.ts:37-45`
  matches on `/\bSQLITE_FULL\b/i` + "database or disk is full"). The task calls this out as UNVERIFIED;
  the real-DO run is where we learn workerd's actual error shape. 10 GB is not reachable in a test, so
  this is verified by asserting the classifier against workerd's *real* error object shape for a smaller
  induced write failure if one is reachable, else documented as still-inferred with the real message text
  captured. Do not claim it verified if 10 GB can't be induced — say what was actually observed.

### 6.2 The flagship real-Cloudflare E2E (the gate)

Per this program's proven discipline — the E2E that caught a false PASS this session (roadmap `:137`) —
**deploy to real Cloudflare**, don't just run workerd locally:

```
1. codegen the fixture app (examples/offline-demo or a minimal reactive fixture) → Worker/DO bundle (§4.2)
2. wrangler deploy  → a real *.workers.dev URL, real DO, real DO-SQLite
3. open a REAL WebSocket to /sync; subscribe to a reactive query
4. open a SECOND client (cross-tab); POST /api/run a mutation that writes the subscribed table
5. ASSERT: client 1 receives the reactive Transition (the write it didn't make)  ← reactivity across DO
6. MEASURE: write latency = time from POST /api/run to its committed MutationResponse
7. ASSERT: that latency is sub-millisecond-class at the storage layer (co-located DO-SQLite), and
   beats the container→R2 number (~1.5 s WAN-measured; the honest in-CF number is unmeasured per the
   wake-seam design's Open Question — this E2E finally measures BOTH ends and reports real deltas)
8. ASSERT persistence: recreate/evict the DO, reconnect, read back the row (DO-SQLite is durable)
9. ASSERT hibernation-resume: subscribe, let the DO hibernate (stay silent — the silence is the test,
   per the wake-seam E2E discipline), commit from another client, assert the hibernated socket wakes and
   receives the push with its read-set REHYDRATED from the attachment (§3), not lost.
```

**Controls, not vibes** (the lesson that caught the false PASS): the write-latency claim must be measured
against the *same* client vantage for both the DO path and the R2 path — do not compare a
laptop-in-Asia→R2 WAN number (1.2 s, explicitly "not the real number" — wake-seam design Open Question)
against an in-datacenter DO number and call it a win. Report the methodology. If single-shard hits the
~200–500 writes/s ceiling under a write-storm sub-test, **that is expected** (single-threaded DO; sharding
is Slice 6) — record the number, don't paper over it (§8).

### 6.3 What each tier proves

| Tier | Runtime | Proves | Status |
|---|---|---|---|
| Slice 2 conformance | Node `node:sqlite` stand-in | adapter speaks the DO SQL *contract* | SHIPPED |
| §6.1 `runInDurableObject` | real workerd | adapter speaks *real* DO-SQLite; `SQLITE_FULL` text | **new, Slice 3** |
| §6.2 deployed E2E | real Cloudflare | the whole host: subscribe→commit→push, latency, hibernation-resume, persistence | **new, Slice 3, the gate** |

---

## 7. Slice-3 build order (bite-sized, TDD) + human decisions

New package: **`packages/runtime-cloudflare`** (the DO host; implements `RuntimeHost`) + a deploy rig
(fixture `wrangler.jsonc` + the Worker/DO entrypoint codegen). All Cloudflare types live here and in the
rig — **never** in `runtime-embedded`/`transactor`/`sync` (roadmap Global Constraints `:27`; enforced by
the same neutrality source-scan Slice 1 shipped).

**Task 1 — Scaffold `packages/runtime-cloudflare` + the DO skeleton.**
- `StackbaseDO extends DurableObject`; constructor runs boot in `state.blockConcurrencyWhile` (§4.3);
  `fetch` routes per §1.4; `webSocketMessage`/`webSocketClose`/`webSocketError`/`alarm` handlers stubbed.
- TDD: a workerd unit test (`vitest-pool-workers`) that constructs the DO and hits `GET /api/health` → 200.
- Gate: green in workerd; neutrality scan (no cloudflare types leaked below this package).

**Task 2 — Implement `RuntimeHost.serve` for the DO (the seam).**
- `class DurableObjectRuntimeHost implements RuntimeHost` (`host.ts:98`): `serve(runtime, options)` wires
  the DO's `fetch` → `handleHttpRequest` (the shipped pure dispatcher) and returns a `ServerHandle` with
  `port: 0`, no-op `close()`, working `setRoutes()` (§1.4, `host.ts` contract).
- TDD: assert `new DurableObjectRuntimeHost() satisfies RuntimeHost`; a `POST /api/run` mutation commits
  through it in workerd and reads back.

**Task 3 — Wire DO-SQLite as the store (Slice 2 adapter).**
- Inject `{ sql: ctx.storage.sql, transactionSync: ctx.storage.transactionSync.bind(ctx.storage) }` into
  `DoSqliteAdapter` → `SqliteDocStore` → `runtime.store` (`docstore-do-sqlite/README.md:15-22`).
- TDD: land §6.1 `runInDurableObject` conformance here. Confirm `SQLITE_FULL` message text (§6.1).

**Task 4 — WebSocket upgrade + hibernation attachment (change #3).**
- `handleWebSocketUpgrade`: `new WebSocketPair()`, `state.acceptWebSocket(server)`, stamp the initial
  `StackbaseSocketAttachment` (`connectionId`, `identity`, `subs:{}`) — mirror `shard-do.ts:7335-7367`.
- `webSocketMessage`: lazy-rehydrate the session from the attachment if absent (§3.4), then drive
  `handler.connect`/`handleMessage`/`setAuth`; persist updated `subs` via `serializeAttachment`
  (catch+degrade, §3.3); enforce the subscribe cap (§3.3).
- Keepalive: `setWebSocketAutoResponse(new WebSocketRequestResponsePair(ping, pong))` (`shard-do.ts:7284-7291`)
  — **disarm the handler's `socket.ping` heartbeat + `setInterval` sweep on this host** (§8).
- TDD (workerd): subscribe → assert `ack` + seed value; simulate hibernation (drop the in-RAM map) →
  next frame rehydrates from the attachment → still serves.

**Task 5 — The invalidation fan-out, inline (change #1 seam).**
- After a `/api/run` mutation commits, call `notifyWrites(invalidation)` **inline in the write turn**
  (NOT `waitUntil` — §2.2) so G4 holds; rehydrate any hibernated target socket first (§3.4).
- Keep `notifyWrites` a single named method carrying the `origin` session id + commit `ts` (the Slice-6
  RPC seam, §2.3).
- TDD (workerd): two sockets, one commits, the other receives the reactive push; assert the committing
  socket's own frontier advanced before its `MutationResponse` (G4).

**Task 6 — Wake alarm (reuse the shipped seam).**
- Implement `WakeHost.armWake(atMs)` via `ctx.storage.setAlarm(atMs)`; DO `alarm()` → `runtime.fireDueTimers()`
  (`do-alarm-driver-seam-design.md`). This is the scheduler/triggers/reaper wake on the DO.
- TDD (workerd): arm a timer, advance the alarm, assert a due driver callback fired.

**Task 7 — Boot-per-wake via the static-import Worker entry (change: bundling).**
- Retarget the `stackbase build` static-import-entrypoint codegen to emit `worker.ts` (§4.2): static
  imports of every module/schema/config/component + `export default { fetch }` + `export { StackbaseDO }`.
- TDD: the fixture app codegens a Worker bundle that `wrangler deploy`s; boot runs per-wake in workerd.

**Task 8 — The deploy rig + `wrangler.jsonc` template.**
- `compatibility_flags: ["nodejs_compat"]`, `durable_objects` binding + `new_sqlite_classes` migration,
  the admin-key + wake-url env wiring (matching `serve`'s config-driven shape, wake-seam design §5).

**Task 9 — The flagship real-Cloudflare E2E (§6.2) — the gate.**
- `wrangler deploy` the fixture; real WebSocket subscribe→commit→push; measure write latency vs the
  container+R2 number; hibernation-resume; persistence-across-eviction. Controls, not vibes (§6.2).

**Task 10 — Deploy-anywhere regression + neutrality gate.**
- Full existing suite + typecheck green (the container+R2 path unchanged); `DurableObjectNamespace`
  appears nowhere under `packages/`/`components/` except `packages/runtime-cloudflare` + the rig.

### Human decisions to confirm (do not unilaterally decide)

1. **One DO or two for Slice 3?** (§1) Recommendation: **one** (unified `StackbaseDO`, Lunora-shaped),
   split deferred to Slice 6. *Load-bearing:* this is THE decision — it determines whether §2's ordering
   is trivial (one DO) or a new RPC protocol to prove (two). The roadmap sketched two; choosing one is a
   deliberate, evidence-backed divergence (§1.3).
2. **Attachment-overflow strategy** (§3.3): cap-only (simple, matches Lunora) vs. cap + SQLite spill
   (robust, one extra table). Recommendation: **cap-only for Slice 3**, spill deferred unless the E2E
   fixture trips the cap.
3. **Revival rehydrate: eager-all-on-wake vs. lazy-per-socket** (§3.4). Recommendation: **eager for
   Slice 3**; revisit under the connection-scale bench (an idle DO holding thousands of sockets pays
   O(sockets) per cold wake — measure before optimizing).
4. **Bundling: reuse the `stackbase build` static-import-entrypoint codegen** retargeted to a Worker/DO
   entry, vs. a new bundling path (§4.2). Recommendation: **reuse**.
5. **Fan-out inline vs. deferred** (§2.2): we diverge from Lunora's `waitUntil` deferral to preserve G4.
   Confirm accepting the (small) write tail-latency cost of an inline fan-out in exchange for the shipped
   ordering guarantee. Recommendation: **inline** (correctness over tail-latency; coalescing bursts is
   still allowed).

---

## 8. Adversarial: where assembling the shipped pieces does NOT just work

Surfaced before an implementer hits them:

1. **The handler's timers are process-shaped and fight hibernation.** `SyncProtocolHandler` runs a
   `setInterval` flush sweep (`FLUSH_SWEEP_MS`, `handler.ts:41`; `clearInterval` in `dispose`, `:341`) and
   a per-session heartbeat that calls `socket.ping` (`SessionHeartbeatController`, `handler.ts:298`,
   `:53`). On a DO: (a) `setInterval` in a DO does **not** keep it alive and is lost on hibernation — a
   silent no-op at best; (b) app-level `ping` frames would **wake the DO** on every heartbeat, destroying
   the scale-to-zero economics that are the whole point (`cloudflare-do-native-host.md:62-68`). **The DO
   host must construct the handler with heartbeat + sweep DISABLED** and use
   `setWebSocketAutoResponse` for a runtime-level ping/pong that never wakes the DO
   (`shard-do.ts:7284-7291`). This means the handler needs an option to disable those controllers (a
   small, additive engine change — or the DO host injects no-op controller options). **Verify the handler
   exposes that knob; if not, adding it is part of Task 4.** This is the sharpest "doesn't just work" edge.

2. **`node:crypto` needs `nodejs_compat`.** `handler.ts:9` `import { createHash } from "node:crypto"`
   (drift checksum / fingerprint). workerd provides `node:crypto` only under the `nodejs_compat`
   compatibility flag — the `wrangler.jsonc` MUST set it (§6.2 / Task 8), or the DO throws at import. A
   Slice-2 stand-in never exercised this because it ran under Node.

3. **The commit fan-out must NOT be `waitUntil`-deferred** (§2.2) — Lunora's pattern violates our G4.
   Easy to copy by accident from the reference; called out as a correctness note on Task 5.

4. **`blockConcurrencyWhile` boot that throws bricks the DO.** If `composeComponents`/`setupSchema` throws
   during the constructor's blocking boot, the DO is unusable until redeploy. Boot must be defensive and
   loud; a schema/component error should surface as a clear deploy-time or first-request error, not a
   silent hang. (The container path gets a process crash + restart; a DO gets a wedged object.)

5. **`SQLITE_FULL` message text is still UNVERIFIED** (§6.1). The classifier
   (`docstore-do-sqlite/src/errors.ts:37-45`) is inferred from SQLite conventions; the real workerd error
   shape is unknown until §6.1 runs. 10 GB may not be inducible in a test — if so, say the text remains
   inferred and record what workerd's real error object actually looks like for the failures that ARE
   reachable. Do not mark it verified on faith.

6. **Single-threaded ~200–500 writes/s is a real ceiling for single-shard.** Expected and by-design
   (research change #1; `cloudflare-do-native-host.md:30-33`) — sharding past it is Slice 6. If the E2E
   write-storm sub-test saturates, **record the number as the honest single-shard limit**, don't hide it.

7. **Rehydrate-before-fan-out ordering** (§3.4): a naive fan-out that intersects an empty post-wake
   read-set would silently miss a hibernated subscriber (it would look like it reads nothing). The DO host
   MUST rehydrate targeted sockets before the intersection runs, or the first post-wake write drops
   pushes. Named as the subtle correctness edge in Task 5.

8. **`DurableObject` requires a concrete class in `wrangler.jsonc`** (Lunora notes the same for `SessionDO`
   — `session-do.ts:196-207`). The codegen'd Worker entry must `export` a concrete `StackbaseDO` the app's
   `wrangler.jsonc` names — one more reason the entry is codegen'd (§4.2), not hand-written per app.

9. **Storage byte I/O (file storage) is action-only and can't run in the transactor turn** — on a DO the
   `BlobStore` would be R2 (kept) or the DO itself; this slice serves the `/api/storage/*` routes (§1.4)
   but full file-storage-on-DO is not a Slice-3 goal. Flag: the fixture app for the E2E should avoid file
   storage, or the rig must bind an R2 bucket. Keep the fixture minimal.

---

## Appendix — evidence index (file:line)

| Concern | Where |
|---|---|
| Roadmap Slice 3 scope | `docs/superpowers/plans/2026-03-20-cloudflare-do-native-host-roadmap.md:113-138` |
| DO hard limits | `docs/dev/research/cloudflare-do-native-host.md:17-27`, four changes `:28-47` |
| `RuntimeHost`/`ServerHandle`/`ServeOptions` (shipped seam) | `packages/runtime-embedded/src/host.ts:28-109` (port sentinel `:34`, close-may-never-run `:36-42`, session-non-persistent contract `:47-58`) |
| DO-SQLite adapter injection contract | `packages/docstore-do-sqlite/src/do-adapter.ts:148-197`; README wiring `README.md:15-22`; deferred `runInDurableObject` `README.md:93-96` |
| `SQLITE_FULL` classifier (unverified text) | `packages/docstore-do-sqlite/src/errors.ts:37-45` |
| Wake seam (`armWake`/`fireDueTimers`/backstop) | `docs/superpowers/specs/2026-03-20-do-alarm-driver-seam-design.md`; `runtime.ts:1303-1310` (alarm outlives teardown) |
| Sync handler session map (in-RAM) | `packages/sync/src/handler.ts:293-337` (connect/disconnect/reap), `:299` (`sessions.set`) |
| Handler process-shaped timers | `handler.ts:9` (`node:crypto`), `:41` (`FLUSH_SWEEP_MS`), `:298` (heartbeat), `:341` (`clearInterval`) |
| Subscription-resume tokens (double as rehydrate) | `handler.ts:444` (DLR Stage 3 `sinceTs`), `SyncUdfExecutor.runQuery` readRanges `:91` |
| G4 origin frontier / MutationResponse ordering | `handler.ts:91-107` (`runMutation` origin/dedup), `:353-372` (undroppable MutationResponse) |
| Lunora unified `ShardDO` (writer+sync+index in one) | `.reference/lunora/packages/do/src/shard-do.ts` (WS upgrade `:7330-7368`, `webSocketMessage` `:2132`, `flushChangedTables` `:5950`, `refreshSubscriptions` `:6103`, `getWebSockets` index `:6104`, `blockConcurrencyWhile` `:2716`, keepalive auto-response `:7284-7291`, `waitUntil` defer `:5992`) |
| Lunora `SocketAttachment` (definition, not read-set) | `.reference/lunora/packages/do/src/types.ts:204-285`; delivery `subscription-delivery.ts:186-265` |
| Lunora `SessionDO` is auth-only (NOT a sync-DO) | `.reference/lunora/packages/do/src/session-do.ts:1-37` |
| Concave split (ConcaveDO notifies SyncDO — RPC) | `.reference/concave-docs-raw/llms-full.txt:2222-2239`; routing `:1523-1531`; CF binding shape `:184-208` |
</content>
</invoke>
