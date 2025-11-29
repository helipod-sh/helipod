# Subscription Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconnect with N live subscriptions costs N tiny fingerprint-compare frames instead of N full result payloads when nothing changed — with byte-compatible full-send degradation in every other case.

**Architecture:** The server hashes its own serialized query result and attaches it to every `QueryUpdated` (`hash`); the client stores it opaquely per subscription (`lastHash`) and echoes it per-query on resubscribe (`resultHash` on the `ModifyQuerySet` add entry); the server re-runs the query as today, re-hashes, and sends a new `QueryUnchanged` modification on match. Stateless — nothing retained across disconnects, fleet-trivial, no timestamps involved.

**Tech Stack:** TypeScript; `node:crypto` `createHash` (server-side only); vitest under Node.

**Spec:** `docs/superpowers/specs/2025-11-28-subscription-resume-design.md` (approved). Spec governs on conflict.

## Global Constraints

- All wire changes ADDITIVE: `QueryRequest.resultHash?: string`, `QueryUpdated.hash?: string`, new `{type:"QueryUnchanged"; queryId: number}`. Old client ↔ new server and new client ↔ old server are byte-compatible full-send paths; a client with nothing to echo produces today's frames byte-identically.
- Hash format: `"sha256:" + hex` over the server's own serialization of the value. The compare side and the attach side MUST use the same helper — consistency within the server is the whole contract. The client NEVER hashes anything.
- `QueryUnchanged` counts as a full delivery in EVERY client gate: `answered`, `serverValue` retained, baseline adoption, `hasUndeliveredSubscription()` (the outbox drain gate). It must not introduce any new observable listener behavior vs today's value-equal `QueryUpdated` — the T2 implementer VERIFIES today's semantics first, then matches them.
- No error path: mismatch/missing/old-peer/identity-change all degrade to full `QueryUpdated`. `QueryFailed` is never hashed and never "unchanged".
- On an Unchanged resume the server STILL registers the subscription with fresh `tables`/`readRanges` — later invalidation must work (tested).
- The client `Subscription` already has a field named `hash` (query identity) — the new field is `lastHash`. Do not collide.
- No server-side retention: `disconnect()` still deletes everything.
- Tests run under Node (vitest); cross-package via built dist (`bun run build` first). Full gate = `bun run build && bun run typecheck && bun run test`. E2E/bench files end in `-e2e.test.ts` / follow the bench env-gate convention.
- Branch: `git checkout -b resume-token main` before Task 1.
- Every commit ends with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_015RKShEWjRcmbQVJ8ooUPP6`

## File Map

| File | Role |
|---|---|
| `packages/sync/src/protocol.ts` | 3 additive wire changes |
| `packages/sync/src/handler.ts` | `hashValue` helper; compare in `doModifyQuerySet` (:304-327); attach in the re-run push (~:543) |
| `packages/sync/test/resume-fingerprint.test.ts` | NEW — Testing §1 |
| `packages/client/src/layered-store.ts` | `Subscription.lastHash?: string` + store/clear on ingest |
| `packages/client/src/reconcile.ts` | `QueryUnchanged` ingest (answered + today's-semantics notify) |
| `packages/client/src/client.ts` | `resync()` echoes `resultHash` |
| `packages/client/test/resume-client.test.ts` | NEW — Testing §2 incl. the red-first drain-gate composition |
| `packages/cli/test/resume-e2e.test.ts` | NEW — Testing §3 |
| `packages/cli/test/bench-resume-ws.test.ts` + `docs/dev/research/reconnect-resume-benchmark.md` | Testing §4 |
| `docs/enduser/offline.md`, `CLAUDE.md` | docs |

Serial order T1→T5 (client consumes sync's dist; protocol types land first).

---

### Task 1: Protocol + server — mint, compare, `QueryUnchanged`

**Files:**
- Modify: `packages/sync/src/protocol.ts` (QueryRequest, StateModification)
- Modify: `packages/sync/src/handler.ts` (:304-327 `doModifyQuerySet`; the re-run push region ~:543)
- Create: `packages/sync/test/resume-fingerprint.test.ts`

**Interfaces:**
- Produces (T2/T3 depend on these exact shapes): `QueryRequest.resultHash?: string`; `{ type: "QueryUpdated"; queryId: number; value: JSONValue; hash?: string }`; `{ type: "QueryUnchanged"; queryId: number }`; server helper `hashValue(value: JSONValue): string` returning `"sha256:"+hex(SHA-256(JSON.stringify(value)))`.

- [ ] **Step 1: Read the anchors** — `packages/sync/src/protocol.ts` (full — the exact `StateModification`/`QueryRequest` definitions), `packages/sync/src/handler.ts:295-330` (`handleModifyQuerySet`/`doModifyQuerySet`) and the reactive re-run push (search `QueryUpdated` in handler.ts — every construction site must be found; the spec requires `hash` on ALL of them), plus one existing test in `packages/sync/test/` for the session/socket mock pattern.

- [ ] **Step 2: Write the failing tests** — `packages/sync/test/resume-fingerprint.test.ts`, using the file's harness conventions (the assertions are the contract):

```ts
// 1. every QueryUpdated (subscribe answer AND reactive push) carries hash: /^sha256:[0-9a-f]{64}$/
// 2. resubscribe echoing the CURRENT hash -> the Transition contains {type:"QueryUnchanged", queryId}
//    and NOT a QueryUpdated for that queryId
// 3. after an Unchanged resume, a write intersecting the query's read set STILL pushes a full
//    QueryUpdated (fresh readRanges were registered) — the invalidation-after-resume proof
// 4. echoing a WRONG hash -> full QueryUpdated (with the current hash)
// 5. no resultHash on the add entry -> full QueryUpdated, and no QueryUnchanged anywhere (old-client path)
// 6. a failing query -> QueryFailed with NO hash field, and echoing any hash never converts a
//    failure into Unchanged
```

- [ ] **Step 3: Run to verify failure** — `cd packages/sync && bunx vitest run test/resume-fingerprint.test.ts` → FAIL (no `hash` on frames).

- [ ] **Step 4: Implement.** `protocol.ts`:

```ts
export interface QueryRequest { queryId: number; udfPath: string; args: JSONValue; resultHash?: string; }

export type StateModification =
  | { type: "QueryUpdated"; queryId: number; value: JSONValue; hash?: string }
  | { type: "QueryFailed"; queryId: number; error: string }
  | { type: "QueryRemoved"; queryId: number }
  | { type: "QueryUnchanged"; queryId: number };
```

`handler.ts` — the helper (module scope):

```ts
import { createHash } from "node:crypto";

/** Server-minted result fingerprint (subscription resume). Hashes THIS server's own
 *  serialization of the value — the client echoes it opaquely, so attach-site and compare-site
 *  consistency is the entire contract; cross-version servers simply mismatch (full send). */
function hashValue(value: JSONValue): string {
  return "sha256:" + createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
```

In `doModifyQuerySet`, where the fresh run's `QueryUpdated` is built today: compute `const h = hashValue(value)`; if `entry.resultHash !== undefined && entry.resultHash === h` push `{type: "QueryUnchanged", queryId: entry.queryId}`, else push `{type: "QueryUpdated", queryId, value, hash: h}`. Subscription registration (`subscriptions.add`) is UNCONDITIONAL and unchanged. In the reactive re-run push site(s), attach `hash: hashValue(value)` to the constructed `QueryUpdated`. `QueryFailed` construction untouched.

- [ ] **Step 5: Run + full sync suite + typecheck** — `bunx vitest run` in packages/sync (all green; existing frame-shape tests may need the additive field acknowledged — update honestly, never weaken) and `bun run typecheck`.

- [ ] **Step 6: Commit** — `feat(sync): server-minted result fingerprints — QueryUnchanged on hash match`

---

### Task 2: Client — store, echo, ingest

**Files:**
- Modify: `packages/client/src/layered-store.ts` (Subscription interface ~:51-68 + the server-value ingest site)
- Modify: `packages/client/src/reconcile.ts` (`ingestTransition` — the modification switch)
- Modify: `packages/client/src/client.ts` (`resync()` :768-781)
- Create: `packages/client/test/resume-client.test.ts`

**Interfaces:**
- Consumes: T1's wire shapes (via `@stackbase/sync` dist — `bun run build` first).
- Produces: `Subscription.lastHash?: string`; `QueryUnchanged` ingest behavior T3 relies on.

- [ ] **Step 1 (MUST DO FIRST): verify today's identical-value semantics.** Read `layered-store.ts`'s `setServerValue` and the listener-notification path for a `QueryUpdated` whose value equals the current `serverValue` (does it notify listeners? recompute composed?). Write the answer as a comment in the new test file — `QueryUnchanged` must match it exactly (spec: no new observable difference).

- [ ] **Step 2: Write the failing tests** — `packages/client/test/resume-client.test.ts` (MockTransport pattern from `outbox-handshake.test.ts`/`reconnect.test.ts`):

```ts
// 1. QueryUpdated with hash -> sub.lastHash stored verbatim; without hash -> lastHash cleared
// 2. resync()'s ModifyQuerySet add entries carry resultHash ONLY for answered subs with defined
//    serverValue and a stored lastHash (a failed sub and a never-answered sub echo nothing)
// 3. QueryUnchanged ingest: answered=true, serverValue reference retained, lastHash retained,
//    listener behavior === the Step-1-verified identical-value semantics
// 4. optimistic layers over an unchanged base still compose (an inflight mutation's layer visible
//    before AND after the QueryUnchanged resume)
// 5. RED-FIRST drain-gate composition: seeded outbox backlog (memoryOutbox, delayed-loadAll
//    wrapper — the outbox-handshake.test.ts pattern) + subscribe-on-mount + reconnect where the
//    resubscribe answer is QueryUnchanged for every sub -> hasUndeliveredSubscription sees them
//    answered -> the drain proceeds (bounded waitFor on the flush). Run this one against the
//    pre-T2 client to confirm it FAILS (QueryUnchanged unhandled -> never answered -> the exact
//    starvation shape the client-ids slice fixed for QueryFailed), then green post-implementation.
```

- [ ] **Step 3: Run to verify failure** — test 5 red (and 1-4 red on missing `lastHash`).

- [ ] **Step 4: Implement.** `layered-store.ts`: add `lastHash?: string` to `Subscription` (doc comment: "server-minted result fingerprint — echoed on resubscribe; NOT the query-identity `hash`"); in the `QueryUpdated` ingest path set `sub.lastHash = msg.hash` (undefined clears). Add a `markUnchanged(queryId)`-style method (or extend the reconciler) implementing the Step-1-verified semantics + `answered = true`. `reconcile.ts`: `case "QueryUnchanged":` route to it (mirror where `QueryFailed`'s `markAnswered` lives). `client.ts` `resync()`: the add entries gain `...(s.answered && s.serverValue !== undefined && s.lastHash !== undefined ? { resultHash: s.lastHash } : {})`.

- [ ] **Step 5: Run + full client suite + typecheck** — `bun run build` at root first (client resolves sync via dist), then the full packages/client suite (218 + new must be green) and `bun run typecheck`.

- [ ] **Step 6: Commit** — `feat(client): echo result fingerprints on resync; QueryUnchanged counts as delivered everywhere`

---

### Task 3: E2E through the real server

**Files:**
- Create: `packages/cli/test/resume-e2e.test.ts`

- [ ] **Step 1: Read the harness precedents** — `packages/cli/test/outbox-fs-e2e.test.ts` (server boot + client construction) and how `optimistic-e2e.test.ts`/`outbox-e2e.test.ts` observe wire frames (transport wrap or raw `ws`) — the Unchanged assertions need frame-level visibility; a `nodeWsTransport` wrapper that records every parsed `ServerMessage` is the expected shape.

- [ ] **Step 2: Write the E2E** (60s timeouts; fixture: two tables, five queries):
1. **All-unchanged resume:** one client, 5 subscriptions answered; force a transport drop (close the socket underneath; reconnect enabled); on reconnect assert the resume Transition contains 5 `QueryUnchanged` and 0 `QueryUpdated`, all subs `answered`, `serverValue`s intact.
2. **One changed:** same setup; while the socket is down, a SECOND client commits a write touching query 3's table; reconnect → exactly one full `QueryUpdated` (for query 3, with a fresh `hash`), four `QueryUnchanged`; the updated value is correct.
3. **Outbox composition:** an fsOutbox client with a 2-mutation backlog and 3 subscriptions; reconnect → untouched queries resume Unchanged, the drain commits the backlog, and the backlog's own write then arrives as a full reactive `QueryUpdated`; `pendingMutations()` empties.
4. **Old-client compat:** a raw-frame `ws` client sends `ModifyQuerySet` WITHOUT `resultHash` after receiving hashed results → the reply contains full `QueryUpdated`s and never `QueryUnchanged`.

- [ ] **Step 3: Build + run + commit** — `bun run build`, `cd packages/cli && bunx vitest run test/resume-e2e.test.ts` → PASS; typecheck; commit `test(cli): subscription-resume E2E — unchanged fingerprint resume through the real server`.

---

### Task 4: Benchmark + record

**Files:**
- Create: `packages/cli/test/bench-resume-ws.test.ts` (env gate `STACKBASE_BENCH_RESUME=1`, following `bench-fanout-ws.test.ts`'s gating/percentile conventions)
- Create: `docs/dev/research/reconnect-resume-benchmark.md`

- [ ] **Step 1:** Harness: real dev server; seed 50 queries whose results are ~2–10KB each (e.g. a table of padded rows, 50 range queries); one client subscribes to all 50; measure on a forced reconnect: (a) total `ServerMessage` bytes until all 50 answered (count at the frame-capture wrapper), (b) wall time to all-answered. Two matrix cells: fingerprints ON (normal client) vs OFF (the same client with echo suppressed — a test-only flag or a fork of the transport that strips `resultHash` from outgoing `ModifyQuerySet`; the strip-transport needs no client API change — prefer it).
- [ ] **Step 2:** Run the matrix once (`STACKBASE_BENCH_RESUME=1 bunx vitest run test/bench-resume-ws.test.ts`), record the table + methodology + the honest "compute unchanged — bandwidth-only win; retained read-sets are the v2 compute seam" note in `docs/dev/research/reconnect-resume-benchmark.md`. Without the env the file must skip cleanly (assert once in the task run).
- [ ] **Step 3:** Commit — `bench(cli): reconnect resume — bytes and time-to-answered, fingerprints on/off`.

---

### Task 5: Docs + full gate

**Files:**
- Modify: `docs/enduser/offline.md`, `CLAUDE.md`

- [ ] **Step 1:** `offline.md`: a short "What a reconnect costs" paragraph in the reconnect section (unchanged results resume as fingerprint matches — tiny frames; changed ones arrive in full; automatic when both peers are current, no configuration; old peers transparently fall back to full sends). Graduate the deferred-table "Subscription resume token" row.
- [ ] **Step 2:** `CLAUDE.md`: update the deferred-seam line — reconnect fast-resume shipped in its bandwidth sense (server-minted fingerprints, `QueryUnchanged`); compute-saving resume (retained read-sets) remains the deferred v2 seam.
- [ ] **Step 3:** Full gate `bun run build && bun run typecheck && bun run test` → 64/64.
- [ ] **Step 4:** Commit — `docs: subscription resume — reconnect cost note; deferred rows graduated`.

---

## Self-review notes (spec coverage)

Wire/additive/compat → T1 (+T3 scenario 4). Server behavior incl. fresh-read-set registration → T1 (test 3). Client behavior incl. the four gates and identical-value semantics → T2 (Step 1 verify-first; test 5 is the drain-gate red-first). Security/failure-honesty → structural (no error path exists; T1 tests 4-6 cover degradation). Testing §1-4 → T1/T2/T3/T4. Docs → T5. Non-goals: no retention added anywhere; no diff protocol; the reactive-push identical-value suppression explicitly NOT implemented (T1 keeps push-always).
