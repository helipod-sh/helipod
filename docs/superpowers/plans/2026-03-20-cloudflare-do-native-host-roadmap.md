# Cloudflare-Native DO Host — Program Roadmap

> **For agentic workers:** This is a PROGRAM roadmap across 6 slices/subsystems, not a single
> bite-sized plan. Slice 1 is buildable now and detailed here. Slices 2–6 are scoped milestones —
> each gets its OWN `superpowers:brainstorming` → spec → `superpowers:writing-plans` cycle before
> implementation, because their per-step code depends on the `RuntimeHost` interface that Slice 1
> produces. Writing bite-sized code for them now would fabricate types that don't exist yet.

**Goal:** The SAME Stackbase app code runs on a new Cloudflare-native path (Durable Objects +
DO-SQLite, co-located writer, scales cheaply like Lunora) AND the existing container+R2/S3 path
(portable: Fly/Railway/Docker/VPS), both behind seams — the R2 path is KEPT, not replaced.

**Architecture:** Extract a `RuntimeHost` seam so the existing engine (transactor, OCC, query
engine, reactivity, sync) runs either in a long-lived process OR inside Durable Objects. A stateless
Worker routes to a transactor-DO (writer + DO-SQLite, single-threaded = the mutex) and sync-DOs
(WebSockets + subscription index, hibernated). User functions run in a Worker Loader sandbox that
syscalls back via the already-isolate-ready ABI.

**Tech stack:** TypeScript, Bun/Turborepo, `@cloudflare/containers`, wrangler, Durable Objects,
DO-SQLite (`ctx.storage.sql`), Worker Loader, R2 (kept). Tests: vitest under Node + E2E through real
Cloudflare via `wrangler deploy`.

**Source of truth:** `docs/dev/research/cloudflare-do-native-host.md` (verdict, hard limits, risks).

## Global Constraints (verbatim from research + locked project decisions)

- **The engine must NEVER import a host primitive.** No `DurableObjectNamespace`, no cloudflare types
  in `packages/` or `components/`. The DO code lives in a new `runtime-cloudflare` host + the rig.
- **Same app code both paths.** A user's `convex/` + `stackbase.config.ts` is byte-identical on
  DO-native and container+R2. Only the host differs.
- **DO hard limits to design against:** DO-SQLite **10 GB/object** (hard `SQLITE_FULL`); memory
  **128 MB billed flat**; **single-threaded** (~200–500 writes/s per shard); WS hibernation
  attachment **16 KB/socket**; hibernation loses in-memory state (rebuild from storage); Worker
  Loader is **open-beta, paid-only** (Mar 2026).
- **Change #2 (setInterval → DO alarms) is ALREADY DONE** — the shipped `WakeHost`/`backstopMs` seam
  (`docs/superpowers/specs/2026-03-20-do-alarm-driver-seam-design.md`). The DO host implements
  `armWake` via `storage.setAlarm`. Reuse; do not rebuild.
- **Scope: single-shard FIRST.** The cross-shard query/index layer (Slice 6) is the biggest risk and
  is explicitly deferred behind a single-shard-only milestone that must ship and prove out first.
- Deploy-anywhere must stay green at every slice: the container+R2 path and all existing tests pass
  unchanged after every merge.

---

## Slice ordering & dependency graph

```
Slice 1 (RuntimeHost seam)  ──┬─→ Slice 2 (DO-SQLite adapter) ──┐
   [buildable now]            │                                  ├─→ Slice 3 (single-shard DO host) ─→ Slice 5 (E2E + migration tool)
                              └─→ Slice 4 (Worker Loader sandbox)┘                                        │
                                                                                                          └─→ Slice 6 (multi-shard + cross-shard query layer)  [DEFERRED — biggest risk]
```

Slice 1 unblocks everything and is worth doing even if the DO host never ships (it also cleans up the
container path — the server is currently tangled into `packages/cli`). Build it first, in isolation.

---

## Slice 1 — Extract the `RuntimeHost` seam  ← START HERE

**What it delivers:** the engine's server/host responsibilities pulled out of `packages/cli` into a
neutral interface, with the EXISTING process host reimplemented on top of it. Zero behavior change;
the container+R2 path and all tests stay green. This is the enabler; no Cloudflare code yet.

**Why first:** every later slice consumes this interface. Its shape is the single most important
design decision in the program — get it wrong and the DO host leaks primitives into the engine.

**Needs a spec before code?** YES — a short one. The interface shape is a real design decision
(what exactly a host must provide: serve/upgrade, the single-writer guarantee, timers via the
existing WakeHost, storage handle, lifecycle). Run `superpowers:brainstorming` → spec first, scoped
to JUST the interface + the process-host reimplementation. Then `writing-plans` for the bite-sized
TDD plan.

**Interface sketch (to be pinned in the spec — NOT final):**
```
interface RuntimeHost {
  serve(handler): { url; close() }            // process: Bun.serve/node:http+ws; DO: Worker fetch/WS
  singleWriter(): WriterGate                  // process: async-mutex; DO: the DO's serial model
  wake: WakeHost                              // ALREADY EXISTS (armWake) — reuse verbatim
  storage: DatabaseAdapter                    // ALREADY EXISTS (SQLite/PG/DO-SQLite)
  now(): number
}
```

**Acceptance gate:** container+R2 path boots and serves through the new seam; full suite green
(83 CLI files / 340 tests, typecheck 72/72); no `DurableObjectNamespace` anywhere in engine packages;
the server no longer directly owns `Bun.serve`/`node:http` — those live behind the process host impl.

**Biggest risk in this slice:** over-abstracting. The seam should be the MINIMUM that lets a DO and a
process both satisfy it. Resist modeling DO-specific concepts (RPC, hibernation) in the interface —
those belong inside the DO host impl, hidden from the engine.

---

## Slice 2 — DO-SQLite `DatabaseAdapter`

**Delivers:** `@stackbase/docstore-do-sqlite` — the existing `DatabaseAdapter` contract over
`ctx.storage.sql.exec` (synchronous, which MATCHES the existing SQLite adapter shape — easier than
the async Postgres one).

**Depends on:** nothing in this program (the adapter contract already exists). Can run parallel to
Slice 1. Ship against the shared docstore conformance suite (as SQLite/PG/PGlite already do).

**Needs a spec?** Minimal — it's a conformance-driven adapter. A design note on the 10 GB ceiling
behavior (surface `SQLITE_FULL` as a typed error, not a crash) suffices; then straight to a plan.

**Gate:** passes the full shared docstore conformance suite, run inside a real DO (via
`@cloudflare/vitest-pool-workers`, `runInDurableObject`). Confirm 10 GB `SQLITE_FULL` is a clean
typed rejection.

---

## Slice 3 — Single-shard DO host (transactor-DO + sync-DO + Worker router)

**Delivers:** `@stackbase/runtime-cloudflare` — the DO host implementing `RuntimeHost`. One shard.
- **transactor-DO:** owns the writer + DO-SQLite (Slice 2); the DO's single-thread IS the mutex/OCC.
  Implements `armWake` via `storage.setAlarm` (reuse the shipped wake seam).
- **sync-DO:** owns WebSockets + the subscription index, using **WS hibernation**; per-socket read-set
  state serialized into the **16 KB attachment**, rehydrated on revival. Change #3 lands here.
- Stateless **Worker** router forwards `/api/*` to the transactor-DO, `/sync` to a sync-DO.
- Invalidation crosses the DO boundary by RPC: transactor computes changed ranges → notifies sync-DOs
  → they intersect against read-sets → push. Preserve the shipped G1/G4 frontier ordering guarantees
  across the RPC hop.

**Depends on:** Slice 1 (the seam), Slice 2 (the adapter). Worker Loader (Slice 4) can be stubbed
here (run user JS inline first) and hardened later.

**Needs a spec?** YES — a substantial one. The DO decomposition, the RPC invalidation protocol, the
16 KB attachment serialization strategy, and the hibernation rebuild-from-storage path are all real
design. `brainstorming` → spec → `writing-plans`. Reference Concave's ConcaveDO/SyncDO and Lunora's
ShardDO/SessionDO (both in `.reference/`).

**Gate (E2E through REAL Cloudflare, per this session's proven discipline):** deploy the offline-demo
app on the DO host; a mutation commits sub-millisecond (co-located DO-SQLite, NOT the ~1.5s R2 path);
a reactive subscription in one tab sees another tab's write; measure write latency and confirm it
beats the container+R2 number. Use the same "controls, not vibes" rigor that caught the false PASS
this session.

---

## Slice 4 — Worker Loader sandbox for user JS

**Delivers:** untrusted user query/mutation/action functions run in a Worker Loader isolate with
`globalOutbound: null` (no egress), able ONLY to syscall back to the transactor-DO via the existing
isolate-ready ABI. This is the multi-tenant safety story.

**Depends on:** Slice 3 (needs a transactor-DO to syscall back to). Worker Loader is **open-beta,
paid-only** — de-risk EARLY with a spike before committing the slice (confirm the ABI marshals across
the isolate boundary as designed).

**Needs a spec?** YES — the syscall marshalling across the Worker Loader boundary is the crux.

**Gate:** a user function that tries `fetch()` is blocked; one that does `ctx.db.insert` succeeds via
the syscall path; a malicious function can't read another tenant's data.

---

## Slice 5 — Migration tool + production polish

**Delivers:** the R2-object-store path and the DO-SQLite path are DIFFERENT data topologies (shared
log vs per-shard isolated) — data does not teleport. Ship an export-from-one/import-to-the-other tool
so an app can MOVE between the portable and DO-native deployments. Plus: `wrangler.jsonc` templates,
docs, the `{"ready":...}`-parity startup contract, honest cost/latency numbers from Slice 3's E2E.

**Depends on:** Slice 3 (a working DO host to migrate to/from).

**Needs a spec?** Light — mostly mechanical once the two topologies are stable.

**Gate:** an app created on container+R2 exports and re-imports onto the DO host with identical query
results; docs updated (the enduser Cloudflare page, honestly, per this session's docs discipline).

---

## Slice 6 — Multi-shard + cross-shard query/index layer  ← DEFERRED (biggest risk)

**Delivers:** `.shardBy(key)` → one transactor-DO per shard (horizontal write scale past the
single-DO ~200–500 writes/s ceiling), PLUS cross-shard queries and global secondary indexes.

**Why deferred + flagged as the biggest risk:** single-shard DO-SQLite is easy and fast. The moment
an app needs a query spanning shards or a global unique index, this becomes distributed-query
machinery. Lunora leans on **D1's Sessions API** (read-your-writes) for exactly this. Do NOT attempt
until Slices 1–5 ship and the single-shard host is proven in production. It may warrant its own
research pass before a spec.

**Depends on:** everything above, in production.

**Needs a spec?** YES — the heaviest in the program, possibly its own research first.

**Gate:** a query across 4 shards returns correct merged results; a global unique-index violation is
rejected; write throughput scales ~linearly with shard count up to the tested N.

---

## Program-level self-review

- **Coverage:** the 4 named engine changes from the research map to slices — #1 mutex→serial (Slice
  1 seam + Slice 3 transactor-DO), #2 setInterval→alarms (DONE, reused in Slice 3), #3 in-memory
  subscription state→16 KB attachment (Slice 3 sync-DO), #4 R2-truth→sharded storage + cross-shard
  (Slice 2 adapter + Slice 6 cross-shard). ✓
- **Portability preserved:** every slice keeps the container+R2 path green (Global Constraints). ✓
- **Risk front-loaded where cheap, deferred where expensive:** Worker Loader spike early (Slice 4
  de-risk note); cross-shard deferred behind a proven single-shard host (Slice 6). ✓
- **No fabricated code:** deliberately NOT writing bite-sized TDD steps for Slices 3–6, whose types
  depend on the Slice 1 `RuntimeHost` interface that doesn't exist yet — each gets its own spec→plan
  cycle at the right time. This is the honest granularity for a multi-subsystem program. ✓

## Recommended next action

Start **Slice 1** with `superpowers:brainstorming` scoped to the `RuntimeHost` interface + the
process-host reimplementation — in a FRESH full-context session. Slice 1 is the highest-leverage,
lowest-risk, buildable-now work, and it improves the container path regardless of whether the DO host
ever ships.
