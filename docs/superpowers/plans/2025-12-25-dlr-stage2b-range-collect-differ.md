# DLR Stage 2b — Single-Index-Range `collect()` Differ Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the DLR by-id diff pipeline to single-index-range `collect()` queries (with declarative `.where()` filters), so a list subscription receives incremental `QueryDiff`s (add/edit/remove/move) instead of a full re-send — collapsing `diffbytes-scan` wire bytes — proven end-to-end through the real dev server and gated by the benchmark.

**Architecture:** The executor classifies a query run as `DIFFABLE_RANGE` iff it was exactly one index-range `collect()` whose result the handler returned unmodified (the passthrough guard — the checksum cannot catch a post-processed handler). It surfaces `{keyspace, bounds, filters, order, fields}` to the sync tier, which records it on the subscription. A range `CommitDiffer` derives `Change[]` from the commit's written docs by membership (`extractIndexKey` + the engine's own `evaluateFilter`), using a per-sub result-set map as the old-state oracle — no store read. Each `add`/`edit` carries an `orderKey`; the client sorts its row-map by it. The drift checksum folds `orderKey` to catch moves. Everything else stays on the untouched 2a by-id path or the RERUN oracle.

**Tech Stack:** TypeScript, vitest, Bun. Packages: `@stackbase/sync` (classifier, differ, shared Change vocab), `@stackbase/executor` (diffable classification), `@stackbase/query-engine` (`evaluateFilter` — reused), `@stackbase/index-key-codec` (`extractIndexKey`/`compareKeyBytes`), `@stackbase/client` (range rendering), `@stackbase/cli` (E2E), `@stackbase/bench` (gate).

## Global Constraints

- **RERUN is the untouched oracle.** Any subscription not classified DIFFABLE (by-id or range) keeps today's exact `execSub` + `QueryUpdated` path. Never change it.
- **The 2a by-id path is untouched.** `classifyByIdRead`, `byIdResetChanges`, `byIdChangesFor`, and the by-id render stay behaviorally identical. New range code sits alongside.
- **Capability-gated + additive wire.** `QueryDiff` is sent only to a session that advertised `supportsQueryDiff`. `Change` gains an OPTIONAL `orderKey`; the `QueryDiff` reset gains an OPTIONAL `{mode, orderDir}` descriptor. Old clients ignore unknown fields.
- **Passthrough is correctness-critical.** A sub is DIFFABLE_RANGE only if the executor confirms the handler returned exactly the one collect syscall's ordered docs, unmodified. Any JS post-processing, any second read, any read-policy on the table → RERUN. The drift checksum does NOT catch a misclassified post-processed handler.
- **Reuse the engine's evaluator.** Filter re-application MUST call `@stackbase/query-engine`'s `evaluateFilter` — never a reimplementation — or the differ and `execSub` can diverge.
- **`writtenDocs` optional; absence → RERUN.** Fleet/forwarded/HTTP-external commits carry no `writtenDocs`; affected range subs fall back to RERUN for that commit.
- **Fresh reference each apply** (client): a range diff must produce a NEW array reference so `LayeredQueryStore.recompose` fires listeners.
- **No `Math.random`** in production code.

---

### Task 1: Confirm the recorded read-set shape of a `collect()` (verification spike)

The classifier's "exactly one index-keyspace range" condition depends on what `readRanges` a `collect()` actually records. Confirm it before writing the classifier, so the condition is correct rather than assumed (spec §7 open item).

**Files:**
- Test: `packages/executor/test/collect-readset-shape.test.ts` (create — a characterization test, kept as a regression guard)

**Interfaces:**
- Consumes: the existing executor test harness (`createExecutor`/`runQuery` — copy the setup idiom from `packages/executor/test/*.test.ts`).
- Produces: a documented, asserted fact — the exact `readRanges` a filtered and an unfiltered single-index `collect()` records (one `index:<enc>` range only, or an index range PLUS per-row `table:<enc>` primary points).

- [ ] **Step 1: Write the characterization test**

`packages/executor/test/collect-readset-shape.test.ts` — define a tiny schema (`items: { channelId: string, n: number }` with an index `by_channel` on `["channelId"]`), insert 3 rows in one channel via a mutation, then run a query `items.list = ctx.db.query("items","by_channel").eq("channelId","c").collect()` and a filtered variant `.eq("channelId","c").where("gt","n",1).collect()`. Assert on the shape of the returned `readRanges`:

```ts
import { describe, it, expect } from "vitest";
// ...copy the executor test harness setup (schema, runMutation, runQuery) from an existing
//   packages/executor/test/*.test.ts — e.g. query-*.test.ts — do NOT invent a new harness...

describe("collect() recorded read-set shape (DLR 2b Task 1)", () => {
  it("an unfiltered single-index collect records read-ranges we can classify", async () => {
    // ...seed 3 rows in channel "c"...
    const { readRanges } = await runQuery("items:list", { channelId: "c" });
    // Characterize: how many ranges, and each range's keyspace prefix.
    const keyspaces = readRanges.map((r) => r.keyspace.split(":")[0]);
    // eslint-disable-next-line no-console
    console.log("unfiltered collect readRanges:", JSON.stringify(readRanges));
    expect(readRanges.length).toBeGreaterThanOrEqual(1);
    // The index range MUST be present:
    expect(keyspaces).toContain("index");
  });
  it("a .where()-filtered collect records the same index range shape", async () => {
    const { readRanges } = await runQuery("items:listFiltered", { channelId: "c" });
    // eslint-disable-next-line no-console
    console.log("filtered collect readRanges:", JSON.stringify(readRanges));
    expect(readRanges.some((r) => r.keyspace.startsWith("index:"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and READ the console output**

Run: `bun run --filter @stackbase/executor test collect-readset-shape`
Record the answer in the test file as a top-of-file comment: **"A single-index collect records exactly ONE `index:<enc>` range [and N `table:<enc>` primary points | and nothing else]."** This fact drives Task 4's classifier condition.

- [ ] **Step 3: Tighten the assertions to the observed shape**

Replace the loose assertions with exact ones matching what you observed (e.g. `expect(readRanges.filter(r => r.keyspace.startsWith("index:")).length).toBe(1)` and, if primary points are recorded, assert their count/shape too). This is now a regression guard for the classifier's assumption.

- [ ] **Step 4: Commit**

```bash
git add packages/executor/test/collect-readset-shape.test.ts
git commit -m "test(executor): characterize collect() recorded read-set shape (DLR 2b Task 1)"
```

---

### Task 2: `orderKey` on the shared `Change` vocab + checksum fold

**Files:**
- Modify: `packages/sync/src/change.ts`
- Test: `packages/sync/test/change.test.ts` (extend)

**Interfaces:**
- Produces (imported by server + client):
  - `Change` `add`/`edit` gain optional `orderKey?: string` (base64 index-entry-key bytes; absent for by-id).
  - `RowVersion` gains optional `orderKey?: string`.
  - `applyChanges` stores `orderKey` into the map entry.
  - `driftChecksum` folds `hash(key) ⊕ ts ⊕ hash(orderKey ?? "")` per row — order-independent, now sensitive to a moved row.

- [ ] **Step 1: Write the failing tests**

Append to `packages/sync/test/change.test.ts`:

```ts
describe("orderKey (DLR 2b)", () => {
  it("applyChanges stores orderKey on the row", () => {
    const out = applyChanges(new Map(), [{ t: "add", key: "a", row: { _id: "a" }, ts: 5, orderKey: "AAAB" }]);
    expect(out.get("a")).toEqual({ row: { _id: "a" }, ts: 5, orderKey: "AAAB" });
  });
  it("a move (same key+ts, new orderKey) changes the checksum", () => {
    const m1 = applyChanges(new Map(), [{ t: "add", key: "a", row: {}, ts: 5, orderKey: "AAAB" }]);
    const m2 = applyChanges(new Map(), [{ t: "add", key: "a", row: {}, ts: 5, orderKey: "AAAC" }]);
    expect(driftChecksum(m1)).not.toBe(driftChecksum(m2));
  });
  it("by-id changes (no orderKey) keep the SAME checksum as before this change", () => {
    // orderKey === undefined must fold identically to orderKey === "" — a by-id map is unchanged.
    const byId = applyChanges(new Map(), [{ t: "add", key: "n1", row: { _id: "n1", n: 1 }, ts: 5 }]);
    const explicitEmpty = applyChanges(new Map(), [{ t: "add", key: "n1", row: { _id: "n1", n: 1 }, ts: 5, orderKey: "" }]);
    expect(driftChecksum(byId)).toBe(driftChecksum(explicitEmpty));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run --filter @stackbase/sync test change`
Expected: FAIL — `applyChanges` drops `orderKey`; checksum ignores it.

- [ ] **Step 3: Implement**

In `packages/sync/src/change.ts`:

```ts
export type Change =
  | { t: "add"; key: string; row: JSONValue; ts: number; orderKey?: string }
  | { t: "remove"; key: string }
  | { t: "edit"; key: string; row: JSONValue; ts: number; orderKey?: string };

export interface RowVersion {
  row: JSONValue;
  ts: number;
  orderKey?: string;
}

export function applyChanges(rows: Map<string, RowVersion>, changes: readonly Change[]): Map<string, RowVersion> {
  const out = new Map(rows);
  for (const c of changes) {
    if (c.t === "remove") out.delete(c.key);
    else out.set(c.key, { row: c.row, ts: c.ts, orderKey: c.orderKey });
  }
  return out;
}
```

And extend the checksum fold — after mixing `key` + `ts`, mix `orderKey ?? ""`:

```ts
export function driftChecksum(rows: Map<string, RowVersion>): string {
  let acc = 0;
  for (const [key, rv] of rows) {
    let h = 0x811c9dc5;
    const mix = (byte: number): void => { h ^= byte; h = Math.imul(h, 0x01000193) >>> 0; };
    for (let i = 0; i < key.length; i++) mix(key.charCodeAt(i) & 0xff);
    mix(0x00);
    const tsStr = String(rv.ts);
    for (let i = 0; i < tsStr.length; i++) mix(tsStr.charCodeAt(i) & 0xff);
    mix(0x00);
    const ok = rv.orderKey ?? "";
    for (let i = 0; i < ok.length; i++) mix(ok.charCodeAt(i) & 0xff);
    acc = (acc ^ (h >>> 0)) >>> 0;
  }
  return acc.toString(16).padStart(8, "0");
}
```

> Note: the extra `mix(0x00)` separator + folding `""` for by-id changes the 2a by-id checksum VALUE, but server and client both use this same function, so they still agree. The "by-id unchanged" test above only asserts `undefined` ≡ `""`, which holds. The 2a E2E (unchanged code path) re-confirms end-to-end agreement.

- [ ] **Step 4: Run to verify pass**

Run: `bun run --filter @stackbase/sync test change` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sync/src/change.ts packages/sync/test/change.test.ts
git commit -m "feat(sync): Change/RowVersion carry orderKey; driftChecksum folds it (DLR 2b)"
```

---

### Task 3: Executor surfaces the `DIFFABLE_RANGE` classification

Only the executor sees both the collect syscall's result AND the handler's return, so it owns the passthrough guard. Track, per query run, the single-collect metadata; after the handler returns, decide diffability.

**Files:**
- Modify: `packages/executor/src/kernel.ts` (record each `db.query` collect's metadata onto the kernel context)
- Modify: `packages/executor/src/executor.ts` (assemble `diffableRange` and return it from `runQuery`)
- Modify: `packages/sync/src/handler.ts:87-105` (extend the `SyncUdfExecutor.runQuery`/`runAdminQuery` return type)
- Test: `packages/executor/test/diffable-range.test.ts` (create)

**Interfaces:**
- Produces:
  - `DiffableRange = { keyspace: string; bounds: SerializedKeyRange; filters: FilterExpr[]; order: "asc" | "desc"; fields: string[] }` (exported from `@stackbase/executor`).
  - `runQuery(...)` return gains `diffableRange?: DiffableRange` (present iff exactly one index-range `collect` ran, no read policy merged, no other read syscall, and the handler's returned value's ordered `_id`s equal that collect's ordered doc `_id`s).
  - `SyncUdfExecutor.runQuery`/`runAdminQuery` (handler.ts) return type extended with `diffableRange?: DiffableRange`.

- [ ] **Step 1: Write the failing executor test**

`packages/executor/test/diffable-range.test.ts` — using the executor harness (copy setup from an existing executor test): schema `items: {channelId, n}` index `by_channel:["channelId"]`. Define queries: `list` = `q.eq("channelId", a).collect()` (passthrough), `listFiltered` = `q.eq("channelId", a).where("gt","n",1).collect()` (passthrough + filter), `listMapped` = `(await q.eq(...).collect()).map(d => ({...d, x: 1}))` (post-processed), `listSliced` = `(await q...collect()).slice(0,1)` (post-processed), `getOne` = `ctx.db.get(id)` (by-id, not range).

```ts
describe("runQuery diffableRange classification (DLR 2b Task 3)", () => {
  it("a pure index-range collect returned unmodified is DIFFABLE_RANGE", async () => {
    const r = await runQuery("items:list", { channelId: "c" });
    expect(r.diffableRange).toBeDefined();
    expect(r.diffableRange!.keyspace.startsWith("index:")).toBe(true);
    expect(r.diffableRange!.fields).toEqual(["channelId"]);
    expect(r.diffableRange!.order).toBe("asc");
    expect(r.diffableRange!.filters).toEqual([]); // no .where()
  });
  it("a .where()-filtered collect is DIFFABLE_RANGE carrying the filters", async () => {
    const r = await runQuery("items:listFiltered", { channelId: "c" });
    expect(r.diffableRange).toBeDefined();
    expect(r.diffableRange!.filters.length).toBe(1);
  });
  it("a handler that maps/slices the collect result is NOT diffable (passthrough fails)", async () => {
    expect((await runQuery("items:listMapped", { channelId: "c" })).diffableRange).toBeUndefined();
    expect((await runQuery("items:listSliced", { channelId: "c" })).diffableRange).toBeUndefined();
  });
  it("a by-id get is NOT a range (diffableRange undefined)", async () => {
    expect((await runQuery("items:getOne", { id })).diffableRange).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run --filter @stackbase/executor test diffable-range`
Expected: FAIL — `diffableRange` is not returned.

- [ ] **Step 3: Record collect metadata in the kernel**

In `packages/executor/src/kernel.ts` `handleDbQuery`, after the collect returns, push a record onto a per-run list on the kernel context. Add a `collectTrace?: CollectTrace[]` field to `KernelContext` (define `interface CollectTrace { keyspace: string; bounds: SerializedKeyRange; filters: FilterExpr[]; order: "asc"|"desc"; fields: string[]; docIds: string[]; hadReadPolicy: boolean }`), and in `handleDbQuery`:

```ts
// after: const { documents, readSet } = await ctx.queryRuntime.collect(...)
if (ctx.collectTrace) {
  ctx.collectTrace.push({
    keyspace: indexKeyspaceId(encodeStorageTableId(indexSpec.tableNumber), indexSpec.index), // the sub's index keyspace (matches readRanges)
    bounds: serializeKeyRange(/* the scanned KeyRange for this index — from the plan/readSet; see note */),
    filters: (spec.filters ?? []).map((f) => ({ op: f.op, field: f.field, value: jsonToConvex(f.value) }) as FilterExpr), // the USER filters only (pre-policy-merge)
    order: spec.order,
    fields: indexSpec.fields,
    docIds: documents.map((d) => (d as { _id: string })._id),
    hadReadPolicy: !ctx.privileged && !!ctx.getRuleContext && !!ctx.policyRegistry.get(tableName)?.read,
  });
}
```

> **`bounds`:** capture the index-range bounds this collect scanned. Reuse the same range the read-set records for this index keyspace (the `index:` `SerializedKeyRange` in `readSet.toArray()`), so `bounds` is byte-identical to what the sub's `readRanges` hold. If more than one `index:` range is present for this collect, that is not a clean single-range read → do NOT record (leave the trace entry out) so Step 4 declines it.
> **Filters BEFORE the policy merge:** capture `spec.filters` (the user's `.where()` ops), NOT the post-`mergeReadPolicy` set. `hadReadPolicy` flags that a policy WAS merged so Step 4 declines diffability (re-applying dynamic authz in the differ is unsound — RERUN instead).

- [ ] **Step 4: Assemble `diffableRange` in the executor**

In `packages/executor/src/executor.ts`, in the query `invoke` path (the branch that returns `{ value, ..., readRanges }` for a query — near line 460), initialize `kctx.collectTrace = []` before running the handler, and after it returns compute:

```ts
function classifyDiffableRange(value: unknown, trace: CollectTrace[]): DiffableRange | undefined {
  if (trace.length !== 1) return undefined;         // exactly one collect, no other read syscall
  const t = trace[0]!;
  if (t.hadReadPolicy) return undefined;            // dynamic authz — RERUN
  if (!Array.isArray(value)) return undefined;      // not a list result
  if (value.length !== t.docIds.length) return undefined;
  for (let i = 0; i < value.length; i++) {
    const id = (value[i] as { _id?: unknown })?._id;
    if (typeof id !== "string" || id !== t.docIds[i]) return undefined; // post-processed / reordered
  }
  return { keyspace: t.keyspace, bounds: t.bounds, filters: t.filters, order: t.order, fields: t.fields };
}
```

Return it: `return { value, ..., readRanges: ..., diffableRange: classifyDiffableRange(value, kctx.collectTrace ?? []) }`. Note: `trace.length !== 1` also rejects a handler that did a `db.get` PLUS a collect — a `db.get` records no collect-trace entry but IS another read; if a second read syscall could leave `trace.length === 1` while reading elsewhere, also guard on the run having recorded no `table:`-keyspace point reads beyond the collect (cross-check with `readRanges`). Keep the guard conservative: any doubt → `undefined`.

Export `DiffableRange` + `CollectTrace` from `packages/executor/src/index.ts`.

- [ ] **Step 5: Extend the `SyncUdfExecutor` return type**

In `packages/sync/src/handler.ts` lines 87-105, add `diffableRange?: DiffableRange` (import the type from `@stackbase/executor`) to the return type of `runQuery` AND `runAdminQuery`, and to `execSub`'s return type (line 320). No behavior change yet — just the type flows through.

- [ ] **Step 6: Run to verify pass**

Run: `bun run --filter @stackbase/executor test diffable-range` → PASS. Then `bun run --filter @stackbase/executor test` (full package) → PASS (nothing else regressed).

- [ ] **Step 7: Commit**

```bash
git add packages/executor/src/kernel.ts packages/executor/src/executor.ts packages/executor/src/index.ts packages/sync/src/handler.ts packages/executor/test/diffable-range.test.ts
git commit -m "feat(executor): classify DIFFABLE_RANGE (single-collect passthrough) and surface it from runQuery (DLR 2b)"
```

---

### Task 4: `RangeRead` classification recorded on the subscription

**Files:**
- Modify: `packages/sync/src/classify.ts` (add `RangeRead` + a helper that adapts a `DiffableRange` to it)
- Modify: `packages/sync/src/subscription-manager.ts` (the `Subscription` type gains `range?: RangeRead`)
- Test: `packages/sync/test/classify.test.ts` (extend)

**Interfaces:**
- Consumes: `DiffableRange` (from `@stackbase/executor`, via the `execSub` result).
- Produces:
  - `RangeRead = { keyspace: string; bounds: SerializedKeyRange; filters: FilterExpr[]; order: "asc" | "desc"; fields: string[] }` (structurally the `DiffableRange`, re-exported from `@stackbase/sync` so the differ + handler consume one type).
  - `Subscription.range?: RangeRead` alongside the existing `byId?: ByIdRead`.

- [ ] **Step 1: Write the failing test**

Extend `packages/sync/test/classify.test.ts`:

```ts
import { rangeReadFromDiffable, type RangeRead } from "../src/classify";

describe("rangeReadFromDiffable (DLR 2b)", () => {
  it("adapts a DiffableRange into a RangeRead verbatim", () => {
    const d = { keyspace: "index:AAA", bounds: { keyspace: "index:AAA", start: "AA", end: "AB" }, filters: [], order: "asc" as const, fields: ["channelId"] };
    const r: RangeRead = rangeReadFromDiffable(d);
    expect(r).toEqual(d);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run --filter @stackbase/sync test classify` → FAIL (no export).

- [ ] **Step 3: Implement**

In `packages/sync/src/classify.ts` add (import `FilterExpr` from `@stackbase/query-engine`, `SerializedKeyRange` already imported):

```ts
export interface RangeRead {
  keyspace: string;
  bounds: SerializedKeyRange;
  filters: FilterExpr[];
  order: "asc" | "desc";
  fields: string[];
}
/** Adapt the executor's DiffableRange (identical shape) into the sync tier's RangeRead. Kept as a
 *  named boundary so the two packages don't share a type import path the differ also depends on. */
export function rangeReadFromDiffable(d: RangeRead): RangeRead {
  return { keyspace: d.keyspace, bounds: d.bounds, filters: d.filters, order: d.order, fields: d.fields };
}
```

In `packages/sync/src/subscription-manager.ts`, add `range?: RangeRead` to the `Subscription` interface (next to `byId?: ByIdRead`). `findAffectedByRanges` is unchanged — a range sub is matched by its `readRanges` exactly as today (the Stage-1 interval index already indexes the index-range).

- [ ] **Step 4: Run to verify pass + full package**

Run: `bun run --filter @stackbase/sync test classify` → PASS. `bun run --filter @stackbase/sync test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sync/src/classify.ts packages/sync/src/subscription-manager.ts packages/sync/test/classify.test.ts
git commit -m "feat(sync): RangeRead classification recorded on the Subscription (DLR 2b)"
```

---

### Task 5: The range `CommitDiffer` (reset + incremental, with the differential oracle)

**Files:**
- Modify: `packages/sync/src/commit-differ.ts` (add `rangeResetChanges` + `rangeChangesFor`)
- Test: `packages/sync/test/commit-differ.test.ts` (extend) + `packages/sync/test/range-differ-oracle.test.ts` (create — the property oracle)

**Interfaces:**
- Consumes: `RangeRead` (Task 4), `WrittenDoc` (`@stackbase/transactor`), `evaluateFilter` (`@stackbase/query-engine`), `extractIndexKey`/`compareKeyBytes`/`deserializeKeyRange` (`@stackbase/index-key-codec`), `applyChanges`/`RowVersion`/`Change` (Task 2).
- Produces:
  - `rangeResetChanges(range, orderedDocs, ts): { changes: Change[]; next: Map<string, RowVersion> }` — one `add` per doc, each with its `orderKey`, in the docs' given (already-sorted) order.
  - `rangeChangesFor(range, prev, writtenDocsForTable): { changes: Change[]; next: Map<string, RowVersion> }` — membership diff for a commit.
  - `orderKeyFor(range, row): string` — the base64 index-entry key (index fields + `_id` tiebreak) used both for membership ordering and the client sort.

- [ ] **Step 1: Write the differ unit tests**

Extend `packages/sync/test/commit-differ.test.ts` with a small `RangeRead` (index keyspace, bounds covering `channelId = "c"`, `filters: []`, `order: "asc"`, `fields: ["channelId"]`) and `WrittenDoc`s. Cover: add (new doc in range), edit (in-range value change, orderKey unchanged), remove (delete → `newRow: null`), cross-out (a `.where("gt","n",1)` filter that the new value now fails → `remove`), cross-in (was failing filter, now passes → `add`), move (index-field change that reorders within range → `edit` with a different `orderKey`), and no-op (a write to a different channel/out of range). Assert the emitted `Change[]` and the resulting `next` map.

- [ ] **Step 2: Write the differential ORACLE test**

`packages/sync/test/range-differ-oracle.test.ts` — the primary correctness net. Build an in-memory reference: a set of docs, a `RangeRead` with an optional `.where` filter. A helper `oracleResult(docs, range)` computes the true ordered result (filter in JS via the same predicate, sort by `orderKeyFor`). Then a randomized loop (seeded deterministically by iteration index — NO `Math.random`): apply a random op (insert / update-in-place / update-index-field=move / update-filter-crossing / delete), build the `WrittenDoc`, run `rangeChangesFor(range, prevMap, [wd])`, and assert:

```ts
// applyChanges(prevMap, changes) sorted by orderKey  ===  oracleResult(currentDocs, range)
const sortedDiff = [...next.values()].sort((a,b)=>compareKeyBytes(b64(a.orderKey), b64(b.orderKey))).map(v=>v.row);
expect(sortedDiff).toEqual(oracleResult(currentDocs, range));
```

Run ~500 iterations across a few seeds. This proves diff+apply(sorted) ≡ a fresh result over the full move/filter-cross space.

- [ ] **Step 3: Run to verify failure**

Run: `bun run --filter @stackbase/sync test commit-differ range-differ-oracle` → FAIL (functions absent).

- [ ] **Step 4: Implement the differ**

In `packages/sync/src/commit-differ.ts`:

```ts
import { evaluateFilter } from "@stackbase/query-engine";
import { extractIndexKey, deserializeKeyRange, compareKeyBytes } from "@stackbase/index-key-codec";
import type { RangeRead } from "./classify";

/** The base64 index-entry key: the index fields' key with the doc's own id appended as the tiebreak,
 *  so it reproduces the engine's (indexKey, id) scan order exactly. Uses the engine's OWN
 *  `extractIndexKey`, so a doc's key here is byte-identical to its stored index entry. */
export function orderKeyFor(range: RangeRead, row: JSONValue): string {
  const key = extractIndexKey(row as Record<string, unknown>, range.fields); // index-field tuple bytes
  const id = String((row as { _id: unknown })._id);
  const full = concatIdTiebreak(key, id); // append id bytes — see note
  return toBase64(full);
}

function inBounds(range: RangeRead, orderKeyB64: string): boolean {
  const { start, end } = deserializeKeyRange(range.bounds);
  const k = fromBase64(orderKeyB64);
  if (start !== null && compareKeyBytes(k, start) < 0) return false;
  if (end !== null && compareKeyBytes(k, end) >= 0) return false; // end exclusive (matches KeyRange semantics)
  return true;
}
function passesFilters(range: RangeRead, row: JSONValue): boolean {
  return range.filters.every((f) => evaluateFilter(row as never, f));
}

export function rangeResetChanges(range: RangeRead, orderedDocs: readonly JSONValue[], ts: number) {
  const changes: Change[] = [];
  const next = new Map<string, RowVersion>();
  for (const row of orderedDocs) {
    const key = String((row as { _id: unknown })._id);
    const orderKey = orderKeyFor(range, row);
    changes.push({ t: "add", key, row, ts, orderKey });
    next.set(key, { row, ts, orderKey });
  }
  return { changes, next };
}

export function rangeChangesFor(range: RangeRead, prev: Map<string, RowVersion>, writtenDocs: readonly WrittenDoc[]) {
  const changes: Change[] = [];
  for (const wd of writtenDocs) {
    const key = wd.docId;
    const before = prev.has(key);
    const after = wd.newRow !== null && (() => {
      const ok = orderKeyFor(range, wd.newRow!);
      return inBounds(range, ok) && passesFilters(range, wd.newRow!);
    })();
    if (!before && after) changes.push({ t: "add", key, row: wd.newRow!, ts: wd.ts, orderKey: orderKeyFor(range, wd.newRow!) });
    else if (before && after) changes.push({ t: "edit", key, row: wd.newRow!, ts: wd.ts, orderKey: orderKeyFor(range, wd.newRow!) });
    else if (before && !after) changes.push({ t: "remove", key });
    // !before && !after → no-op
  }
  return { changes, next: applyChanges(prev, changes) };
}
```

> **Id-tiebreak note:** append the doc id to the index-field key so equal index-field values order by id — matching the engine's `(indexKey, id)` scan order. Use whatever byte encoding the engine's index storage uses for the entry key (check `packages/index-key-codec` / how index entries are keyed); if a ready helper exists (e.g. an `encodeIndexEntryKey(fields, id)`), use it verbatim rather than hand-concatenating. The oracle test (Step 2) will fail loudly if the order diverges from a fresh sort — that is the guard.
> **`inBounds` end-exclusivity:** confirm against `deserializeKeyRange`/`KeyRange` semantics (Stage-1 code) — match them exactly.
> **base64 helpers:** reuse the same base64 encode/decode the existing `classify.ts`/`index-key-codec` use for `SerializedKeyRange.start` (do not introduce a second encoding).

- [ ] **Step 5: Run both tests to green**

Run: `bun run --filter @stackbase/sync test commit-differ range-differ-oracle` → PASS (including ~500 randomized oracle iterations).

- [ ] **Step 6: Commit**

```bash
git add packages/sync/src/commit-differ.ts packages/sync/test/commit-differ.test.ts packages/sync/test/range-differ-oracle.test.ts
git commit -m "feat(sync): range CommitDiffer (membership add/edit/remove/move) + differential oracle (DLR 2b)"
```

---

### Task 6: Wire the range diff into subscribe + invalidation (handler)

**Files:**
- Modify: `packages/sync/src/handler.ts` (`doModifyQuerySet` reset arm; the invalidation loop's diff arm; reuse `byIdRowMap` for range subs)
- Modify: `packages/sync/src/protocol.ts` (the `QueryDiff` reset gains optional `{ mode, orderDir }`)
- Test: `packages/sync/test/commit-differ-handler.test.ts` (extend with a range scenario)

**Interfaces:**
- Consumes: `rangeReadFromDiffable` (Task 4), `rangeResetChanges`/`rangeChangesFor` (Task 5), `execSub().diffableRange` (Task 3).
- Produces: a `QueryDiff` whose RESET carries `{ mode: "range", orderDir }`; incremental range `QueryDiff`s during invalidation. The per-sub row-map (`byIdRowMap`, reused verbatim — it is keyed `subKey(sessionId, queryId)` and holds a `Map<docId, RowVersion>` regardless of by-id vs range) holds the range result set.

- [ ] **Step 1: Extend the protocol type**

In `packages/sync/src/protocol.ts`, extend the `QueryDiff` modification:

```ts
| { type: "QueryDiff"; queryId: number; changes: Change[]; checksum: string; reset?: { mode: "byid" | "range"; orderDir?: "asc" | "desc" } }
```

The `reset` field is present ONLY on a reset (the answer to a subscribe/resync), absent on incremental diffs. (2a's by-id reset MAY set `reset: { mode: "byid" }` for symmetry, or omit it — the client defaults absent → by-id; keep 2a's by-id reset emitting no `reset` to avoid touching its bytes, and let the client default to by-id.)

- [ ] **Step 2: Write the failing handler test**

Extend `packages/sync/test/commit-differ-handler.test.ts` with a range scenario mirroring the existing by-id one: a fake executor whose `runQuery` returns `{ value: [doc1, doc2], tables, readRanges: [indexRange], diffableRange: {...} }`; subscribe → assert the pushed modification is a `QueryDiff` with `reset.mode === "range"`, `reset.orderDir`, and an ordered add-all whose checksum matches `driftChecksum` of the built map. Then feed an invalidation with a `writtenDocs` entry adding a third in-range doc → assert an incremental `QueryDiff` with a single `add` at the right orderKey.

- [ ] **Step 3: Run to verify failure**

Run: `bun run --filter @stackbase/sync test commit-differ-handler` → FAIL.

- [ ] **Step 4: Implement the subscribe reset arm**

In `handler.ts` `doModifyQuerySet` (near line 358-375), AFTER the existing by-id arm, add a range arm. Restructure so classification is: `byId` (from `classifyByIdRead`) OR `range` (from `execSub`'s `diffableRange`). Record whichever on the subscription. Then:

```ts
const range = diffableRange ? rangeReadFromDiffable(diffableRange) : undefined;
this.subscriptions.add({ ...subFields, tables, readRanges, byId, range });
if (range && session.supportsQueryDiff) {
  const orderedDocs = value as JSONValue[]; // passthrough guaranteed the value IS the ordered docs
  const { changes, next } = rangeResetChanges(range, orderedDocs, session.version.ts);
  this.byIdRowMap.set(subKey(session.sessionId, q.queryId), next);
  modifications.push({ type: "QueryDiff", queryId: q.queryId, changes, checksum: driftChecksum(next), reset: { mode: "range", orderDir: range.order } });
} else if (byId && session.supportsQueryDiff) {
  // ...existing 2a by-id arm, unchanged...
} else {
  // ...existing RERUN (QueryUpdated / QueryUnchanged) arm, unchanged...
}
```

- [ ] **Step 5: Implement the invalidation diff arm**

In the invalidation loop (near line 616-628), add a range branch alongside the by-id one:

```ts
if (sub.range && session.supportsQueryDiff && invalidation.writtenDocs) {
  const wds = invalidation.writtenDocs.filter((w) => w.keyspace === primaryKeyspaceOfTable(sub /* the sub's table */));
  // ...OR simpler: filter writtenDocs to this sub's table via the table encoded in sub.tables...
  const key = subKey(sub.sessionId, sub.queryId);
  const prevMap = this.byIdRowMap.get(key) ?? new Map<string, RowVersion>();
  const { changes, next } = rangeChangesFor(sub.range, prevMap, wds);
  this.byIdRowMap.set(key, next);
  if (changes.length > 0) modifications.push({ type: "QueryDiff", queryId: sub.queryId, changes, checksum: driftChecksum(next) });
  else modifications.push({ type: "QueryDiff", queryId: sub.queryId, changes: [], checksum: driftChecksum(next) }); // empty diff keeps the frontier advancing; client no-ops
  continue;
}
if (sub.byId && session.supportsQueryDiff && invalidation.writtenDocs) { /* ...existing 2a... */ }
```

> **Which `writtenDocs` feed the range differ:** a range sub cares about EVERY written doc in its TABLE (a write anywhere in the table might enter/exit its range), not just docs at a single key. Filter `invalidation.writtenDocs` to those whose table matches the sub's table. The sub already records `tables`; match `wd`'s table against it. (`wd.keyspace` is the primary `table:<enc>` keyspace; derive the table encoding for comparison, or match on the table number encoded in both.) Confirm the exact match key against `WrittenDoc.keyspace` + the sub's recorded table encoding during implementation.
> **Refresh-classification on RERUN fallback:** if a range sub ever falls to RERUN for a commit (no `writtenDocs`), drop its `byIdRowMap` entry (like the by-id RERUN fallback at line 646) so a later diff re-seeds from a fresh reset rather than a stale map.

- [ ] **Step 6: Run to green + full package**

Run: `bun run --filter @stackbase/sync test commit-differ-handler` → PASS. `bun run --filter @stackbase/sync test` → PASS (2a by-id handler tests unchanged).

- [ ] **Step 7: Commit**

```bash
git add packages/sync/src/handler.ts packages/sync/src/protocol.ts packages/sync/test/commit-differ-handler.test.ts
git commit -m "feat(sync): emit range QueryDiff on subscribe + invalidation; reset carries {mode,orderDir} (DLR 2b)"
```

---

### Task 7: Client range rendering (`MaterializedCache`)

**Files:**
- Modify: `packages/client/src/layered-store.ts` (`renderRangeValue` + a per-sub render mode; `applyDiff` dispatch)
- Modify: `packages/client/src/reconcile.ts` (pass the reset descriptor into `applyDiff`)
- Test: `packages/client/test/materialized-cache.test.ts` (extend)

**Interfaces:**
- Consumes: `applyChanges`/`driftChecksum`/`Change`/`RowVersion` (with `orderKey`), `compareKeyBytes` (`@stackbase/index-key-codec`).
- Produces: `Subscription.renderMode?: "byid" | "range"` + `orderDir?: "asc" | "desc"` (set from a reset's `reset` descriptor); `applyDiff(sub, changes, checksum, reset?)` renders by-id (sole entry) or range (sorted array) per the recorded mode.

- [ ] **Step 1: Write the failing range test**

Extend `packages/client/test/materialized-cache.test.ts`:

```ts
import { compareKeyBytes } from "@stackbase/index-key-codec";

describe("LayeredQueryStore.applyDiff — range mode (DLR 2b)", () => {
  it("a range reset renders a sorted array; edits/moves re-sort; removes drop", () => {
    const s = new LayeredQueryStore();
    const sub = s.create(1, "items:list", { channelId: "c" }, "h1");
    // reset with two docs, orderKeys out of insertion order to prove sorting
    s.applyDiff(sub, [
      { t: "add", key: "b", row: { _id: "b", n: 2 }, ts: 5, orderKey: "QUJC" }, // "ABC"
      { t: "add", key: "a", row: { _id: "a", n: 1 }, ts: 5, orderKey: "QUFB" }, // "AAA"
    ], /* checksum */ ck2(...), { mode: "range", orderDir: "asc" });
    expect((sub.serverValue as Array<{ _id: string }>).map((d) => d._id)).toEqual(["a", "b"]);
    // a move: b's orderKey now sorts before a
    s.applyDiff(sub, [{ t: "edit", key: "b", row: { _id: "b", n: 2 }, ts: 6, orderKey: "QQAA" }], ck2(...));
    expect((sub.serverValue as Array<{ _id: string }>).map((d) => d._id)).toEqual(["b", "a"]);
    const before = sub.serverValue;
    s.applyDiff(sub, [{ t: "remove", key: "a" }], ck2(...));
    expect(sub.serverValue).not.toBe(before); // fresh array reference
    expect((sub.serverValue as Array<{ _id: string }>).map((d) => d._id)).toEqual(["b"]);
  });
  it("an empty range reset renders []", () => {
    const s = new LayeredQueryStore();
    const sub = s.create(1, "items:list", { channelId: "c" }, "h1");
    s.applyDiff(sub, [], driftChecksum(new Map()), { mode: "range", orderDir: "asc" });
    expect(sub.serverValue).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run build --filter @stackbase/sync --filter @stackbase/client && bun run --filter @stackbase/client test materialized-cache` → FAIL (`applyDiff` ignores `reset`/mode; renders by-id only).

- [ ] **Step 3: Implement**

In `packages/client/src/layered-store.ts`: add to `Subscription` a `renderMode?: "byid" | "range"` and `orderDir?: "asc" | "desc"`. Add the render helper (import `compareKeyBytes` + a base64→bytes decode consistent with the server's `orderKey` encoding):

```ts
function renderRangeValue(rows: Map<string, RowVersion>, orderDir: "asc" | "desc"): Value {
  const entries = [...rows.values()].sort((a, b) => compareKeyBytes(fromBase64(a.orderKey ?? ""), fromBase64(b.orderKey ?? "")));
  if (orderDir === "desc") entries.reverse();
  return entries.map((e) => jsonToConvex(e.row)) as Value; // fresh array each apply
}
```

Extend `applyDiff` to accept an optional reset descriptor and dispatch by mode:

```ts
applyDiff(sub: Subscription, changes: readonly Change[], checksum: string, reset?: { mode: "byid" | "range"; orderDir?: "asc" | "desc" }): { drift: boolean } {
  if (reset) { sub.renderMode = reset.mode; sub.orderDir = reset.orderDir; }
  const next = applyChanges(sub.diffRows ?? new Map<string, RowVersion>(), changes);
  sub.diffRows = next;
  sub.serverValue = sub.renderMode === "range" ? renderRangeValue(next, sub.orderDir ?? "asc") : renderByIdValue(next);
  sub.lastHash = undefined;
  sub.answered = true;
  return { drift: driftChecksum(next) !== checksum };
}
```

In `packages/client/src/reconcile.ts`, the `QueryDiff` arm passes the reset through: `this.store.applyDiff(sub, mod.changes, mod.checksum, mod.reset)`.

- [ ] **Step 4: Run to green + full client suite**

Run: `bun run build --filter @stackbase/client && bun run --filter @stackbase/client test` → PASS (2a materialized-cache tests unchanged — by-id has no `reset`, defaults to by-id render).

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/layered-store.ts packages/client/src/reconcile.ts packages/client/test/materialized-cache.test.ts
git commit -m "feat(client): range render mode in MaterializedCache (sorted by orderKey) (DLR 2b)"
```

---

### Task 8: E2E — range `QueryDiff` round-trip through the real dev server

**Files:**
- Test: `packages/cli/test/range-diff-e2e.test.ts` (create)

**Interfaces:**
- Consumes: the whole pipeline. Model on `packages/cli/test/byid-diff-e2e.test.ts` (the 2a E2E) — reuse its `recordingTransport` (with `stripConnect`/`corruptFirstDiffChecksum`), `waitFor`, `anyMod`, `startNotesServer` idioms.

- [ ] **Step 1: Write the E2E test**

`packages/cli/test/range-diff-e2e.test.ts` — schema `items: { channelId: string, n: number }` index `by_channel:["channelId"]`; modules: `add({channelId,n})→insert`, `setN({id,n})→replace`, `del({id})→delete`, `list({channelId})→ q.eq("channelId",channelId).collect()`, and `listGt({channelId})→ q.eq("channelId",channelId).where("gt","n",0).collect()`. Assertions (each through a real `StackbaseClient` over a real WebSocket to a real `startDevServer`):

1. Seed two rows in channel "c" (via `add`). Subscribe to `list({channelId:"c"})`. Wait for the first frame. Assert it renders an ordered 2-element array AND `recorded.inbound` contains a `QueryDiff` with `reset.mode === "range"` — NOT a `QueryUpdated`.
2. `add` a third row → wait for the composed array to include it; assert the carrying Transition contains a `QueryDiff` (incremental `add`), and the array is correctly ordered.
3. `setN` an existing row (in-place edit) → the array updates in place via a `QueryDiff` edit.
4. `del` a row → it disappears via a `QueryDiff` remove.
5. **Filter exclusion:** subscribe to `listGt` (only `n>0`); `add` a row with `n = 0` in the same channel → assert the client array does NOT include it AND (if a Transition fired for the sub at all) it carried no `add` for that id.
6. **Self-heal:** with `corruptFirstDiffChecksum`, subscribe to `list` → assert a resync `ModifyQuerySet` is sent and the array recovers correctly (reuse the 2a scenario-3 shape).
7. **Old-client back-compat:** with `stripConnect`, subscribe to `list` → assert `QueryUpdated` (full array), never `QueryDiff`.

- [ ] **Step 2: Build + run**

Run: `bun run build && bunx vitest run --dir packages/cli/test range-diff-e2e`
Expected: PASS (all 7 assertions).

- [ ] **Step 3: Commit**

```bash
git add packages/cli/test/range-diff-e2e.test.ts
git commit -m "test(cli): range QueryDiff round-trip E2E through the real dev server (DLR 2b Task 8)"
```

---

### Task 9: The benchmark acceptance gate

Unlike 2a, 2b's gate IS a measured wire-byte collapse. Confirm `diffbytes-scan` drops and nothing regressed.

**Files:** none (measurement + a result note).

- [ ] **Step 1: Baseline the branch-point**

Run `bun run bench:reactive` on `main` (the 2b branch-point) once to capture the pre-2b `diffbytes-scan` bytesPerUpdate (≈2647 B) — OR reuse the committed 2b spec's cited number as the reference. Record it.

- [ ] **Step 2: Run the candidate bench on the branch tip**

Run: `bun run bench:reactive`
Expected: `diffbytes-scan` `bytesPerUpdate` collapses to roughly one row's worth (a single-row diff frame, ~130-260 B), while `diffbytes-point` (by-id, 2a), `fanout-selective-*`, `fanout-broadcast-*`, and `propagation-*` are unchanged within noise.

- [ ] **Step 3: Confirm no regression + write the note**

Compare candidate vs baseline (`bun run bench:compare <baseline.json> <candidate.json>` if a baseline file is available, else read the absolute numbers). Assert: `diffbytes-scan` down sharply; every other reactive scenario within ±3%. Record the measured before/after in the PR/commit body.

- [ ] **Step 4: Full-suite gate**

Run: `bun run build && bun run typecheck && bun run test` → all green (client, sync, executor, cli E2E, and the 2a suites unchanged).

- [ ] **Step 5: Commit the measurement note**

```bash
git commit --allow-empty -m "chore(bench): DLR 2b gate — diffbytes-scan bytesPerUpdate collapse recorded (before→after)"
```

---

## Self-Review

**Spec coverage:**
- §1 classification (DIFFABLE_RANGE + passthrough guard) → Tasks 3 (executor passthrough) + 4 (RangeRead on sub). ✅
- §2 range differ (result-set map oracle, extractIndexKey, engine filter evaluator, add/edit/remove/move) → Task 5. ✅
- §3 orderKey on Change → Task 2. ✅
- §4 wire (`reset {mode,orderDir}`) + client render → Tasks 6 (protocol/handler) + 7 (client). ✅
- §4.5 checksum folds orderKey → Task 2. ✅
- §5 correctness (oracle, classifier tests, E2E, self-heal, old-client) → Tasks 5 (oracle) + 3/4 (classifier) + 8 (E2E). ✅
- §6 benchmark gate → Task 9. ✅
- §7 risks: passthrough (Task 3), read-set shape (Task 1 verifies), filter-evaluator reuse (Task 5 imports `evaluateFilter`), move+checksum (Tasks 2+5), order-direction delivery (Tasks 6+7), result-set-map size (reuses `byIdRowMap`, dropped on unsubscribe — Task 6), fleet fallback (Task 6). ✅
- **Read-policy wrinkle** (discovered during planning — `handleDbQuery` merges authz predicates into filters): handled by `hadReadPolicy → RERUN` in Task 3. ✅

**Placeholder scan:** The two "confirm during implementation" notes (Task 5 id-tiebreak encoding; Task 6 writtenDocs→table match key) are deliberate verification pointers with a concrete fallback + a test that catches a wrong choice (the oracle for the tiebreak; the handler test for the table match), NOT vague hand-waving. Task 1 exists precisely to resolve the one genuine unknown (read-set shape) before it's depended on.

**Type consistency:** `DiffableRange` (executor) ≡ `RangeRead` (sync) by shape, bridged by `rangeReadFromDiffable` (Task 4). `orderKey` optional on `Change`/`RowVersion` everywhere (Task 2), consumed by `orderKeyFor`/`renderRangeValue` (Tasks 5/7). `reset: {mode, orderDir}` on `QueryDiff` (Task 6) consumed by `applyDiff` (Task 7). `byIdRowMap` reused verbatim for range subs (holds `Map<docId, RowVersion>` either way).

**Discovered pre-existing gap (out of scope, noted not fixed):** 2a's by-id classifier (`classifyByIdRead`) does NOT verify the returned object is the UNMODIFIED stored doc — a transforming by-id handler (`return {...doc, extra}`) would be silently mis-diffed, exactly the hazard Task 3's passthrough guard closes for range. Fixing by-id analogously is a small follow-up, NOT part of 2b (keeps this slice focused; the range path is correct).
