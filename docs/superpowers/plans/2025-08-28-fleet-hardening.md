# Fleet Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the shipped fleet production-grade: bounded slow-client handling, RYOW for actions, real writer self-exit, promotion error policy, replica identity safety, and the accumulated small leak fixes — every degradation visible and bounded.

**Architecture:** Spec = `docs/superpowers/specs/2025-08-28-fleet-hardening-design.md` (post-review, 33bfaf6). Two zones: FSL core (`packages/sync` controllers — a Foundation obligation; `packages/executor` action commitTs; `packages/cli` proxy headers + `/_fleet/run` fallback) and ee/fleet (self-exit, promotion policy, tailer race, deployment-id stamp, small guards). No wire-protocol change: backpressure drops rely on the existing client version-gap resync.

**Tech Stack:** TypeScript; vitest under Node (fake timers for controllers); `ws` + `Bun.serve` ping/pong at the transport adapters; PGlite for unit-level PG; Docker-gated E2E with `pg_terminate_backend`.

## Global Constraints

- Non-fleet behavior unchanged EXCEPT C1's controllers, which must be **true no-ops on loopback** (no `ping` capability → exempt from reaping; `bufferedAmount` 0 → never queues/drops). The unchanged existing suite passing is that proof — do not modify existing tests to make this true.
- Exact defaults (spec): backpressure high-water **1 MiB**, bounded queue **200 frames**, slow-client timeout **30s**; heartbeat ping every **30s**, reap after **2 missed pongs**; C4 probe every **5s**, tolerate **3** consecutive misses (4th, or any connection-lost event → exit), `SELECT 1` (NEVER `pg_try_advisory_lock` — re-entrant, leaks a lock count).
- Exit policy (C4/C5): log then `process.exit(1)`. Extract decisions into testable functions with injected exit — never call `process.exit` untestably inline.
- FSL core changes (sync/executor/cli) are held to core standards: tests live in the owning package; ee files carry the enterprise header.
- Node/vitest, no Bun APIs in tests; `bun run build` before cross-package tests; typecheck after tests; full gate = `bun run build && bun run typecheck && bun run test`.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

**Verified ground truth (do not re-derive):** handler send chokepoint `packages/sync/src/handler.ts:93` (all frames incl. broadcasts); `SyncWebSocket {send, bufferedAmount, close}` `handler.ts:23-27`; loopback `bufferedAmount = 0` (`packages/runtime-embedded/src/loopback.ts:24`); node-ws adapter builds the socket object inline at `packages/cli/src/server.ts:281-287` (has `ws.ping()` + per-socket `ws.on("pong")`), Bun adapter at `server.ts:402-410` (Bun `ServerWebSocket.ping()` exists; the `pong` handler is CONFIG-LEVEL — `websocket: { pong(ws, data) }` — so the Bun adapter needs a per-session pong-callback map keyed by `ws.data.sessionId`); `protocol.ts:65` has an unused protocol-level `Ping` — do NOT use it, heartbeat is transport-level; `runActionFn` `packages/executor/src/executor.ts:273-312` returns `commitTs: 0n` at :307; inner mutation commitTs available at `executor.ts:256` (`res.commitTs` on invoke results); `/_fleet/run` response `packages/cli/src/http-handler.ts:108` (`String(result.oplog?.commitTs ?? 0n)`); proxy header copy `http-handler.ts:172-174`; `NodePgClient` single shared pinned connection, no reconnect (`packages/docstore-postgres/src/node-pg-client.ts:74-107`), `listen` leak `:115-128`; forwarder warn guards `ee/packages/fleet/src/forwarder.ts:139,151`; tailer re-arm `ee/packages/fleet/src/replica-tailer.ts:129-146`; promotion IIFE `ee/packages/fleet/src/node.ts:317-326`; lease held on the pinned connection (`lease.ts:55`); `getGlobal`/`writeGlobalIfAbsent` on the DocStore interface (`packages/docstore/src/types.ts:129,131`), both stores implement.

**DAG:** {T1 ∥ T2} → {T3 ∥ T4} → T5 → T6. (T1=sync, T2=executor+cli+docs-RYOW — disjoint. T3 touches http-handler (after T2) + tailer + pg-client listen + forwarder guards; T4 touches pg-client (onConnectionLost) + node.ts — T3/T4 both touch node-pg-client.ts: T3 edits `listen()` only, T4 adds `onConnectionLost` only — parallelizable in worktrees with those exact boundaries, merge-conflict-free if neither reformats.)

---

### Task 1: C1 — SessionBackpressureController + SessionHeartbeatController (packages/sync + transport adapters)

**Files:**
- Create: `packages/sync/src/session-controllers.ts`
- Modify: `packages/sync/src/handler.ts` (send path :93, session struct, connect/disconnect lifecycle, handler options), `packages/sync/src/index.ts` (exports), `packages/cli/src/server.ts` (both adapters gain `ping`)
- Test: `packages/sync/test/session-controllers.test.ts`

**Interfaces:**
- `SyncWebSocket` gains OPTIONAL `ping?(onPong: () => void): void` — send a transport-level ping; invoke `onPong` when the pong arrives. Loopback does NOT implement it.
- Produces (wired inside handler; nothing external consumes directly):

```ts
export interface BackpressureOptions { highWaterBytes?: number /*1MiB*/; maxQueuedFrames?: number /*200*/; slowClientTimeoutMs?: number /*30_000*/ }
export class SessionBackpressureController {
  constructor(socket: SyncWebSocket, opts?: BackpressureOptions, now?: () => number)
  /** The ONLY way frames leave a session now. Sends immediately when bufferedAmount < highWater; else queues; drops (counted) past maxQueuedFrames or after slowClientTimeoutMs of sustained backpressure. */
  send(data: string): void
  /** Called on any socket-drain opportunity (handler calls it before each send and on a 1s sweep). */
  flush(): void
  readonly droppedFrames: number
  /** true once anything was dropped since the last fully-drained state (episode flag → one warn per episode). */
}
export interface HeartbeatOptions { pingIntervalMs?: number /*30_000*/; missedPongLimit?: number /*2*/ }
export class SessionHeartbeatController {
  constructor(socket: SyncWebSocket, onDead: () => void, opts?: HeartbeatOptions)
  start(): void  // no-op if socket.ping is undefined (loopback exemption)
  stop(): void
  noteActivity(): void  // any inbound message resets the missed counter (cheap liveness credit)
}
```

- Handler wiring: session record gains `bp: SessionBackpressureController` and `hb: SessionHeartbeatController`; ALL `socket.send` call sites route through `bp.send` (verify :93 is the single chokepoint — if any other direct `socket.send` exists in handler.ts, route it too); `connect()` starts hb with `onDead = () => this.disconnect(sessionId)` + close; `disconnect()` stops both; `handleMessage` calls `hb.noteActivity()`. Handler constructor options gain `backpressure?`/`heartbeat?` passthroughs.
- `server.ts` adapters: node-ws — `ping: (onPong) => { ws.once("pong", onPong); ws.ping(); }`. Bun — add a module-level `pongCallbacks = new Map<string, () => void>()`; adapter `ping: (onPong) => { pongCallbacks.set(sessionId, onPong); ws.ping(); }`; add `pong(ws) { pongCallbacks.get(ws.data.sessionId)?.(); pongCallbacks.delete(ws.data.sessionId); }` to the `websocket` config; clean the map entry in `close()`.

- [ ] **Step 1 (failing tests):** `session-controllers.test.ts` with a fake socket `{sent: string[], bufferedAmount (settable), send(d){this.sent.push(d)}, close: vi.fn(), ping? }` and `vi.useFakeTimers()`:
  - backpressure: bufferedAmount 0 → send passes through; bufferedAmount 2MiB → frames queue; 201st queued frame drops oldest-first or rejects-newest (pick DROP-NEWEST and assert it — the client resyncs anyway, simpler reasoning); sustained backpressure past 30s → queue flushed to drops; drop counter accurate; exactly ONE warn per episode (spy console.warn; drain then re-enter backpressure → second warn allowed); bufferedAmount back to 0 + flush() → queued frames deliver in order.
  - heartbeat: socket WITH ping → pong within interval keeps session alive; 2 consecutive missed pongs → `onDead` fired exactly once; `noteActivity()` between pings resets the miss counter; socket WITHOUT ping → timers never armed, `onDead` never fires; `stop()` clears timers.
- [ ] **Step 2:** Run `cd packages/sync && ../../node_modules/.bin/vitest run test/session-controllers.test.ts` — FAIL (module missing).
- [ ] **Step 3:** Implement `session-controllers.ts` + wire into `handler.ts` + adapter `ping` in `server.ts` per the interface block.
- [ ] **Step 4:** Controllers test green; `bun run --filter @stackbase/sync test` (existing handler tests unchanged and green = loopback no-op proof), `bun run --filter @stackbase/cli test`, typecheck.
- [ ] **Step 5:** Commit: `feat(sync): session backpressure + heartbeat controllers — seam 6 server half`

---

### Task 2: C2 — RYOW for actions (executor commitTs + /_fleet/run fallback + docs)

**Files:**
- Modify: `packages/executor/src/executor.ts` (runActionFn :273-312), `packages/cli/src/http-handler.ts:108`, `docs/enduser/deploy/fleet.md` (RYOW section)
- Test: `packages/executor/test/action-commit-ts.test.ts` (or extend the existing action executor test file — check `packages/executor/test/` first), plus one case in `packages/cli/test/fleet-run-route.test.ts`

**Interfaces:**
- Action `UdfResult.commitTs` = **max** commitTs observed across the action's inner `ctx.runMutation`/`ctx.runAction` invokes (recurse: an inner action's own commitTs propagates), `0n` when nothing committed. `oplog` stays `null` for actions. Mutations untouched.
- `/_fleet/run` response: `commitTs: String(result.oplog?.commitTs ?? result.commitTs ?? 0n)` — the forwarder already waits on non-zero (no forwarder change).

- [ ] **Step 1 (failing test):** executor-level — an action whose handler runs 0 / 1 / 3 inner mutations (inline fixture modules, follow the existing action test fixture pattern in packages/executor/test): assert result.commitTs is 0n / that mutation's ts / the max of the three; nested case: action → inner action → mutation propagates. cli-level — extend fleet-run-route.test.ts: kind=action whose handler commits via runMutation → response commitTs is a non-"0" stringified bigint.
- [ ] **Step 2:** FAIL. **Step 3:** implement — in `runActionFn`, track `let maxCommitTs = 0n`, updating from each inner invoke's result (the invoke path returns commitTs at executor.ts:256; thread it through the action ctx's runMutation/runAction wrappers), return it on the action result. Edit http-handler.ts:108 per the interface block. Audit + note in the report: handler.ts runAction (returns .value only), loopback client, scheduler modules — all read `.value`, unaffected.
- [ ] **Step 4:** executor + cli suites + typecheck green.
- [ ] **Step 5:** Rewrite fleet.md's RYOW section: actions now covered (same 5s bound, same node); delete the "does not extend to actions" limitation paragraph.
- [ ] **Step 6:** Commit: `feat(executor,cli): actions surface max inner commitTs — read-your-own-writes for actions`

---

### Task 3: C3+C6+C8 — small-fixes bundle (proxy headers, tailer re-arm, listen leak, warn guards)

**Files:**
- Modify: `packages/cli/src/http-handler.ts:172-174`, `ee/packages/fleet/src/replica-tailer.ts:129-146` (re-arm guard ONLY), `packages/docstore-postgres/src/node-pg-client.ts:115-128` (`listen()` ONLY — Task 4 owns other pg-client edits), `ee/packages/fleet/src/forwarder.ts:139,151`
- Test: extend `packages/cli/test/` (proxy headers — find the existing httpAction-proxy test or add a focused unit), `ee/packages/fleet/test/replica-tailer.test.ts` (stop-mid-bootstrap), `ee/packages/fleet/test/forwarder-ryow.test.ts` (guard split)

- [ ] **Step 1 (failing tests):**
  - proxy: stub writer response with headers `{content-encoding: gzip, content-length: "999", transfer-encoding: chunked, connection: keep-alive, x-custom: keep}` → relayed response has NONE of the four, keeps `x-custom`.
  - tailer: `start()` against a primary needing ≥2 bootstrap batches; call `stop()` after the first `onInvalidation`; assert after start() settles: no poll timer armed, no LISTEN opened (expose via the existing stopped/handles state or spy on client.listen), and a subsequent primary write never fires onInvalidation.
  - forwarder: absent-commitTs response then unparseable-commitTs response → TWO distinct warns (one each), each once.
  - listen leak: mock a client whose `query("LISTEN …")` rejects post-connect → the dedicated connection's `end()` was called and the rejection propagates.
- [ ] **Step 2:** FAIL. **Step 3:** implement all four (each is ≤10 lines). **Step 4:** fleet + cli + docstore-postgres suites + typecheck. **Step 5:** Commit: `fix(fleet,cli,docstore-postgres): proxy hop-by-hop headers, tailer re-arm race, listen leak, warn-guard split`

---

### Task 4: C4+C5 — writer self-exit on lease loss + promotion error policy

**Files:**
- Modify: `packages/docstore-postgres/src/node-pg-client.ts` (add `onConnectionLost(cb: () => void): void` — wire the pinned connection's `error`/`end` events; VERIFY where the pinned `pg.Client` is created (:74-107 `ensure()`) and attach there; multiple cbs allowed or single — single is fine, document), `packages/docstore-postgres/src/pg-client.ts` (interface: optional member), `ee/packages/fleet/src/node.ts` (lease monitor + promotion wrap :317-326), `ee/packages/fleet/src/index.ts` if new exports
- Test: `ee/packages/fleet/test/lease-monitor.test.ts`

**Interfaces:**
- New fleet module-level function (in node.ts or a new `lease-monitor.ts` if node.ts is crowded — prefer the new file):

```ts
/* enterprise header */
export interface LeaseMonitorDeps { probe: () => Promise<void>; onExit: (reason: string) => void; probeMs?: number /*5000*/; maxMisses?: number /*3*/ }
export class LeaseMonitor {
  constructor(deps: LeaseMonitorDeps)
  start(): void
  stop(): void
  connectionLost(): void   // definitive → onExit immediately
  // internal: probe every probeMs; consecutive failures > maxMisses → onExit; any success resets
}
```

- Wiring: started ONLY on the writer (at writer boot and at promotion); `probe = () => client.query("SELECT 1")`-shaped (through the structural client); `client.onConnectionLost(() => monitor.connectionLost())`; production `onExit = (reason) => { console.error(...); process.exit(1); }`.
- Promotion wrap (C5): the IIFE at node.ts:317-326 becomes a caught sequence — on ANY promotion-step failure: `console.error` + `process.exit(1)` via the same injected-exit indirection (production default = real exit; tests inject).

- [ ] **Step 1 (failing tests, fake timers):** connectionLost() → onExit exactly once, immediately; 3 consecutive probe rejections → NO exit; 4th → exit with reason containing "lease"; probe success after 2 misses resets the counter; stop() halts probing (no exit after); a sync-role prepare never constructs/starts the monitor (assert via node.ts wiring test or the lifecycle spy pattern from node-lifecycle.test.ts); promotion-failure: instrument the promotion sequence with a step that throws → injected exit called once, `promoting` never left sticky-true without exit.
- [ ] **Step 2:** FAIL. **Step 3:** implement (LeaseMonitor + onConnectionLost seam + writer/promotion wiring). **Step 4:** fleet + docstore-postgres suites + typecheck; full monorepo gate (cli untouched but neighbors moved). **Step 5:** Commit: `feat(fleet,docstore-postgres): writer self-exit on lease loss + promotion error policy (exit-and-rejoin)`

---

### Task 5: E2E extension — RYOW-for-actions + writer self-exit through real processes

**Files:**
- Modify: `ee/packages/fleet/test/fleet-e2e.test.ts` (+ the fixture app's convex/ dir inside the test harness gains an action that writes via ctx.runMutation — follow how the harness provisions its fixture)
- Possibly modify: `packages/docstore-postgres/src/node-pg-client.ts` or the fleet prep — set `application_name` on the pg connection config (e.g. `stackbase-<advertiseUrl-port>`) as the discriminator for pg_stat_activity (VERIFY what config NodePgClient passes to pg.Client today; add an optional `applicationName` option threaded from prepareFleetNode's advertise URL — smallest change that makes the writer's backends identifiable).

- [ ] **Step 1:** Add scenarios to the E2E (keep all hygiene: bounded waits, kill array, per-node data dirs, afterAll):
  1. **RYOW-for-actions:** call the writing action via sync node B's `/api/run` (kind action) → immediately query via B → the row is present (no sleep).
  2. **Writer self-exit:** `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = '<writer's app name>'` via a direct pg client → the WRITER process exits within a bounded window (assert exit via the child-process handle, not just lease state) → a surviving sync node acquires the lease (epoch bump, bounded poll) → post-recovery mutation via the survivor commits + pushes to the pre-existing subscription. Do NOT use docker restart (severs all connections; NodePgClient has no reconnect — full-restart recovery is an out-of-scope named follow-up).
- [ ] **Step 2:** `bun run build`, run the fleet E2E to green; fix real product bugs smallest-correct with separate commits if the gate exposes them (that's its job).
- [ ] **Step 3:** Full monorepo gate. Commit: `test(fleet): E2E — action RYOW + writer self-exit via pg_terminate_backend`

---

### Task 6: C7 deployment-id stamp + docs + finish

**Files:**
- Modify: `ee/packages/fleet/src/node.ts` (prepareFleetNode sync branch — stamp check after the replica opens, BEFORE `tailer.start()`), `docs/enduser/deploy/fleet.md` (failover: self-exit now real; slow-clients note: drops degrade to resync, bounded memory; replica section: identity stamp behavior)
- Test: `ee/packages/fleet/test/node-lifecycle.test.ts` (extend)

**Interfaces:** primary mints `fleet:deploymentId` once via `writeGlobalIfAbsent` (crypto.randomUUID; the WRITER boot path mints it; sync nodes only read). Replica mirrors it locally via its own `writeGlobalIfAbsent`/`getGlobal` (the tailer never replicates persistence_globals). Sync-boot check: fresh replica (no data, no stamp) → adopt primary's id; stamps match → proceed; mismatch OR data-without-stamp → warn + delete replica file (+ -wal/-shm) + reopen + re-bootstrap + adopt.

- [ ] **Step 1 (failing tests):** with PGlite primary A (stamped id-A) and a replica file previously stamped id-B (construct by stamping directly) → prepare → warn + file recreated + stamp now id-A + old rows gone; matching stamp → no rebuild (file mtime/rowcount preserved); fresh file → adopted, no warn; data-but-no-stamp (simulate pre-C7 replica) → rebuild.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** fleet suite + typecheck. **Step 5:** docs edits. **Step 6:** FULL gate. Commit: `feat(fleet): foreign-replica deployment-id stamp + hardening docs`

## Execution notes

- Waves: **{T1 ∥ T2}** (worktrees — disjoint packages) → **{T3 ∥ T4}** (worktrees OK with the stated node-pg-client boundary: T3 = listen() only, T4 = onConnectionLost only; if nervous, run serially T4→T3) → T5 → T6.
- T5 needs Docker; give it and T4 capable models (self-exit semantics + E2E debugging). T1 is the largest single task — capable model there too.
- Watch the parallel-merge package.json/duplicate-key gotcha from slice 2 if any task adds deps (none should).
