# DLR Stage 2c — Key-Range-Pinned Pagination Differ Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a `.paginate()` query's page receive incremental `QueryDiff`s instead of a full re-send, by pinning the page's `[startBound, endBound)` key interval after the initial load and reactively diffing it as a fixed two-sided-bound `DIFFABLE` query — reusing 2b's `rangeChangesFor` verbatim.

**Architecture:** The `db.paginate` syscall records a paginate trace (bounds + fixed cursor/hasMore metadata + an identity token) and the guest brands the returned `PaginationResult` object; the executor classifies the run `DIFFABLE_PAGE` iff it's a single unmodified passthrough paginate; the sync tier records it as a `RangeRead` (two-sided bounds) plus a small `pageMeta`; the existing range CommitDiffer produces add/edit/remove/move over the pinned bounds with zero store reads; the client renders `{ page: <sorted rows>, nextCursor, hasMore, scanCapped }`. Everything else stays on 2a/2b/RERUN.

**Tech Stack:** TypeScript, vitest, Bun. Packages: `@stackbase/executor` (paginate trace + `DiffablePage` classification), `@stackbase/query-engine` (paginate — read), `@stackbase/sync` (page metadata on the sub, the reset wire variant, the differ reuse), `@stackbase/client` (page render mode), `@stackbase/cli` (E2E), `@stackbase/bench` (gate).

## Global Constraints

- **Reuse, do not reimplement.** The row differ is 2b's `rangeChangesFor`/`rangeResetChanges` (`packages/sync/src/commit-differ.ts`) — a page is a `RangeRead` whose `bounds` (a `SerializedKeyRange`) has a real `start` AND `end`. Do NOT write a new differ.
- **Pin bounds; metadata is fixed.** After the initial load, `nextCursor`/`hasMore`/`scanCapped` never change for the life of the pinned page (the boundary is a fixed key). Only `.page` rows diff. Incremental `QueryDiff`s carry rows only; the `page` reset carries the metadata.
- **Passthrough by IDENTITY.** Reuse 2b's `COLLECT_BRAND` mechanism on the `PaginationResult` OBJECT. Any transform (`{...result}`, `result.page`, a mapped page) → RERUN. Content equality is NOT used.
- **Differ uses PAGE bounds, not the read-set.** The recorded read-set peeks one row past `endBound`; the diff must bound on the page's `endBound`, so a write at the peek row correctly no-ops. (§7 risk in the spec.)
- **`.take()`/limit, read policy, multi-read, post-processed → RERUN** (inherited from 2b's guard).
- **RERUN is the untouched oracle;** 2a by-id, 2b range, and the RERUN path are behaviorally unchanged.
- **No `Math.random`** in production code.

---

### Task 1: Paginate trace + brand the `PaginationResult` (kernel + guest)

**Files:**
- Modify: `packages/executor/src/kernel.ts` (`handleDbPaginate` — record a `PaginateTrace`, echo a token)
- Modify: `packages/executor/src/guest.ts` (`QueryBuilder.paginate` — brand the returned object)
- Test: `packages/executor/test/paginate-trace.test.ts` (create — a characterization-style test)

**Interfaces:**
- Consumes: the existing `CollectTrace`/`COLLECT_BRAND`/`nextCollectToken` machinery (kernel.ts) and `handleDbPaginate`.
- Produces: `PaginateTrace` (exported from `@stackbase/executor`): `{ keyspace: string; startBound: /* base64 */ string; endBound: string | null; filters: FilterExpr[]; order: "asc"|"desc"; fields: string[]; hadReadPolicy: boolean; token: string; nextCursor: string | null; hasMore: boolean; scanCapped: boolean }`. A `ctx.paginateTrace?: PaginateTrace[]` on `KernelContext` (parallel to `collectTrace`). The guest's `paginate()` returns the same `{ page, nextCursor, hasMore, scanCapped }` shape, now with the OBJECT branded `COLLECT_BRAND → token`.

- [ ] **Step 1: Write the test**

`packages/executor/test/paginate-trace.test.ts` — copy the executor harness idiom from `packages/executor/test/diffable-range.test.ts`. Seed a channel with 5 rows; define a query `page = ctx.db.query("items","by_channel").eq("channelId", c).paginate({ pageSize: 3 })`. Assert (a) the returned value is `{ page: [3 rows], nextCursor: <non-null>, hasMore: true, scanCapped: false }`, and (b) — via a second query that returns the paginate result — that the result object carries the `COLLECT_BRAND` symbol with a string token (read it: `(value as any)[COLLECT_BRAND]`). Also assert a LAST page (`pageSize: 10`) has `hasMore: false, nextCursor: null`.

- [ ] **Step 2: Run to verify it fails**

Run: `bun run --filter @stackbase/executor test paginate-trace`
Expected: FAIL — the paginate result carries no brand; no `PaginateTrace`.

- [ ] **Step 3: Implement the trace + brand**

In `packages/executor/src/kernel.ts`, add `PaginateTrace` (exported) and `readonly paginateTrace?: PaginateTrace[]` on `KernelContext`. In `handleDbPaginate` (currently ~line 624): after `queryRuntime.paginate(...)` returns `{ page, nextCursor, hasMore, scanCapped, readSet }`:
  - Compute the SCAN interval this paginate used (the same `interval` the query-engine resolved from `range`+`cursor`) so you can capture `startBound`/`endBound`. `startBound` = the interval's start; `endBound` = `nextCursor` (the last-included row's key, base64) when `hasMore`/there is a next page, else `null` (last page → the page runs to the base interval end). If `db.paginate`'s current return doesn't surface the resolved interval start, thread it out of `queryRuntime.paginate` alongside `readSet` (add a `scanStart: string /* base64 */` to `PaginatedResult`, or derive it from the `readSet`'s single `index:` range start — the read-set's start IS the interval start). Prefer deriving `startBound` from the recorded `readSet` range's `start` (already available) to avoid changing the query-engine return.
  - Mint a token (reuse `nextCollectToken()`), gated `ctx.paginateTrace ? … : undefined` (armed only for a top-level query run, exactly like `collectToken`).
  - Push a `PaginateTrace` with `{ keyspace, startBound, endBound, filters: spec.filters mapped like handleDbQuery, order: spec.order, fields: indexSpec.fields, hadReadPolicy, token, nextCursor, hasMore, scanCapped }`.
  - Return the token in the JSON so the guest can brand: `JSON.stringify({ page: …, nextCursor, hasMore, scanCapped, __brandToken: token })`.

In `packages/executor/src/guest.ts` `QueryBuilder.paginate` (~line 85): parse `__brandToken` out of the response; build the result object `{ page, nextCursor, hasMore, scanCapped }` and, if a token was returned, `Object.defineProperty(result, COLLECT_BRAND, { value: token, enumerable: false, configurable: true })` (mirror the `collect()` brand at guest.ts:80). Return the branded object. Do NOT include `__brandToken` in the returned object.

> **Read-policy note:** like `handleDbQuery`, capture `hadReadPolicy` and record the USER filters (`spec.filters`), pre-policy-merge. If a read policy applies, `hadReadPolicy: true` → the executor declines diffability (Task 2).

- [ ] **Step 4: Run to green + full package**

Run: `bun run --filter @stackbase/executor test paginate-trace` → PASS. `bun run --filter @stackbase/executor test` → PASS (nothing else regressed; the `__brandToken` is stripped so existing paginate callers are unaffected).

- [ ] **Step 5: Commit**

```bash
git add packages/executor/src/kernel.ts packages/executor/src/guest.ts packages/executor/test/paginate-trace.test.ts
git commit -m "feat(executor): paginate trace + brand the PaginationResult object (DLR 2c)"
```

---

### Task 2: `DIFFABLE_PAGE` classification (executor)

**Files:**
- Modify: `packages/executor/src/executor.ts` (`DiffablePage` type + `classifyDiffablePage`; surface `diffablePage` on `UdfResult`; init `kctx.paginateTrace`)
- Modify: `packages/executor/src/index.ts` (export `DiffablePage`, `PaginateTrace`)
- Modify: `packages/sync/src/handler.ts` (extend `SyncUdfExecutor.runQuery`/`runAdminQuery`/`execSub` return with `diffablePage?`)
- Test: `packages/executor/test/diffable-page.test.ts` (create)

**Interfaces:**
- Produces: `DiffablePage = DiffableRange & { pageMeta: { nextCursor: string | null; hasMore: boolean; scanCapped: boolean } }` (i.e. `{ keyspace, bounds, filters, order, fields, pageMeta }`, where `bounds` is the two-sided `[startBound, endBound)` `SerializedKeyRange`). `UdfResult.diffablePage?: DiffablePage`. `runQuery`/`runAdminQuery`/`execSub` return gains `diffablePage?`.

- [ ] **Step 1: Write the failing test**

`packages/executor/test/diffable-page.test.ts` — mirror `diffable-range.test.ts`. Queries: `page` = `q.eq("channelId",c).paginate({pageSize:3})` (passthrough); `pageMapped` = `(await q...paginate({pageSize:3})).page` (returns just the array — NOT the branded object → RERUN); `pageSpread` = `{...await q...paginate(...)}` (unbranded copy → RERUN); `pageLimited` — n/a (paginate has no `.take`); `pageFiltered` = `q.eq(...).where("gt","n",1).paginate({pageSize:3})` (passthrough + filter). Assert:
```ts
it("a pure passthrough paginate is DIFFABLE_PAGE with two-sided bounds + fixed metadata", async () => {
  const r = await runQuery("items:page", { channelId: "c" });
  expect(r.diffablePage).toBeDefined();
  expect(r.diffablePage!.bounds.end).not.toBeNull();               // pinned end (there's a next page)
  expect(r.diffablePage!.pageMeta.hasMore).toBe(true);
  expect(typeof r.diffablePage!.pageMeta.nextCursor).toBe("string");
});
it("a filtered passthrough paginate carries the filters", async () => {
  expect((await runQuery("items:pageFiltered",{channelId:"c"})).diffablePage!.filters.length).toBe(1);
});
it("a post-processed paginate (.page / spread) is NOT diffable", async () => {
  expect((await runQuery("items:pageMapped",{channelId:"c"})).diffablePage).toBeUndefined();
  expect((await runQuery("items:pageSpread",{channelId:"c"})).diffablePage).toBeUndefined();
});
it("a collect (2b range) is NOT a page (diffablePage undefined, diffableRange defined)", async () => {
  const r = await runQuery("items:list",{channelId:"c"});          // a .collect()
  expect(r.diffablePage).toBeUndefined();
  expect(r.diffableRange).toBeDefined();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run --filter @stackbase/executor test diffable-page` → FAIL.

- [ ] **Step 3: Implement `classifyDiffablePage`**

In `packages/executor/src/executor.ts`, add (modeled EXACTLY on `classifyDiffableRange`, executor.ts:318):
```ts
export interface DiffablePage {
  keyspace: string;
  bounds: SerializedKeyRange;      // [startBound, endBound) — two-sided
  filters: FilterExpr[];
  order: "asc" | "desc";
  fields: string[];
  pageMeta: { nextCursor: string | null; hasMore: boolean; scanCapped: boolean };
}
function classifyDiffablePage(value: unknown, trace: readonly PaginateTrace[], readRanges: readonly KeyRange[]): DiffablePage | undefined {
  if (trace.length !== 1) return undefined;
  const t = trace[0]!;
  if (t.hadReadPolicy) return undefined;
  // exactly one index-range read (the paginate's own scan), no other read syscall:
  if (readRanges.length !== 1 || readRanges[0]!.keyspace !== t.keyspace) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined; // a PaginationResult object
  if ((value as Record<PropertyKey, unknown>)[COLLECT_BRAND] !== t.token) return undefined;   // identity brand
  const bounds: SerializedKeyRange = { keyspace: t.keyspace, start: t.startBound, end: t.endBound };
  return { keyspace: t.keyspace, bounds, filters: t.filters, order: t.order, fields: t.fields,
           pageMeta: { nextCursor: t.nextCursor, hasMore: t.hasMore, scanCapped: t.scanCapped } };
}
```
Init `kctx.paginateTrace = []` alongside `kctx.collectTrace = []` on the query path (find where `collectTrace` is initialized — it's on the query `invoke` path, gated `fn.type === "query"`). After the handler returns, compute `diffablePage: classifyDiffablePage(value, kctx.paginateTrace ?? [], readRanges)` and add it to the returned `UdfResult`. A run that produced a `diffableRange` (a collect) has an empty `paginateTrace` and vice-versa, so the two are mutually exclusive by construction. Export `DiffablePage` + `PaginateTrace` from `index.ts`. Thread `diffablePage?` through `SyncUdfExecutor.runQuery`/`runAdminQuery`/`execSub` in `packages/sync/src/handler.ts` (type-only, no behavior).

> **`SerializedKeyRange.end` type:** confirm `end` accepts a base64 string OR `null` (a last-page/open end). `deserializeKeyRange` already handles `end === null` as +∞ — verify and rely on it.

- [ ] **Step 4: Run to green + full package + sync typecheck**

Run: `bun run --filter @stackbase/executor test diffable-page` → PASS; `bun run --filter @stackbase/executor test` → PASS; `bun run typecheck --filter @stackbase/sync --filter @stackbase/executor` → clean.

- [ ] **Step 5: Commit**

```bash
git add packages/executor/src/executor.ts packages/executor/src/index.ts packages/sync/src/handler.ts packages/executor/test/diffable-page.test.ts
git commit -m "feat(executor): classify DIFFABLE_PAGE (paginate passthrough, two-sided bounds + fixed metadata) (DLR 2c)"
```

---

### Task 3: Record the page on the Subscription (`pageMeta`) + forward from the runtime

**Files:**
- Modify: `packages/sync/src/classify.ts` (a `pageReadFromDiffable` adapter + a `PageMeta` type; `RangeRead` gains an optional `pageMeta?`)
- Modify: `packages/sync/src/subscription-manager.ts` (`Subscription.range` already exists; it now may carry `pageMeta`)
- Modify: `packages/runtime-embedded/src/runtime.ts` (forward `diffablePage` from `syncExecutor.runQuery`/`runAdminQuery` — the same seam that dropped `diffableRange` in 2b Task 8)
- Test: `packages/sync/test/classify.test.ts` (extend)

**Interfaces:**
- Produces: `RangeRead` gains `pageMeta?: { nextCursor: string | null; hasMore: boolean; scanCapped: boolean }` (present iff this range is a page). `pageReadFromDiffable(d: DiffablePage): RangeRead` returns a `RangeRead` with the two-sided bounds + `pageMeta`.

- [ ] **Step 1: Write the failing test**

Extend `packages/sync/test/classify.test.ts`:
```ts
import { pageReadFromDiffable } from "../src/classify";
it("adapts a DiffablePage into a RangeRead carrying pageMeta", () => {
  const d = { keyspace:"index:9001:by_channel", bounds:{keyspace:"index:9001:by_channel",start:"AA",end:"AB"}, filters:[], order:"asc" as const, fields:["channelId"], pageMeta:{nextCursor:"AB",hasMore:true,scanCapped:false} };
  const r = pageReadFromDiffable(d);
  expect(r.bounds).toEqual(d.bounds);
  expect(r.pageMeta).toEqual(d.pageMeta);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run --filter @stackbase/sync test classify` → FAIL.

- [ ] **Step 3: Implement**

In `packages/sync/src/classify.ts`: add `pageMeta?: PageMeta` (define `PageMeta`) to the `RangeRead` interface, and `export function pageReadFromDiffable(d: RangeRead & { pageMeta: PageMeta }): RangeRead { return { keyspace: d.keyspace, bounds: d.bounds, filters: d.filters, order: d.order, fields: d.fields, pageMeta: d.pageMeta }; }`. (Structurally `DiffablePage` ≡ `RangeRead & {pageMeta}`.) No change needed in `subscription-manager.ts` (`range?: RangeRead` already carries it).

In `packages/runtime-embedded/src/runtime.ts`, in BOTH `syncExecutor.runQuery` and `runAdminQuery` returns, forward the field next to the 2b `diffableRange` forward: `...(r.diffablePage ? { diffablePage: r.diffablePage } : {})`. **This is the seam that made 2b unreachable in prod (Task 8) — do not omit it; the E2E (Task 6) is the proof.**

- [ ] **Step 4: Run to green**

Run: `bun run --filter @stackbase/sync test classify` → PASS; `bun run --filter @stackbase/sync test` → PASS; `bun run --filter @stackbase/runtime-embedded test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sync/src/classify.ts packages/runtime-embedded/src/runtime.ts packages/sync/test/classify.test.ts
git commit -m "feat(sync,runtime): RangeRead.pageMeta + forward diffablePage from the embedded runtime (DLR 2c)"
```

---

### Task 4: `page` reset wire variant + server page arm (handler)

**Files:**
- Modify: `packages/sync/src/protocol.ts` (`QueryDiff.reset` gains the `page` variant)
- Modify: `packages/sync/src/handler.ts` (`doModifyQuerySet` + `handleSetAuth`: classify a page sub via `execSub().diffablePage`, emit a `page` reset; the `doNotifyWrites` range arm already diffs it)
- Test: `packages/sync/test/commit-differ-handler.test.ts` (extend with a page scenario)

**Interfaces:**
- Consumes: `pageReadFromDiffable` (Task 3), `execSub().diffablePage`, the existing `rangeResetChanges`/`rangeChangesFor`.
- Produces: a `QueryDiff` whose reset is `{ mode: "page"; orderDir; nextCursor; hasMore; scanCapped }`; incremental page diffs are row-only (the existing range invalidation arm, unchanged).

- [ ] **Step 1: Extend the protocol**

In `packages/sync/src/protocol.ts`, extend the `QueryDiff.reset` union (currently `true | { mode:"byid" } | { mode:"range"; orderDir }` per 2b) with:
```ts
| { mode: "page"; orderDir: "asc" | "desc"; nextCursor: string | null; hasMore: boolean; scanCapped: boolean }
```

- [ ] **Step 2: Write the failing handler test**

Extend `packages/sync/test/commit-differ-handler.test.ts` with a page scenario mirroring the range one: a fake executor whose `runQuery` returns `{ value: { page:[doc1,doc2], nextCursor:"X", hasMore:true, scanCapped:false }, tables, readRanges:[indexRange], diffablePage:{...bounds two-sided..., pageMeta:{nextCursor:"X",hasMore:true,scanCapped:false}} }`. Subscribe → assert a `QueryDiff` with `reset.mode==="page"`, `reset.nextCursor==="X"`, `reset.hasMore===true`, and an ordered add-all of the page rows (checksum = `driftChecksum` of the built map). Then an invalidation with a `writtenDocs` add IN the page bounds → assert an incremental `QueryDiff` with a single `add` (row-only, no `reset`). Then a `writtenDocs` add OUTSIDE the bounds → assert NO change (empty diff).

- [ ] **Step 3: Run to verify it fails**

Run: `bun run --filter @stackbase/sync test commit-differ-handler` → FAIL.

- [ ] **Step 4: Implement the page reset arm**

In `handler.ts` `doModifyQuerySet`: after computing `byId` and `range` (from `diffableRange`), also compute `const page = diffablePage ? pageReadFromDiffable(diffablePage) : undefined;` and prefer it: record `range = page ?? range` on the sub (a page IS a range for `doNotifyWrites`), and branch the reset:
```ts
if (page && session.supportsQueryDiff) {
  const orderedRows = (value as { page: JSONValue[] }).page;   // passthrough guarantees value.page IS the ordered page
  const { changes, next } = rangeResetChanges(page, orderedRows, session.version.ts);
  this.byIdRowMap.set(subKey(session.sessionId, q.queryId), next);
  modifications.push({ type: "QueryDiff", queryId: q.queryId, changes, checksum: driftChecksum(next),
    reset: { mode: "page", orderDir: page.order, nextCursor: page.pageMeta!.nextCursor, hasMore: page.pageMeta!.hasMore, scanCapped: page.pageMeta!.scanCapped },
    hash: hashValue(convexToJson(value)) });     // resume fingerprint over the whole PaginationResult
} else if (range && session.supportsQueryDiff) { /* ...existing 2b range arm... */ }
else if (byId && ...) { /* ...2a... */ } else { /* ...RERUN... */ }
```
The `doNotifyWrites` INVALIDATION arm needs NO change: `sub.range` is truthy for a page (with two-sided bounds), so the existing range branch (`rangeChangesFor(sub.range, prevMap, wds)`) already produces the row diff — its `inBounds` uses `sub.range.bounds` (the PAGE bounds), which is exactly right (the read-set-wider-than-bounds caveat is handled because the differ bounds, not the read-set, gate membership).
**`handleSetAuth`:** mirror the range refresh — recompute `page`/`range` from the fresh `execSub().diffablePage`/`diffableRange` and thread it into `subscriptions.add({...sub, range})` (2b Task 6's SetAuth fix already refreshes `range`; ensure it now also picks up a page's fresh `diffablePage`).

> **Resume `hash`:** carry `hash` on the page reset (like the 2b range reset) so `QueryUnchanged` resume works over the full `PaginationResult`. The client stores it (Task 5 reuses 2b's lastHash-on-reset).

- [ ] **Step 5: Run to green + full package**

Run: `bun run --filter @stackbase/sync test commit-differ-handler` → PASS; `bun run --filter @stackbase/sync test` → PASS (2a/2b handler tests unchanged).

- [ ] **Step 6: Commit**

```bash
git add packages/sync/src/handler.ts packages/sync/src/protocol.ts packages/sync/test/commit-differ-handler.test.ts
git commit -m "feat(sync): emit a page QueryDiff reset {mode:page,cursor,hasMore}; reuse the range differ for invalidation (DLR 2c)"
```

---

### Task 5: Client `page` render mode (`renderPageValue`)

**Files:**
- Modify: `packages/client/src/layered-store.ts` (`renderPageValue` + a `"page"` render mode + `pageMeta` on the Subscription; `applyDiff` dispatch)
- Modify: `packages/client/src/reconcile.ts` (pass the `page` reset descriptor through — it already forwards `mod.reset`)
- Test: `packages/client/test/materialized-cache.test.ts` (extend)

**Interfaces:**
- Consumes: `applyChanges`/`Change`/`RowVersion`, `compareKeyBytes`/`base64ToBytes` (already imported for 2b's `renderRangeValue`).
- Produces: `Subscription.renderMode` gains `"page"`; `Subscription.pageMeta?: { nextCursor; hasMore; scanCapped }`; `applyDiff` renders `{ page: <sorted rows>, nextCursor, hasMore, scanCapped }` in page mode.

- [ ] **Step 1: Write the failing test**

Extend `packages/client/test/materialized-cache.test.ts` (mirror the range tests):
```ts
it("a page reset renders { page: sorted rows, nextCursor, hasMore }; add grows it, remove shrinks it", () => {
  const s = new LayeredQueryStore();
  const sub = s.create(1, "items:page", { channelId: "c" }, "h1");
  s.applyDiff(sub, [
    { t:"add", key:"b", row:{_id:"b",n:2}, ts:5, orderKey:"QUJC" },
    { t:"add", key:"a", row:{_id:"a",n:1}, ts:5, orderKey:"QUFB" },
  ], /*checksum*/ ck2(...), { mode:"page", orderDir:"asc", nextCursor:"CUR", hasMore:true, scanCapped:false });
  const v = sub.serverValue as { page: Array<{_id:string}>; nextCursor:string; hasMore:boolean };
  expect(v.page.map(d=>d._id)).toEqual(["a","b"]);
  expect(v.nextCursor).toBe("CUR"); expect(v.hasMore).toBe(true);
  // an in-bounds insert grows the page (row count exceeds the initial size — correct reactive semantics)
  s.applyDiff(sub, [{ t:"add", key:"c", row:{_id:"c",n:3}, ts:6, orderKey:"QUJD" }], ck2(...));
  expect((sub.serverValue as any).page.map((d:any)=>d._id)).toEqual(["a","b","c"]);
  expect((sub.serverValue as any).nextCursor).toBe("CUR");   // metadata fixed across incremental diffs
  const before = sub.serverValue;
  s.applyDiff(sub, [{ t:"remove", key:"a" }], ck2(...));
  expect(sub.serverValue).not.toBe(before);                  // fresh object
  expect((sub.serverValue as any).page.map((d:any)=>d._id)).toEqual(["b","c"]);
});
it("an empty page renders { page: [], ...metadata }", () => {
  const s = new LayeredQueryStore();
  const sub = s.create(1, "items:page", { channelId:"c" }, "h1");
  s.applyDiff(sub, [], driftChecksum(new Map()), { mode:"page", orderDir:"asc", nextCursor:null, hasMore:false, scanCapped:false });
  expect(sub.serverValue).toEqual({ page: [], nextCursor: null, hasMore: false, scanCapped: false });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run build --filter @stackbase/sync --filter @stackbase/client && bun run --filter @stackbase/client test materialized-cache` → FAIL.

- [ ] **Step 3: Implement**

In `packages/client/src/layered-store.ts`: add `"page"` to the `renderMode` union and `pageMeta?: { nextCursor: string | null; hasMore: boolean; scanCapped: boolean }` to `Subscription`. Add:
```ts
function renderPageValue(rows: Map<string, RowVersion>, orderDir: "asc"|"desc", meta: { nextCursor: string|null; hasMore: boolean; scanCapped: boolean }): Value {
  return { page: renderRangeValue(rows, orderDir), nextCursor: meta.nextCursor, hasMore: meta.hasMore, scanCapped: meta.scanCapped } as Value; // fresh object each apply
}
```
In `applyDiff`, when a reset descriptor is an object with `mode === "page"`, set `sub.renderMode = "page"`, `sub.orderDir = reset.orderDir`, `sub.pageMeta = { nextCursor: reset.nextCursor, hasMore: reset.hasMore, scanCapped: reset.scanCapped }`. In the render dispatch, add `sub.renderMode === "page" ? renderPageValue(next, sub.orderDir ?? "asc", sub.pageMeta!) : ...`. The `reset === undefined` (incremental) path keeps `renderMode`/`pageMeta` as-is (metadata fixed). Clear-on-reset (2b) already applies. `reconcile.ts` already passes `mod.reset` into `applyDiff` — no change beyond confirming the `page` variant flows through.

- [ ] **Step 4: Run to green + full client suite**

Run: `bun run build --filter @stackbase/client && bun run --filter @stackbase/client test` → PASS (2a/2b materialized-cache tests unchanged; by-id/range have no `page` reset).

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/layered-store.ts packages/client/src/reconcile.ts packages/client/test/materialized-cache.test.ts
git commit -m "feat(client): page render mode — { page, nextCursor, hasMore } from a sorted row-map (DLR 2c)"
```

---

### Task 6: The server differential oracle for the page (sync)

**Files:**
- Test: `packages/sync/test/page-differ-oracle.test.ts` (create)

**Interfaces:**
- Consumes: `rangeResetChanges`/`rangeChangesFor` + `pageReadFromDiffable` output (a `RangeRead` with two-sided bounds).

- [ ] **Step 1: Write the oracle**

`packages/sync/test/page-differ-oracle.test.ts` — model on `packages/sync/test/range-differ-oracle.test.ts` (2b's oracle) but with a `RangeRead` whose `bounds` are TWO-SIDED (a `start` AND a real `end`, i.e. a pinned page interval), and an optional `.where` filter. A deterministic (seeded, NO `Math.random`) loop applies random ops — insert IN bounds / insert OUT of bounds (must no-op) / update-in-place / update-move-within / update-that-crosses-a-bound / update-filter-cross / delete — builds the `WrittenDoc`, runs `rangeChangesFor(pageRange, prevMap, [wd])`, and asserts:
```ts
// sort(applyChanges(prevMap, changes))  ===  oracleResult(currentDocs, pageRange)
// where oracleResult = docs filtered by .where AND within [start,end), sorted by orderKey
```
Run ~500 iterations × a few seeds. This proves the page differ (2b's `rangeChangesFor` over two-sided bounds) is correct across the boundary-crossing and out-of-bounds cases specific to a pinned page.

- [ ] **Step 2: Run to green**

Run: `bun run --filter @stackbase/sync test page-differ-oracle` → PASS (~500×seeds).

- [ ] **Step 3: Commit**

```bash
git add packages/sync/test/page-differ-oracle.test.ts
git commit -m "test(sync): page differential oracle — two-sided-bound diff+apply ≡ re-run (DLR 2c)"
```

---

### Task 7: E2E — page `QueryDiff` round-trip through the real dev server

**Files:**
- Test: `packages/cli/test/page-diff-e2e.test.ts` (create)

**Interfaces:**
- Consumes: the whole pipeline. Model on `packages/cli/test/range-diff-e2e.test.ts` (2b E2E) — reuse its `recordingTransport` (`stripConnect`/`corruptFirstDiffChecksum`), `waitFor`, `anyMod`, dev-server setup.

- [ ] **Step 1: Write the E2E**

`packages/cli/test/page-diff-e2e.test.ts` — schema `items: { channelId, n }` index `by_channel:["channelId"]`; modules: `add`/`setN`/`del` (as range-diff-e2e), and `page({channelId}) → q.eq("channelId",channelId).paginate({ pageSize: 3 })` (returned unmodified). Assertions through a real `StackbaseClient`/WebSocket/`startDevServer`:
1. Seed 3 rows; subscribe to `page({channelId:"c"})`; first frame renders `{ page: [3 ordered rows], nextCursor: <string>, hasMore: false|true, scanCapped:false }` AND the inbound stream has a `QueryDiff` with `reset.mode==="page"` — NOT `QueryUpdated`.
2. `add` a 4th row whose key falls IN the pinned page bounds (e.g. same channel, a body/n that sorts inside `[start, endBound)`) → the page GROWS to 4 rows via an incremental `QueryDiff` add; `nextCursor`/`hasMore` UNCHANGED.
3. `setN` an in-page row → updates in place via a `QueryDiff` edit.
4. `del` an in-page row → the page SHRINKS via a `QueryDiff` remove.
5. **Out-of-bounds:** `add` a row whose key sorts BEYOND `endBound` (belongs to page 2) → the client page does NOT change (no spurious add).
6. **Self-heal:** with `corruptFirstDiffChecksum`, subscribe `page` → a resync `ModifyQuerySet` is sent and the page recovers.
7. **Old-client:** with `stripConnect`, subscribe `page` → `QueryUpdated` (full `PaginationResult`), never `QueryDiff`.

> To make assertions 2 and 5 deterministic, seed rows and choose the inserted row's sort position relative to the page's `endBound` (the 3rd row's key). Since the index is `(channelId, _creationTime, _id)`, a NEW insert lands at the TAIL (newest `_creationTime`) — i.e. BEYOND the 3-row page's `endBound` → that's the OUT-OF-BOUNDS case (assertion 5). For the IN-BOUNDS grow (assertion 2), you need an insert whose key sorts inside `[start, endBound)`; with creation-time ordering that requires either an `order:"desc"` page (new inserts at head, in-bounds) OR a non-time index. **Simplest: make the `page` query `order:"desc"`** so new rows insert at the head (in-bounds, growing page 1) — the canonical live-feed case — and a row far in the past is the out-of-bounds case. Adjust the fixture so both cases are reachable; document the ordering in a comment.

- [ ] **Step 2: Build + run**

Run: `bun run build && bunx vitest run --dir packages/cli/test page-diff-e2e` → PASS (all 7).

- [ ] **Step 3: Commit**

```bash
git add packages/cli/test/page-diff-e2e.test.ts
git commit -m "test(cli): page QueryDiff round-trip E2E through the real dev server (DLR 2c)"
```

---

### Task 8: Benchmark scenario + the acceptance gate

**Files:**
- Modify: `benchmarks/runner/src/cores/fanout.ts` (+ its scenario registry `benchmarks/runner/src/scenarios/reactive.ts`) — add a `diffbytes-paginate` variant
- Measurement note (commit)

**Interfaces:**
- Consumes: the existing `diffbytes-*` bench harness (a page subscription of ~20 rows under a write stream), the wire-frame byte metric shipped in 2b.

- [ ] **Step 1: Add the paginate scenario**

In the reactive bench (`benchmarks/runner/src/cores/fanout.ts` + `scenarios/reactive.ts`), add a `queryCost: "page"` (or a `diffbytes-paginate` scenario) that subscribes to a `.paginate({pageSize:20, order:"desc"})` query over a channel and streams writes at the head (in-bounds inserts). Reuse the wire-frame byte counting (2b's fix) so `bytesPerUpdate` reflects the actual `QueryDiff` frame. Ensure the bench client advertises `supportsQueryDiff` (a plain `StackbaseClient` does) and that the query is DIFFABLE_PAGE (log the frame types once to confirm `QueryDiff`, then remove).

- [ ] **Step 2: Run the gate**

Run: `bun run bench:reactive` — read the written JSON. Confirm **`diffbytes-paginate` `bytesPerUpdate` collapses** to roughly one row's worth (~130–480 B, the `diffbytes-scan` order after 2b), vs a full-page re-send (~2.6 KB) — and that `diffbytes-scan`/`diffbytes-point`/`fanout-*`/`propagation-*` are unchanged within ~±5%.

- [ ] **Step 3: Full-suite gate + measurement note**

Run: `bun run build && bun run typecheck && bun run test` → all green. Record the `diffbytes-paginate` before→after in the commit body.

```bash
git add benchmarks/runner/src/cores/fanout.ts benchmarks/runner/src/scenarios/reactive.ts
git commit -m "feat(bench): diffbytes-paginate scenario — DLR 2c gate (page diff bytesPerUpdate collapse)"
```

---

## Self-Review

**Spec coverage:**
- §1/§4.1 classification (DIFFABLE_PAGE + passthrough brand on the object) → Tasks 1 (trace+brand) + 2 (classify). ✅
- §4.2 differ reuse (rangeChangesFor over two-sided bounds) → Tasks 4 (wiring) + 6 (oracle proves it). ✅
- §4.3 wire (`page` reset variant) → Task 4. ✅
- §4.4 client render (`renderPageValue`, fixed metadata) → Task 5. ✅
- §4.5 resume/checksum/passthrough → reused (hash on page reset in Task 4; brand in Task 1/2). ✅
- §5 correctness (oracle, classifier, client, E2E) → Tasks 6 (oracle) + 2 (classifier) + 5 (client) + 7 (E2E). ✅
- §6 benchmark gate → Task 8. ✅
- §7 risks: unbounded growth (accepted v1 — the client renders whatever rows the map holds); read-set wider than bounds (differ bounds on `sub.range.bounds` = page bounds — Task 4 note); metadata staleness (fixed by design — Tasks 4/5); object-return passthrough (Task 1 brand + Task 2 classify); fleet fallback (Task 3 forward is single-node; forwarded → RERUN). ✅
- **The 2b prod-unreachability lesson** (runtime must forward the new field) → Task 3 explicitly forwards `diffablePage`; Task 7 E2E proves it end-to-end. ✅

**Placeholder scan:** The Task 1 `startBound` derivation ("prefer deriving from the recorded read-set range's start") and the Task 7 ordering choice (`order:"desc"` so in-bounds/out-of-bounds are both reachable) are concrete decisions with a stated fallback + a guarding test, not vague hand-waving.

**Type consistency:** `PaginateTrace` (kernel) → `DiffablePage` (executor, = `DiffableRange & {pageMeta}`) → `RangeRead & {pageMeta}` (sync, via `pageReadFromDiffable`) → `reset:{mode:"page",...}` (protocol) → `renderPageValue` (client). `pageMeta` shape `{nextCursor, hasMore, scanCapped}` is identical at every hop. The differ consumes a `RangeRead` (two-sided `bounds`) — 2b's exact type. `hash` on the page reset reuses 2b's resume field.
