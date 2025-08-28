# Fleet Slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** N identical `stackbase serve --fleet` processes over one shared Postgres: lease-based single writer, sync nodes serving reads/subscriptions and forwarding writes, live failover ≤ ~2s.

**Architecture:** Spec = `docs/superpowers/specs/2025-08-28-fleet-slice1-design.md`. The store is the coordinator: `pg_try_advisory_lock` (mutual exclusion) + a `fleet_lease` row (discovery). Sync nodes run the normal runtime against a read-only `PostgresDocStore`, get commit wake-ups via `LISTEN/NOTIFY` + 1s poll, derive invalidation ranges from the existing `indexes` table, and forward mutations/actions/httpActions to the writer over admin-key-authenticated HTTP. Fleet implementations live in `ee/packages/fleet` (commercial license); FSL core gets only small seams.

**Tech Stack:** TypeScript, Bun workspaces + Turborepo, `pg` (node-postgres), PGlite for hermetic PG tests, vitest under Node, Docker-gated `postgres:16` E2E.

## Global Constraints

- Without `--fleet`, serve behavior is **byte-for-byte today's** (second node fails fast on the advisory lock). Every task must keep the existing full suite green.
- Tests run under **Node/vitest — no Bun APIs in test files**. Cross-package tests resolve deps via built `dist/` → run `bun run build` before running dependent tests. vitest does not typecheck → run `bun run typecheck` before calling a task done.
- New files in `ee/packages/fleet` get the header comment `/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */`. New/modified files under `packages/` stay FSL (no header change).
- Env/flag names exactly: `--fleet` / `STACKBASE_FLEET=1`, `--advertise-url` / `STACKBASE_ADVERTISE_URL`. NOTIFY channel exactly `stackbase_commits`. Internal route exactly `POST /_fleet/run`. Table exactly `fleet_lease` (schema per spec §2).
- Lease retry interval 2000ms; sync poll fallback 1000ms; forward retry: refresh `writer_url` once, then surface the error.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

**Verified ground truth (do not re-derive):** `EmbeddedRuntimeOptions.fanoutAdapter` already exists (`packages/runtime-embedded/src/runtime.ts:66`); WS mutations execute inside the runtime's `syncExecutor` closures (~`runtime.ts:200-225`), NOT in `packages/cli/src/server.ts` (which only pipes bytes to `runtime.handler.handleMessage`); `/api/run` is handled in `packages/cli/src/http-handler.ts:100`; `MonotonicTimestampOracle.observeTimestamp(ts)` exists (`packages/docstore/src/timestamp-oracle.ts:34`) and is the designed promotion-correctness hook; oracle seeded once at `create()` from `store.maxTimestamp()` (`runtime.ts:~128`); drivers start inside `create()` (`runtime.ts:~335`, `for (const d of drivers) await d.start(driverCtx)`); advisory lock: `PgClient.acquireWriterLock` (`packages/docstore-postgres/src/pg-client.ts:20`, `ADVISORY_LOCK_KEY` same file) called from `postgres-docstore.ts:62` in `setupSchema`; `indexes` table columns `(index_id, key, ts, table_id, internal_id, deleted)` (`packages/docstore-postgres/src/schema.ts:14`); root workspaces globs are `packages/*, components/*, examples/*, apps/*` (`package.json`) — `ee/packages/*` must be added; E2E container pattern to copy: `packages/cli/test/postgres-e2e.test.ts`.

---

### Task 1: ee/ workspace scaffolding + `@stackbase/fleet` skeleton

**Files:**
- Create: `ee/LICENSE`, `ee/packages/fleet/package.json`, `ee/packages/fleet/tsconfig.json`, `ee/packages/fleet/tsup.config.ts`, `ee/packages/fleet/src/index.ts`, `ee/packages/fleet/test/smoke.test.ts`
- Modify: root `package.json` (workspaces)

**Interfaces:**
- Produces: workspace package `@stackbase/fleet` buildable by turbo; `ee/LICENSE` referenced by later headers.

- [ ] **Step 1:** Add `"ee/packages/*"` to root `package.json` → `workspaces.packages` (after `"apps/*"`).
- [ ] **Step 2:** Write `ee/LICENSE`:

```
Stackbase Commercial License (Enterprise)

Copyright (c) 2026 Stackbase.

This directory (ee/) and everything under it is NOT covered by the license of the
rest of this repository. It is source-available for reference and, at present, free
to use in production (no license key is required yet — see
docs/dev/business-model-and-licensing.md, "The two phases"). It may not be copied,
modified, or distributed as part of a product or service that competes with
Stackbase. A commercial license activating paid entitlements will govern future
releases of this directory; code in ee/ never converts to an open-source license.
```

- [ ] **Step 3:** Create `ee/packages/fleet/package.json` (mirror `packages/docstore-postgres/package.json` structure: `"name": "@stackbase/fleet"`, `"version": "0.0.0"`, `"type": "module"`, `"license": "SEE LICENSE IN ../../LICENSE"`, main/module/types → `dist/`, scripts build=`tsup`, test=`vitest run`, typecheck=`tsc --noEmit`, clean; dependencies: `"pg": "^8.13.1"`, `"@stackbase/docstore-postgres": "workspace:*"`, `"@stackbase/docstore": "workspace:*"`, `"@stackbase/runtime-embedded": "workspace:*"`, `"@stackbase/index-key-codec": "workspace:*"`; devDependencies: `"@electric-sql/pglite": "^0.2.17"`, `"@types/pg": "^8.11.10"`, `"@types/node": "catalog:"`, `"tsup": "catalog:"`, `"typescript": "catalog:"`, `"vitest": "catalog:"`). Copy `tsconfig.json`/`tsup.config.ts` from `packages/docstore-postgres/` (adjust relative extends path if the base tsconfig is referenced — VERIFY how sibling packages extend the root tsconfig and mirror it with `../../..`-adjusted paths).
- [ ] **Step 4:** `ee/packages/fleet/src/index.ts`:

```ts
/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
export const FLEET_VERSION = "0.0.0";
```

- [ ] **Step 5:** `ee/packages/fleet/test/smoke.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { FLEET_VERSION } from "../src/index";

describe("@stackbase/fleet scaffolding", () => {
  it("builds and imports", () => {
    expect(FLEET_VERSION).toBe("0.0.0");
  });
});
```

- [ ] **Step 6:** `bun install && bun run build && bun run --filter @stackbase/fleet test` — expect install links the package, build includes `@stackbase/fleet`, smoke test passes. Run `bun run test` (full) — everything else still green.
- [ ] **Step 7:** Commit: `feat(ee): scaffold ee/ workspace + @stackbase/fleet package (commercial license)`

---

### Task 2: docstore-postgres core seams — try-lock, read-only mode, listen/notify

**Files:**
- Modify: `packages/docstore-postgres/src/pg-client.ts`, `packages/docstore-postgres/src/node-pg-client.ts`, `packages/docstore-postgres/src/postgres-docstore.ts`, `packages/docstore-postgres/src/index.ts`, `packages/docstore-postgres/test/pglite-client.ts`
- Test: `packages/docstore-postgres/test/read-only.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 4–6):
  - `PgClient.tryAcquireWriterLock(): Promise<boolean>` — non-blocking `SELECT pg_try_advisory_lock(<ADVISORY_LOCK_KEY>)`; PGlite test client returns `true` (single-connection, contention unobservable — same rationale as its `acquireWriterLock` no-op).
  - `NodePgClient.listen(channel: string, onNotify: (payload: string) => void): Promise<() => Promise<void>>` — dedicated `pg.Client` connection issuing `LISTEN <channel>`, invoking `onNotify(msg.payload)`; returned function closes it. `NodePgClient.notify(channel: string, payload: string): Promise<void>` — `SELECT pg_notify($1, $2)`.
  - `new PostgresDocStore(client, { readOnly?: boolean })` — `readOnly: true` → `setupSchema()` runs DDL but takes NO lock; `write()` throws `ReadOnlyStoreError`. `store.setWritable(): void` flips the flag off (promotion; caller must already hold the advisory lock). `store.client` (or an accessor `pgClient()`) exposed so fleet code reuses the same `PgClient` — VERIFY current field visibility and prefer a narrow getter.
  - `export class ReadOnlyStoreError extends Error` from the package index.
- [ ] **Step 1 (failing test):** `read-only.test.ts` — construct `new PostgresDocStore(new PgliteClient(), { readOnly: true })`, `await setupSchema()`, assert a `write(...)` rejects with `ReadOnlyStoreError`; then `store.setWritable()` and assert the same write resolves; assert `tryAcquireWriterLock()` resolves `true` on PGlite. (Reuse an existing write fixture from `packages/docstore-postgres/test/write-get.test.ts` for the write payload shape.)
- [ ] **Step 2:** Run it — FAIL (option/type/method don't exist).
- [ ] **Step 3:** Implement: add the methods to the `PgClient` interface + `NodePgClient` (try-lock via `pg_try_advisory_lock`; `listen` with a second `pg.Client` created lazily from the same connection config; `notify` via `pg_notify`) + `PgliteClient` (`tryAcquireWriterLock: async () => true`; `listen`/`notify` may be implemented via PGlite's live query/notify support if trivial, else throw `new Error("listen/notify not supported on PGlite test client")` — E2E covers the real path). `PostgresDocStore`: store `readOnly` flag; guard in `write()`; skip `acquireWriterLock` in `setupSchema` when readOnly; add `setWritable()`.
- [ ] **Step 4:** Test passes; run the whole `docstore-postgres` package suite (conformance must stay green — default construction unchanged).
- [ ] **Step 5:** `bun run typecheck`. Commit: `feat(docstore-postgres): try-lock, read-only mode + setWritable, listen/notify — fleet seams`

---

### Task 3: runtime-embedded seams — WriteRouter, observeTimestamp, deferred drivers

**Files:**
- Modify: `packages/runtime-embedded/src/runtime.ts`, `packages/runtime-embedded/src/index.ts`
- Test: `packages/runtime-embedded/test/write-router.test.ts`

**Interfaces:**
- Produces (consumed by Task 6):

```ts
export interface WriteRouter {
  /** true → execute writes locally (this node is the writer). Checked per call (role flips on promotion). */
  isLocalWriter(): boolean;
  /** Forward a write to the writer node; resolves with the function's JSON result or throws. */
  forward(kind: "mutation" | "action", path: string, args: JSONValue, identity: string | null): Promise<JSONValue>;
}
// EmbeddedRuntimeOptions additions:
//   writeRouter?: WriteRouter
//   deferDrivers?: boolean        // create() skips d.start(); startDrivers() runs them later
// EmbeddedRuntime additions:
//   startDrivers(): Promise<void>            // idempotent; starts drivers not yet started
//   observeTimestamp(ts: bigint): void       // delegates to the transactor's oracle
```

- Behavior: when `writeRouter` is set and `isLocalWriter()` is false, **every mutation/action entry point** routes through `writeRouter.forward(...)` instead of local execution: the `syncExecutor.runMutation`/`runAction` closures (WS path, `runtime.ts:~200-225`) and the public `run`/`runAction` methods (HTTP `/api/run` path). Queries are NEVER routed. The oracle must be reachable: keep a private reference to the `MonotonicTimestampOracle` constructed in `create()` and pass it through the constructor (follow the existing pattern of threading `create()` locals into the private constructor).
- [ ] **Step 1 (failing test):** `write-router.test.ts` — boot an `EmbeddedRuntime` on `SqliteDocStore(:memory:)` (copy the minimal catalog/modules fixture pattern from an existing runtime-embedded test — VERIFY one exists, e.g. a runtime or loopback test, and reuse its fixture helper) with a fake router `{ isLocalWriter: () => false, forward: vi.fn(async () => 42) }`. Assert: `runtime.run("mod:someMutation", {...})` resolves `42` and `forward` was called with `("mutation", "mod:someMutation", args, null)`; a query still executes locally (forward NOT called); flipping the fake to `isLocalWriter: () => true` makes the mutation execute locally again. Second test: `deferDrivers: true` with a stub driver asserts `start` not called at create, then `await runtime.startDrivers()` calls it exactly once (idempotent on second call). Third: `observeTimestamp(100n)` then a local mutation commits at ts > 100n (assert via the store's `maxTimestamp()`).
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement per the interface block. **Step 4:** Package suite green (existing tests unchanged — new options are optional). **Step 5:** `bun run build && bun run typecheck`, commit: `feat(runtime-embedded): WriteRouter forwarding seam, observeTimestamp, deferred driver start`

---

### Task 4: `@stackbase/fleet` — LeaseManager + `fleet_lease`

**Files:**
- Create: `ee/packages/fleet/src/lease.ts`
- Modify: `ee/packages/fleet/src/index.ts` (re-export)
- Test: `ee/packages/fleet/test/lease.test.ts`

**Interfaces:**
- Consumes: `PgClient` (query/tryAcquireWriterLock) from Task 2.
- Produces (consumed by Task 6):

```ts
/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
export interface LeaseState { epoch: bigint; writerUrl: string }
export class LeaseManager {
  constructor(client: PgClient, opts: { advertiseUrl: string; retryMs?: number }) // retryMs default 2000
  /** Idempotent DDL: CREATE TABLE IF NOT EXISTS fleet_lease (spec §2). */
  setup(): Promise<void>
  /** One non-blocking attempt: tryAcquireWriterLock(); on success upserts fleet_lease (epoch=epoch+1, writer_url=advertiseUrl, acquired_at=now()) and returns the new state; on failure returns null. */
  tryAcquire(): Promise<LeaseState | null>
  /** Loop tryAcquire() every retryMs until success; resolves with the state. stop() cancels. */
  acquireLoop(onAcquired: (s: LeaseState) => void): void
  stop(): void
  /** Read current lease row (discovery for forwarding); null if none. */
  read(): Promise<LeaseState | null>
}
```

Upsert SQL (single statement, no read-modify-write race — the advisory lock already serializes acquirers, this is belt-and-braces):

```sql
INSERT INTO fleet_lease (id, epoch, writer_url, acquired_at)
VALUES (1, 1, $1, now())
ON CONFLICT (id) DO UPDATE SET epoch = fleet_lease.epoch + 1, writer_url = $1, acquired_at = now()
RETURNING epoch, writer_url
```

- [ ] **Step 1 (failing test):** on `PgliteClient`: `setup()` creates the table; `tryAcquire()` returns `{epoch: 1n, ...}` (PGlite try-lock is always true); a second `tryAcquire()` on the same manager returns `epoch: 2n` (upsert increments); `read()` returns the latest row; `acquireLoop` fires `onAcquired` once then `stop()` halts it (use fake timers or a small retryMs). Note in the test header: real lock *contention* is covered only by the Task 7 E2E.
- [ ] **Steps 2–5:** fail → implement → pass → `bun run typecheck`, commit: `feat(fleet): LeaseManager — advisory-lock lease + fleet_lease discovery row`

---

### Task 5: `@stackbase/fleet` — CommitNotifier (NOTIFY wrapper + LISTEN/poll + range derivation)

**Files:**
- Create: `ee/packages/fleet/src/commit-notifier.ts`
- Modify: `ee/packages/fleet/src/index.ts`
- Test: `ee/packages/fleet/test/commit-notifier.test.ts`

**Interfaces:**
- Consumes: `InMemoryWriteFanoutAdapter`, `EmbeddedWriteFanoutAdapter` + its publish payload type (from `@stackbase/runtime-embedded` — VERIFY the payload type name/fields in `packages/runtime-embedded/src/write-fanout.ts`; it carries serialized written ranges/tables + commit ts); `NodePgClient.listen/notify` (Task 2).
- Produces (consumed by Task 6):

```ts
/** Writer side: wraps the in-memory adapter; every publish ALSO does pg_notify('stackbase_commits', String(commitTs)). */
export class NotifyingFanoutAdapter implements EmbeddedWriteFanoutAdapter { constructor(inner: EmbeddedWriteFanoutAdapter, client: NodePgClient) /* delegate publish/subscribe; NOTIFY after inner.publish */ }

/** Sync side: LISTEN stackbase_commits + pollMs fallback; on wake, derive invalidation since watermark and hand it to the runtime. */
export class CommitTailer {
  constructor(client: NodePgClient, store: PostgresDocStore, opts: {
    pollMs?: number;                       // default 1000
    onInvalidation: (inv: DerivedInvalidation) => Promise<void>;  // Task 6 wires this to handler-notify + observeTimestamp
  })
  start(): Promise<void>   // seeds watermark = await store.maxTimestamp()
  stop(): Promise<void>
}
export interface DerivedInvalidation {
  newMaxTs: bigint;
  writtenTables: string[];               // DISTINCT table_id casts to string
  writtenKeys: Array<{ indexId: string; key: Uint8Array }>;  // point invalidation input
}
```

Derivation query (parameterized, bigint-safe):

```sql
SELECT index_id, key, table_id, ts FROM indexes WHERE ts > $1 AND ts <= $2 ORDER BY ts ASC
```

where `$2` = `store.maxTimestamp()` read at wake. If zero rows → no-op (spurious wake). `CommitTailer` holds `watermark` in memory; advances it to `newMaxTs` only after `onInvalidation` resolves.

**Design note for the implementer:** the conversion of `writtenKeys` → the sync handler's `WriteInvalidation.writtenRanges` (point ranges) happens in Task 6 where the handler types are in scope; this task produces the raw derived rows. Point range for key `k` = `[k, successor(k))` using the key-codec's successor/compare helpers (`@stackbase/index-key-codec` — VERIFY the exact helper for "successor"/upper-bound of a key; if none exists, a point range can be `{start: k, end: k concat 0x00}` consistent with the codec's ordering — confirm against how recorded read ranges encode point lookups in `packages/query-engine`).

- [ ] **Step 1 (failing test):** on PGlite: seed a store with 2 writes at ts t1,t2 (reuse the write fixture from Task 2's test); construct `CommitTailer` with `pollMs: 20` and a recording `onInvalidation`; `start()`; perform a third write at t3; await until the callback fires; assert `writtenKeys` contains exactly t3's index keys, `writtenTables` matches, `newMaxTs === t3`, and the callback does NOT re-deliver t1/t2 (watermark seeded at start). Then `stop()` halts polling. (PGlite listen may be unsupported → this test exercises the poll path, which is the correctness path; NOTIFY is latency-only and covered in E2E.) Second test: `NotifyingFanoutAdapter` delegates publish/subscribe to a stub inner adapter and calls `client.notify("stackbase_commits", <ts>)` per publish (stub NodePgClient-like object).
- [ ] **Steps 2–5:** fail → implement → pass → typecheck, commit: `feat(fleet): CommitTailer (LISTEN+poll, range derivation from indexes) + NotifyingFanoutAdapter`

---

### Task 6: serve integration — fleetNode lifecycle, /_fleet/run, WriteForwarder, httpAction proxy

**Files:**
- Create: `ee/packages/fleet/src/forwarder.ts`, `ee/packages/fleet/src/node.ts`
- Modify: `packages/cli/src/serve.ts` (flags), `packages/cli/src/boot.ts` (readOnly store + runtime options passthrough — VERIFY `bootProject` options at `packages/cli/src/boot.ts:227` and thread `fleet?: {...}` through), `packages/cli/src/http-handler.ts` (`/_fleet/run` route + sync-role proxy branches). Do NOT add `@stackbase/fleet` to `packages/cli/package.json` — core stays clean; serve loads it via dynamic `import("@stackbase/fleet")` resolved from the app's node_modules (the workspace link suffices in this monorepo).
- Test: `packages/cli/test/fleet-flags.test.ts` (flag parsing + fail-fast errors, no containers)

**Interfaces:**
- Consumes: everything above. Produces the running system.
- `WriteForwarder implements WriteRouter` (from Task 3):

```ts
/* forwarder.ts */
export class WriteForwarder implements WriteRouter {
  constructor(lease: LeaseManager, opts: { adminKey: string; selfUrl: string })
  private role: "sync" | "writer" = "sync";
  promote(): void { this.role = "writer"; }
  isLocalWriter(): boolean { return this.role === "writer"; }
  async forward(kind, path, args, identity): Promise<JSONValue> {
    // POST `${writerUrl}/_fleet/run` with Authorization: Bearer <adminKey>,
    // body JSON {path, args, identity, kind}. On network error / non-200: refresh
    // writerUrl via lease.read(), retry ONCE, then throw with the response error message.
    // 200 body: {value} → return value; {error} → throw new Error(error).
  }
}
```

- `fleetNode()` in `node.ts` — the composition serve calls:

```ts
export interface FleetHandles {
  role(): "sync" | "writer";
  onPromoted(cb: () => void): void;   // http layer flips proxy behavior off
  stop(): Promise<void>;
}
export async function startFleetNode(deps: {
  client: NodePgClient; store: PostgresDocStore; runtime: EmbeddedRuntime;
  lease: LeaseManager; forwarder: WriteForwarder;
}): Promise<FleetHandles>
// Behavior:
//  - lease.setup(); tailer = new CommitTailer(client, store, { onInvalidation }) where
//    onInvalidation converts writtenKeys → WriteInvalidation point ranges, calls
//    runtime.observeTimestamp(inv.newMaxTs) then runtime.handler.notifyWrites(wireInv).
//    (VERIFY notifyWrites' exact parameter type in packages/sync and construct it fully.)
//  - lease.acquireLoop(onAcquired): on acquire → PROMOTION ORDER (critical):
//      1. runtime.observeTimestamp(await store.maxTimestamp())   // oracle past all history
//      2. store.setWritable()
//      3. forwarder.promote()                                    // local writes now execute
//      4. await tailer.stop()                                    // writer uses its own fanout
//      5. await runtime.startDrivers()                           // scheduler/reaper wake
//      6. fire onPromoted callbacks
//    (lease row already upserted by tryAcquire before onAcquired fires)
```

- **Boot flow in serve** (writer-or-sync decided by ONE `tryAcquire()` before runtime construction):
  - Parse `--fleet`/`STACKBASE_FLEET`, `--advertise-url`/`STACKBASE_ADVERTISE_URL`. `--fleet` without `databaseUrl` → exit "fleet mode requires --database-url (Postgres)". `--fleet` without advertise URL → exit with example. Dynamic `await import("@stackbase/fleet")` in a try/catch → exit "fleet mode requires @stackbase/fleet — install it (bun add @stackbase/fleet)" on failure.
  - Fleet path constructs the store itself (readOnly first), does `lease.setup()` + one `tryAcquire()`:
    - **acquired → writer boot:** `store.setWritable()`; runtime with `fanoutAdapter: new NotifyingFanoutAdapter(new InMemoryWriteFanoutAdapter(), client)`, drivers normal, `writeRouter` = forwarder already promoted.
    - **not acquired → sync boot:** runtime with `deferDrivers: true`, `writeRouter: forwarder` (role sync), then `startFleetNode(...)` (tailer + acquireLoop).
  - VERIFY how much of store/runtime construction `bootProject` owns and add a `fleet` options object to it rather than duplicating boot logic — serve stays thin, dev never passes it.
- **HTTP layer (`http-handler.ts`):**
  - `POST /_fleet/run`: require `Authorization: Bearer <adminKey>` (reuse the existing admin-auth check used by `/_admin/*` — VERIFY its helper name); parse `{path, args, identity, kind}`; `kind === "action"` → `runtime.runAction(path, args, identity)` else `runtime.run(path, args, {identity})` (VERIFY exact public signatures in runtime.ts); respond `{value}` or 500 `{error: message}`. Route registered on all nodes (harmless on writer, becomes live target after any promotion).
  - Sync-role proxy for public httpActions: where `http.ts` routes dispatch (VERIFY the "User httpAction routes" block in `http-handler.ts`), if `fleetHandles && fleetHandles.role() === "sync"` → `fetch(writerUrl + originalPathAndQuery, {method, headers, body})` and stream back status/headers/body verbatim. `/api/run` needs NO branch — it calls `runtime.run`, which the WriteRouter already routes.
- [ ] **Step 1 (failing test):** `fleet-flags.test.ts` — unit-test the serve arg parser (export it if not already): `--fleet` sets flag, env fallback works, missing database-url and missing advertise-url produce the exact error strings above (test the validation function, not a spawned process).
- [ ] **Step 2–4:** fail → implement all wiring → parser test passes; `bun run build && bun run typecheck && bun run test` (full monorepo — no-fleet paths must be untouched; expect all green).
- [ ] **Step 5:** Commit: `feat(fleet,cli): symmetric fleet node — lease lifecycle, write forwarding, /_fleet/run, httpAction proxy`

---

### Task 7: Fleet E2E ship gate (real containers, real processes, failover)

**Files:**
- Create: `ee/packages/fleet/test/fleet-e2e.test.ts`
- Modify: `ee/packages/fleet/package.json` (devDeps needed to drive the client — VERIFY what `packages/cli/test/postgres-e2e.test.ts` uses to open a WS subscription and reuse: likely `@stackbase/client` + `ws`)

**Interfaces:** consumes the shipped `stackbase` CLI (`packages/cli/dist/bin.js`) — run `bun run build` first (dist resolution convention).

- [ ] **Step 1:** Copy the harness skeleton from `packages/cli/test/postgres-e2e.test.ts`: `dockerAvailable()` → `describe.skip` gate, `postgres:16` on an OS-assigned port, `pg_isready` wait loop, `spawn` real `bun <repo>/packages/cli/dist/bin.js serve` processes with `STACKBASE_ADMIN_KEY`, cleanup in `afterAll` (kill processes, `docker rm -f`).
- [ ] **Step 2 (the test, written to fail until the fixture app + flags line up):** one `describe` with a single long `it` (mirrors the postgres-e2e style):
  1. Boot **node A** (`--fleet --advertise-url http://127.0.0.1:<portA> --database-url <pg>`) and wait for its ready line; boot **node B** the same way on portB. Read `fleet_lease` via a direct `pg` client: `epoch = 1`, `writer_url` = A.
  2. Open a client subscription against **B** (reuse the exact subscribe mechanics from `postgres-e2e.test.ts`); run a mutation **via B** (`POST http://B/api/run`) → expect 200 with the committed value (proves forwarding), and the subscription on B receives the reactive update (proves NOTIFY/poll + derived invalidation).
  3. `SIGKILL` node A. Poll `fleet_lease` until `epoch = 2` and `writer_url` = B (≤ ~10s budget). Run another mutation via B → 200; subscription updates again (B now writer, local commit + local fanout).
  4. Boot **node C** → joins as sync (lease epoch unchanged); `POST http://C/api/run` mutation → 200 (forwarded to B); read the row back via a query on C → present.
- [ ] **Step 3:** `bun run build`, then `cd ee/packages/fleet && ../../../node_modules/.bin/vitest run test/fleet-e2e.test.ts` — iterate until green. This is the slice's ship gate; expect real debugging here (promotion order, oracle reseed, forward retry timing).
- [ ] **Step 4:** Full gate: `bun run build && bun run typecheck && bun run test`. Commit: `test(fleet): E2E ship gate — 2-node forward+push, live failover, node join`

---

### Task 8: End-user docs + finish

**Files:**
- Create: `docs/enduser/deploy/fleet.md`
- Modify: `docs/enduser/self-hosting.md` (short "Scaling out (fleet)" section linking to it), `docs/dev/architecture/tier2-topology-research.md` (status line: slice 1 SHIPPED)

- [ ] **Step 1:** Write `fleet.md`: what it is (N identical nodes + one Postgres), requirements (`--fleet`, `--advertise-url`, shared `STACKBASE_ADMIN_KEY`, Postgres `--database-url`, `@stackbase/fleet` installed), a 2-node `docker-compose` style example, behavior (connect to any node; writes forwarded; failover ≤ ~2s; in-flight mutations during failover fail and should be retried by the app), current limits (single writer; embedded-replica read scaling is the next slice; no autoscaler). Canonical imports/branding `@stackbase/*` per the product-identity decision; commercial-license note for `ee/` per business doc.
- [ ] **Step 2:** Full gate one more time; commit: `docs(fleet): fleet deployment guide + slice-1 status`

## Execution notes

- Tasks 2 and 3 are independent after Task 1; run sequentially anyway (subagent-dev is serial).
- Task 6 is the integration heart — give it the most capable implementer model; Task 7 is where the design meets reality (budget review time for it).
- Every task ends with the monorepo gate green; the no-`--fleet` path must never change behavior (Global Constraints).
