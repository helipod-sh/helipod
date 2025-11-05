# Receipted Outbox — Plan A, Task 1 SPIKE: classification + guard-chain signatures

**Status:** spike output (documentation only — no product code). Fixes the exact signatures the
later Plan A tasks implement. Scope = design decisions 1–4 (`docs/superpowers/specs/2025-11-04-
receipted-outbox-design.md`): the `MutationBatch`/`MutationResponse` shape, the guard chain +
`CommitGuardRejection`, floor-over-gaps store reads, and the classification plumbing.

**Traced against the tree (branch `outbox-server`, 2025-11-04):**
`packages/sync/src/handler.ts:44-58,269-301` · `packages/docstore/src/types.ts:79-96,119-218` ·
`packages/docstore-postgres/src/postgres-docstore.ts:66-97,272-315` ·
`packages/docstore-sqlite/src/sqlite-docstore.ts:155-191` ·
`packages/transactor/src/shard-writer.ts:317-323,436-472,588-624` ·
`packages/executor/src/executor.ts:175-217,415` ·
`packages/runtime-embedded/src/runtime.ts:409-438,789-895` ·
`packages/cli/src/http-handler.ts:83-105,162-278` ·
`ee/packages/fleet/src/node.ts:911-973,1424-1457,1466-1651` ·
`ee/packages/fleet/src/forwarder.ts:130-173` · `packages/errors/src/index.ts:108-133`.

The three load-bearing facts that shape every signature below:

1. **The classification read must NOT run in the sync handler.** `handler.ts` runs on ANY node
   (incl. a fleet follower reading a lagging embedded replica). The verdict's placement rule
   (§(c) repair 3) requires the dedup read to run *where the commit runs* — locally on single-node,
   at the owning writer on fleet. So the handler only *threads* `{clientId, seq}` down and
   *interprets* a replay-shaped return; the `getClientVerdict`/`getClientFloor` reads live at the
   owner-local runtime entrypoint (`runtime-embedded`) and, on the forwarded path, at the owner's
   `/_fleet/run` → `runtime.run`. Single-node and fleet therefore share ONE classification code
   path (inside `run`), never two.
2. **Classification is the fast path; the guard is the enforcement.** The pre-read can race a
   concurrent duplicate (no lock spans read→commit). Correctness rests on the commit guard's PK
   collision on `client_mutations` — the loser aborts and replay-reads the winner's row. Any impl
   that treats the classify-read as authoritative and skips the guard is wrong.
3. **The `applied` receipt rides the mutation's own commit transaction via a commit guard;** the
   `failed` receipt is a standalone `recordClientVerdict` write (no effects to be atomic with).
   Both dedup fields travel in the ALREADY-EXISTING `CommitUnit.meta`/`CommitGuardUnit.meta`
   `Record<string,string>` — so `CommitUnit`/`CommitGuardUnit` need **no structural change** (this
   is the key T2/T4 de-conflict: neither task edits those interfaces).

---

## (a) `SyncUdfExecutor.runMutation` — dedup extension + replay-shaped return

Today (`handler.ts:54`):

```ts
runMutation(
  udfPath: string, args: JSONValue, identity?: string | null, origin?: string,
): Promise<{ value: Value; tables: string[]; writeRanges: readonly SerializedKeyRange[]; commitTs: number; forwarded?: boolean }>;
```

### New signature (additive — a 5th optional param + a discriminated-union return)

```ts
/** The durable client identity for a resend-safe mutation (verdict §(b)). `identity` is already
 *  param #3 of runMutation; the dedup key is `(identity, clientId, seq)`. Absent → today's path. */
export interface DedupKey {
  clientId: string;
  seq: number;            // per-tab monotone counter; JS number (≤2^53), stringified only into meta
}

/** Replay of a prior verdict — NO commit happened on this call (verdict §(c) "Classification"). */
export interface MutationReplay {
  replayed: true;
  verdict: "applied" | "failed" | "stale";
  /** Original commitTs for an `applied`/`failed` record (keeps the client optimistic gate sound,
   *  AC2.1). For `stale` there is no commit — omitted. Always > 0 when present. */
  commitTs?: number;
  /** Present only for `applied` with a recorded return value. */
  value?: Value;
  /** `applied` whose value was never recorded (crash-window) or exceeded the 64KB cap. */
  valueMissing?: true;
  /** Terminal verdict code for `failed` (the recorded error code) or `"STALE_CLIENT"` for `stale`. */
  code?: string;
}

/** Today's fresh-run result, tagged so the handler can discriminate. */
export interface MutationRan {
  replayed?: false;
  value: Value;
  tables: string[];
  writeRanges: readonly SerializedKeyRange[];
  commitTs: number;
  forwarded?: boolean;
}

export type RunMutationResult = MutationRan | MutationReplay;

runMutation(
  udfPath: string,
  args: JSONValue,
  identity?: string | null,
  origin?: string,
  dedup?: DedupKey,           // NEW — absent = bit-for-bit today's unconditional path
): Promise<RunMutationResult>;
```

### Where the classification reads happen in the handler flow

`handleMutation` (`handler.ts:269-301`) changes ONLY at the edges — it does **not** read the store:

```ts
// pseudo, handler.ts
const dedup = (msg.clientId && msg.seq != null) ? { clientId: msg.clientId, seq: msg.seq } : undefined;
const r = await this.executor.runMutation(msg.udfPath, msg.args, session.identity, session.sessionId, dedup);

if (r.replayed) {
  // NO notifyWrites, NO pendingFrontier — nothing was written this call (see Risk R7).
  this.send(session, {
    type: "MutationResponse", requestId: msg.requestId,
    success: r.verdict !== "failed" && r.verdict !== "stale",
    ...(r.verdict === "applied"
        ? { replayed: true, ts: this.mutationResponseTs(r.commitTs!),
            ...(r.valueMissing ? { valueMissing: true } : { value: convexToJson(r.value!) }) }
        : { code: r.code }),                       // failed | stale → terminal
  });
  return;
}
// ...unchanged fresh-run path (success response + G4 frontier + notifyWrites)
```

The actual `getClientVerdict`/`getClientFloor` calls live inside the executor's `runMutation`
impl (`runtime-embedded/src/runtime.ts:409`), which runs at the owner:

```ts
// pseudo, runtime-embedded runMutation, at the OWNER (local single-node, or owner via /_fleet/run)
async runMutation(path, args, identity, origin, dedup) {
  if (dedup) {
    const id = identity ?? "";                                   // anon keys as ("", clientId)
    const floor = await docStore.getClientFloor(id, dedup.clientId);   // number | null
    if (floor !== null && dedup.seq <= floor) {
      const rec = await docStore.getClientVerdict(id, dedup.clientId, dedup.seq);
      if (!rec) return { replayed: true, verdict: "stale", code: "STALE_CLIENT" };  // floor, no record
    }
    const rec = await docStore.getClientVerdict(id, dedup.clientId, dedup.seq);
    if (rec) return replayFromRecord(rec);                       // applied | failed replay
    // miss above floor → run, threading the dedup key into commitMeta for the guard:
  }
  const commitMeta = dedup ? { ...baseMeta, identity: identity ?? "", clientId: dedup.clientId, seq: String(dedup.seq) } : baseMeta;
  const r = await executor.run(fn, ..., { ..., commitMeta });   // guard writes the `applied` receipt in-txn
  // ...map r → MutationRan (today's shape); on terminal handler failure, recordClientVerdict (see e)
}
```

`replayFromRecord` maps a `ClientVerdictRecord` (see (e)) to `MutationReplay`.

---

## (b) Fleet-forward threading — `(identity, clientId, seq)` rides `/_fleet/run`

The classification runs at the OWNER, so the dedup key must survive the forward. Two changes, both
additive, mirroring B3's `idempotencyKey` channel:

**1. `WriteForwarder.forward` body** (`forwarder.ts:130-149`) gains the dedup key. `identity` is
already in the body; add `clientId?`/`seq?`:

```ts
async forward(
  kind: "mutation" | "action", path: string, args: JSONValue, identity: string | null,
  shardId: ShardId = DEFAULT_SHARD,
  dedup?: { clientId: string; seq: number },     // NEW
): Promise<{ value: JSONValue; commitTs?: number; shardId?: string; replay?: MutationReplayWire }> {
  const body = {
    path, args, identity, kind, shardId, forwarded: true,
    idempotencyKey: crypto.randomUUID(),         // fleet's per-hop dedup — UNCHANGED, coexists (Risk R2)
    ...(dedup ? { clientId: dedup.clientId, seq: dedup.seq } : {}),   // client's durable dedup
  };
  // ...post + retry-once unchanged; on a replay body, surface it up so the sync node builds the MutationResponse
}
```

**2. `/_fleet/run` handler** (`http-handler.ts:162-278`). Parse `clientId?`/`seq?`, then thread into
`runtime.run` alongside `commitMeta` — the owner-local `run` does BOTH the classification read and
(via the guard) the receipt write. It does **not** add a second pre-SELECT block; classification
lives inside `run` (fact 1) so single-node and fleet share it. The existing fleet
`idempotencyLookup` pre-SELECT (`http-handler.ts:202-204`) stays exactly as-is — it is a *separate,
composing* mechanism (Risk R2):

```ts
const p = JSON.parse(...) as { /* ...existing... */ clientId?: string; seq?: number };
const dedup = (p.clientId && p.seq != null) ? { clientId: p.clientId, seq: p.seq } : undefined;
// ...existing forwarded/single-hop guard + idempotencyKey pre-SELECT unchanged...
const result = /* action ? ... : isInternalForwardPath ? runSystem(...) : */
  await runtime.run(p.path, p.args ?? {}, { identity, commitMeta, dedup });   // dedup NEW
// result is UdfResult | MutationReplay-shaped; if replay, return a replay body (see below), else today's body.
```

`runtime.run` (`runtime.ts:789`) and `RunOptions` (`executor.ts:175-217`) each gain an optional
`dedup?: DedupKey` threaded to the transactor's classify-then-commit. A `MutationReplay` return
serializes through a body analogous to `idempotencyReplayBody`:

```ts
function clientReplayBody(r: MutationReplay): {
  replayed: true; verdict: "applied" | "failed" | "stale";
  commitTs?: string; value?: JSONValue; valueMissing?: true; code?: string;
} { /* stringify commitTs; carry value|valueMissing|code by verdict */ }
```

**Owner does BOTH:** the classification read (`getClientVerdict`/`getClientFloor`, owner-local
DocStore) AND the guard write (the receipts guard, in the same commit txn) run on the node that owns
the shard — never on a follower's replica.

---

## (c) `CommitGuardRejection {unitIndex, code, detail}`

### Home: `@stackbase/errors` (`packages/errors/src/index.ts`, alongside `ConflictError`)

It is caught by the transactor (`packages/transactor` already imports `OccConflictError` from
errors), thrown by both docstore guards, and `instanceof`-checked in `packages/cli/http-handler.ts`
— `@stackbase/errors` is the one package all three already depend on. `docstore/types.ts` does NOT
need to import it (the guard *impls* do, not the interface).

```ts
/** A commit guard's rejection of ONE unit of a (possibly grouped) commit — carries the offending
 *  unit's index so the group committer can reject only that unit and re-flush the rest (verdict
 *  §(c) repair 2). Distinct from FencedError (a WHOLE-batch epoch abort, never per-unit). */
export const COMMIT_GUARD_REJECTION_CODE = "COMMIT_GUARD_REJECTION";
export class CommitGuardRejection extends ConflictError {
  override readonly code = COMMIT_GUARD_REJECTION_CODE;
  constructor(
    readonly unitIndex: number,     // index into the CommitGuardUnit[] the guard looped
    readonly rejectionCode: string, // "FLEET_IDEMPOTENCY_CONFLICT" | "CLIENT_MUTATION_DUP"
    readonly detail: string,
    options?: StackbaseErrorOptions,
  ) { super(`commit guard rejected unit ${unitIndex}: ${rejectionCode}`, options); }
}
```

Extends `ConflictError` (409, retryable-ish) because a rejection = "this write already landed under
another attempt" — a replay signal, not a 5xx.

### Where the fleet guard throws it (`node.ts:964-971`)

The per-unit idempotency INSERT loop knows its index. Convert the raw `unique_violation` there:

```ts
for (let i = 0; i < units.length; i++) {
  const unit = units[i]!;
  if (unit.meta?.idempotencyKey) {
    try {
      await q.query(`INSERT INTO fleet_idempotency (key, commit_ts) VALUES ($1, $2)`, [unit.meta.idempotencyKey, unit.ts]);
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new CommitGuardRejection(i, "FLEET_IDEMPOTENCY_CONFLICT", `key=${unit.meta.idempotencyKey}`);
      throw e;
    }
  }
}
```

The epoch fence itself (the `shard_leases` UPDATE returning 0 rows, `node.ts:948-951`) stays
`FencedError` — it aborts the whole batch (not a single unit), so it is NOT a `CommitGuardRejection`.

### `http-handler.ts:83-90` migration off raw-23505

`isFleetIdempotencyConflict` (the raw `.code === "23505" && .table === "fleet_idempotency"` sniff)
is **deleted** and replaced by a typed guard on the typed error:

```ts
function isFleetIdempotencyConflict(e: unknown): boolean {
  return e instanceof CommitGuardRejection && e.rejectionCode === "FLEET_IDEMPOTENCY_CONFLICT";
}
```

This survives the fleet hop because the forwarder now relays `errorJson`
(`http-handler.ts:275-276`) — but note: the catch-and-replay at `http-handler.ts:238` is on the
OWNER (local throw, before serialization), so the raw `instanceof` holds there. (Risk R8: the typed
error must round-trip through `toStackbaseError`/`errorJson` rehydration for a SYNC node that also
needs to detect it — verify `CommitGuardRejection` registers in the error rehydration table.)

### Single-commit path mapping

`commitWrite` = a one-unit `commitWriteBatch` that does NOT go through the group committer's
per-unit split — it runs via `shard-writer.ts:323` (`this.commit(...)` → `docStore.commitWrite`), so
a guard throw propagates raw up to the caller. A one-unit rejection = **that mutation's rejection**:
`CommitGuardRejection` propagates → executor → `http-handler`/`handleMutation` catches it and
replay-reads the winner's `client_mutations` row (`getClientVerdict`) → returns a `MutationReplay`,
exactly as B3's loser-reads-winner does today. No group-committer machinery on the single path.

---

## (d) `addCommitGuard(guard): () => void` — the chain on BOTH stores

The single `setCommitGuard` slot becomes an append-only chain returning an unregister handle.
Registration order = invocation order; ANY throw aborts the whole commit txn.

### Postgres (`postgres-docstore.ts:66-97,272-315`)

```ts
export type PgCommitGuard =
  (q: PgQuerier, units: readonly CommitGuardUnit[], shardId: ShardId) => Promise<void>;

// slot → chain
private guards: PgCommitGuard[] = [];
addCommitGuard(guard: PgCommitGuard): () => void {
  this.guards.push(guard);
  return () => { const i = this.guards.indexOf(guard); if (i >= 0) this.guards.splice(i, 1); };
}
```

`commitWriteBatch` (`:303`) awaits the whole chain in order (empty-batch skip preserved):

```ts
if (guardUnits.length > 0) for (const g of this.guards) await g(tx, guardUnits, shard);
```

`setCommitGuard` is removed; fleet's `installCommitGuard` migrates to `addCommitGuard` (see below).

### SQLite (`sqlite-docstore.ts:169-191`) — the sync fork

SQLite's `commitWriteBatch` runs inside a **synchronous** `db.transaction(() => {...})`. The guard
receives a SYNC querier and returns `void`; a returned thenable is a documented dev error:

```ts
/** SQLite guard: synchronous — it runs inside the one-transaction synchronous commit. Returning a
 *  Promise is a dev error (see the runtime detect below) because the sync txn cannot await it. */
export type SqliteCommitGuard =
  (q: SqliteGuardQuerier, units: readonly CommitGuardUnit[], shardId: ShardId) => void;

/** The narrow synchronous querier a SQLite guard writes receipts through (mirror of PgQuerier but
 *  sync — better-sqlite3/bun:sqlite prepared-statement run/get). */
export interface SqliteGuardQuerier {
  run(sql: string, ...params: unknown[]): void;
  get(sql: string, ...params: unknown[]): Record<string, unknown> | undefined;
}

private guards: SqliteCommitGuard[] = [];
addCommitGuard(guard: SqliteCommitGuard): () => void { /* push + splice-unregister, same as PG */ }
```

Invocation inside the sync transaction (`:177-190`), with the thenable dev-throw:

```ts
return this.db.transaction(() => {
  // ...stamp + insertRows per unit → guardUnits: CommitGuardUnit[]...
  if (guardUnits.length > 0) for (const g of this.guards) {
    const ret = g(sqliteGuardQuerier, guardUnits, shard) as unknown;
    if (ret && typeof (ret as { then?: unknown }).then === "function") {
      throw new Error("[docstore-sqlite] a commit guard returned a Promise; SQLite guards must be synchronous — its writes cannot be awaited inside the single-transaction commit");
    }
  }
  return out;
});
```

Because the guard `q` type forks (async `PgQuerier` vs sync `SqliteGuardQuerier`), the CORE receipts
guard ships as **two closures** kept in lockstep (Risk R9) — the docstore conformance suite covers
both.

### Fleet: handle-managed registration across `armWriter` re-arms

`armWriter` re-arms on EVERY promotion (`node.ts:1475/1609/1643`). With append semantics a naive
`addCommitGuard` per re-arm would STACK duplicate epoch-fence guards → duplicate frontier bumps +
duplicate `fleet_idempotency` INSERTs at the same ts → self-PK-collision → every forwarded commit
aborts. Fix: `installCommitGuard` captures the unregister handle in the `startFleetNode` closure and
releases the prior registration before re-adding:

```ts
// startFleetNode closure scope
let unregisterCommitGuard: (() => void) | null = null;

export function installCommitGuard(pgStore, lease, onFenced): () => void {
  return pgStore.addCommitGuard(async (q, units, shardId) => { /* fence once + per-unit idem loop, unchanged */ });
}

const armWriter = async (seed: boolean) => {
  await balancer.acquireTargetsNow();
  if (seed) await lease.seedFrontierAll(await pgStore.maxTimestamp());
  unregisterCommitGuard?.();                                   // release the prior arm's guard
  unregisterCommitGuard = installCommitGuard(pgStore, lease, (s, r) => relinquish(relinquishDeps, s, r));
  // ...frontier monitor etc unchanged
};
```

Release on `stop()`/`relinquish` of the writer too. (Alternative the verdict permits: register the
epoch guard exactly ONCE at first arm and make re-arm a no-op — the handle-release form is preferred
because it's symmetric with the sync-node→writer→demote lifecycle.)

**Guard registration order** (Risk R6): the CORE receipts guard is registered at store construction
(Tier 0 and up); the fleet epoch fence is registered later at `armWriter`. So receipts runs FIRST.
Recommend the epoch fence run first instead (a fenced node shouldn't waste a client-dup decision) —
either register the fence at store construction on a writer, or have the receipts guard tolerate a
subsequent fence abort (harmless: same txn rolls back atomically either way).

---

## (e) Receipts store APIs — which interface, names, shapes

**They extend `DocStore`** (`packages/docstore/src/types.ts:119-218`) — the SAME capability family
as `getGlobal`/`writeGlobal`/`writeGlobalIfAbsent`, which already live on `DocStore` as small
key-value store primitives. They are NOT a new interface and NOT the guard family (the guard is
*registered via* `addCommitGuard`; these are direct reads/writes). Both stores implement them; the
tables (`client_mutations`, `client_floors`) join `persistence_globals` as core internal tables.

```ts
/** A per-seq verdict record — `client_mutations(identity, client_id, seq)` PK. */
export interface ClientVerdictRecord {
  verdict: "applied" | "failed";
  commitTs: bigint;
  hasValue: boolean;            // false for `failed`, or `applied` whose value was uncached/oversized
  value: JSONValue | null;      // the recorded return (≤64KB) when hasValue; else null
  errorCode: string | null;     // terminal code for `failed`; null for `applied`
  createdAt: number;
}

export interface DocStore {
  // ...existing methods unchanged...

  /** Classification read (verdict §(c)): the recorded verdict for `(identity, clientId, seq)`, or
   *  null (never seen). Anonymous clients key as identity `""`. PK point lookup (AC10.4). */
  getClientVerdict(identity: string, clientId: string, seq: number): Promise<ClientVerdictRecord | null>;

  /** The `client_floors(identity, client_id).pruned_through_seq`, or null when no floor exists
   *  (fresh client). A presented `seq <= floor` with no record → STALE_CLIENT (verdict decision 3). */
  getClientFloor(identity: string, clientId: string): Promise<number | null>;

  /** Standalone `failed`-verdict write (verdict §(c)): its OWN tiny transaction, no effects to be
   *  atomic with. Idempotent — INSERT ... ON CONFLICT DO NOTHING (a concurrent resend that also
   *  failed races here; last/first-wins, never a hard error — see Risk R3). */
  recordClientVerdict(
    identity: string, clientId: string, seq: number,
    record: { verdict: "failed"; errorCode: string; commitTs: bigint; value?: JSONValue },
  ): Promise<void>;

  /** Reaper prune (verdict §(c) Retention): delete `client_mutations` rows for `(identity,clientId)`
   *  with `seq <= ackedThrough` OR `createdAt < ttlBeforeMs`, and advance `client_floors.
   *  pruned_through_seq` to the highest seq the prune COVERS (records deleted OR holes skipped —
   *  decision 3) in the SAME transaction. Returns the new floor. TTL sweep runs on the storageReaper
   *  driver seam. */
  pruneClientMutations(
    identity: string, clientId: string,
    opts: { ackedThrough?: number; ttlBeforeMs?: number },
  ): Promise<{ prunedThroughSeq: number }>;
}
```

**The `applied` write is NOT a method here** — it is done by the receipts commit guard (registered
via `addCommitGuard`), reading `identity`/`clientId`/`seq` off `CommitGuardUnit.meta` and INSERTing
the `client_mutations` row at the unit's `ts`, inside the mutation's own commit txn. On the guard's
own PK collision it throws `CommitGuardRejection(i, "CLIENT_MUTATION_DUP", ...)` → the loser
replay-reads via `getClientVerdict`.

### T2 / T4 shared region in `types.ts` — EXACT line ownership

T2 (guard chain) and T4 (receipts store) both edit `packages/docstore/src/types.ts` in parallel
worktrees. Anchors chosen so the two never touch the same hunk:

| Region in `types.ts` | Owner | Exact edit |
|---|---|---|
| `CommitGuardUnit` (`:86-96`) | **NEITHER** | Unchanged — dedup fields ride the existing `meta?: Record<string,string>` (`clientId`/`seq`/`identity` string keys). This is the deliberate de-conflict. |
| `DocStore` interface — new method decl **immediately after `commitWriteBatch` (`:171`)** | **T2** | `addCommitGuard(guard): () => void` (the PG variant lives in `postgres-docstore.ts`; the interface carries the store-agnostic doc + a `CommitGuard`/unregister type note). |
| `DocStore` interface — new method decls **immediately before `close()` (`:216`)** | **T4** | `getClientVerdict` / `getClientFloor` / `recordClientVerdict` / `pruneClientMutations`. |
| New exported types block **appended at end of file (after `getPrevRevQueryKey`, `:242`)** | **T4** | `ClientVerdictRecord` (+ any floor row type). |
| `SqliteGuardQuerier` / `PgCommitGuard` / `SqliteCommitGuard` types | **T2** | In the respective store packages, NOT `types.ts` (they reference store-specific queriers). |

Rule: **T2 inserts only after `commitWriteBatch`; T4 inserts only before `close()` and at EOF.**
Distinct, non-adjacent anchors → a clean 3-way merge. `CommitGuardRejection` is in
`@stackbase/errors` (T2), not `types.ts`. Integration order: **T2 merges first** (delivers
`addCommitGuard`), then T4's receipts-guard registration compiles against it; until then T4 codes to
this doc's `addCommitGuard` signature.

Same-file overlap in the store packages: in `postgres-docstore.ts` and `sqlite-docstore.ts`, **T2
owns `commitWriteBatch` + the guard-slot→chain conversion**; **T4 owns the 4 new methods + the two
new `SCHEMA_STATEMENTS` (`client_mutations`, `client_floors`) + the receipts guard closure it
registers via `addCommitGuard`**. T4 never edits `commitWriteBatch`; T2 never edits
`SCHEMA_STATEMENTS`.

---

## Risk list (things the spec under-priced or left implicit)

- **R1 — No-op-but-successful mutations get NO receipt (sharpest).** A mutation that stages ZERO
  writes returns `{committed:false}` BEFORE the store/guard is ever touched (`shard-writer.ts:317-321,
  437-440`; the PG guard is also skipped for an empty batch, `postgres-docstore.ts:302-303`). So a
  successful *no-op* mutation (`if (already) return;`) writes NO `client_mutations` row → on resend
  it has no record and (above floor) RE-RUNS. Effect-wise this is safe (it's a no-op, and verdict
  §(b)'s corollary says a no-record seq "provably never applied — safe to run"), but the client's
  first vs replayed value can differ if the no-op path returns something non-deterministic. Decide &
  document: either (a) accept re-run of zero-write mutations as within AC8.1 "no-op by own logic", or
  (b) force a receipt-only commit for a zero-write mutation carrying a `dedup` key. Recommend (a) +
  an explicit doc line; (b) reintroduces a privileged zero-doc commit path the verdict deliberately
  dissolved.

- **R2 — Two dedup mechanisms compose on the forwarded path.** A forwarded outbox mutation carries
  BOTH `idempotencyKey` (fleet, per-hop, `ee/`) AND `{clientId, seq}` (client, durable, core). Both
  guards INSERT in the same txn; the two PK spaces are independent, but the REPLAY precedence must be
  pinned: the client `getClientVerdict` is the DURABLE truth (survives fleet-key TTL), so on the
  owner's catch-and-replay prefer the client verdict when a `dedup` key is present; fall back to the
  fleet idempotency replay otherwise. Define this precedence in the T-later http-handler task.

- **R3 — Concurrent `failed`-record writes collide.** Two resends of the same poison seq both fail
  and both call `recordClientVerdict` → PK collision. `recordClientVerdict` MUST be idempotent
  (`ON CONFLICT DO NOTHING`), never a hard throw. Signature says so; flag for the impl.

- **R4 — Verdict instability window (documented in the verdict, restated).** Crash between terminal
  fail and `recordClientVerdict` → resend re-executes and deterministically fails again. A store-
  write's width; acceptable, must be in `docs/enduser/offline.md`.

- **R5 — Classify-read is racy; the guard is the only correctness barrier.** The async
  `getClientVerdict` and the (sync-SQLite / async-PG) commit are NOT under one lock. A duplicate that
  slips the read hits the guard PK → `CommitGuardRejection` → loser replay-reads. Any impl that
  skips the guard "because we already classified" is a correctness bug (fact 2).

- **R6 — Guard registration/execution order.** Receipts guard (registered at construction) runs
  BEFORE the fleet epoch fence (registered at `armWriter`). A fenced node would run a client-dup
  decision it should skip. Prefer fence-first (register the fence at construction on writers, or make
  receipts tolerant of a later abort — harmless under atomic rollback but wasteful).

- **R7 — Replay must skip `notifyWrites` AND the G4 frontier.** A `MutationReplay` did NOT write this
  call; its `commitTs` is the ORIGINAL (long past the current frontier). The handler must NOT call
  `notifyWrites` (empty write set, harmless but wasteful) and must NOT arm a `pendingFrontier`
  (`handler.ts:288-294`) for a ts already surpassed. Branch on `r.replayed` before both.

- **R8 — `CommitGuardRejection` must round-trip the fleet hop.** `http-handler.ts:275-276` serializes
  via `toStackbaseError`/`errorJson`; a SYNC node rehydrating a forwarded failure must reconstruct
  `CommitGuardRejection` (with `rejectionCode`/`unitIndex`) or at least its `code`, else the typed
  `instanceof` check on the sync side fails. On the OWNER the local `instanceof` holds (throw before
  serialize). Confirm the errors rehydration table carries the new subclass + its extra fields.

- **R9 — The core receipts guard is TWO closures (sync SQLite + async PG).** Same drift class the
  docstore conformance suite already governs. Add `getClientVerdict`/`getClientFloor`/
  `recordClientVerdict`/`pruneClientMutations` + guard-write behavior to the shared conformance suite
  (SQLite + PGlite) so parity is proven, not asserted.

- **R10 — `seq` numeric domain.** Wire `seq?: number` (JS ≤2^53) is fine for a per-tab counter, but
  it is stringified into `meta` and stored; keep `number` on all store-API signatures, stringify
  ONLY at the `meta` boundary, parse back in the guard. No `bigint` for seq.

- **R11 — `RunOptions.dedup` is mutation-only.** Like `commitMeta`/`origin`, setting it on a query is
  a harmless no-op (a query never reaches the commit path). Document identically; the executor
  ignores it for non-mutation kinds.

- **R12 — `run`'s return type widens to a union.** `runtime.run`/`executor.run`'s `UdfResult` now may
  represent a replay. Rather than widening `UdfResult` everywhere, prefer returning the replay from
  the sync-executor `runMutation` boundary (and the `/_fleet/run` handler) as `RunMutationResult`,
  keeping `UdfResult` (used by `POST /api/run`, actions, drivers) untouched. Decide the seam so the
  non-dedup callers (the vast majority) see zero type churn.

---

## Bottom line

The classification read is a threaded option (`DedupKey`) that resolves at the OWNER inside
`runMutation`/`run`, never in the sync handler; it returns a discriminated `MutationRan | MutationReplay`.
The guard is the correctness barrier — a chain via `addCommitGuard(guard): () => void` on both stores
(async PG, sync SQLite with a thenable dev-throw), fleet re-arm managed by an unregister handle,
rejecting a single unit with a typed `CommitGuardRejection {unitIndex, code, detail}` in
`@stackbase/errors`. The receipts reads/writes/prune are four new `DocStore` methods; the `applied`
write is the guard, the `failed` write is standalone `recordClientVerdict`. T2 owns the guard chain
(post-`commitWriteBatch` anchor + errors + fleet re-arm + committer split); T4 owns the receipts
methods (pre-`close()` anchor + EOF types block + schema + the guard closure it registers). Sharpest
open risk: **no-op successful mutations get no receipt and re-run — decide accept-vs-force-receipt.**
