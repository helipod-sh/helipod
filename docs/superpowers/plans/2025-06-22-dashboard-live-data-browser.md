# Dashboard — Live Data Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the data browser live (an admin-authenticated privileged sync subscription to a `_admin:browseTable` query, updating via the shipped range-precise invalidation), with cursor pagination + structured filtering and three load mitigations.

**Architecture:** `paginate` gains a `maxScan` cap threaded through the read stack. The sync handler gains an admin-privileged path: a `SetAdminAuth { key }` message marks a session privileged (verified by an injected `verifyAdmin`), and `_admin:`-prefixed subscriptions run privileged via a new `runAdminQuery`. A `_admin:browseTable` query (registered in the runtime's `adminModules`) reads any full-named table with cursor `paginate` + `FilterCond` filters; the dashboard subscribes to it over the sync WebSocket. The HTTP `getTableData` delegates to the same module via a one-shot `runtime.runAdmin`.

**Tech Stack:** TypeScript, Bun, Turborepo, vitest; React + Vite (`apps/dashboard`), `@tanstack/react-table`, `@stackbase/client` (WS transport). Builds on the shipped reactive engine (read/write-range invalidation), `@stackbase/admin` (`verifyAdminKey`, `/_admin/*`), and the query engine's cursor `paginate`.

## Global Constraints

- **Bun toolchain:** `bun run build`, `bun run typecheck`, `bun run test`; single package `bun run --filter <pkg> test`. Never pnpm/npm.
- **Security boundary (the one invariant):** a `_admin:` subscription runs privileged **iff** the session sent `SetAdminAuth` with a key that `verifyAdmin` accepts. Every other path is unchanged and unprivileged. A non-admin / wrong-key session subscribing to `_admin:*` is REJECTED (a `QueryFailed`, no privileged read).
- **`_admin:` routing must be applied in EVERY place a subscription runs:** initial subscribe, `SetAuth` re-run, AND the invalidation re-run path — factor one `execSub` helper and use it everywhere.
- **Live-ness reuses the shipped engine:** `paginate`'s read-set drives range-precise invalidation. No second reactivity mechanism.
- **Mitigations:** (1) the table LIST / per-table counts stay on-demand HTTP, never subscribed; (2) `maxScan` caps the per-page filter scan (`browseTable`/`getTableData` set `maxScan: 1000`, `pageSize: 50`); returns `scanCapped: true` past the cap; (3) same-node co-location is documented, no code.
- **Additive to `paginate`:** existing callers (kernel `handleDbPaginate`, sync) that pass no `maxScan` behave exactly as before; `scanCapped` is additive to the result.
- **TDD, frequent commits.** Each task ends green (`build`/`typecheck`/`test`) with one commit.
- `noUncheckedIndexedAccess: true`.

---

## File Structure

- `packages/query-engine/src/query-runtime.ts` (**modify**) — `paginate` `maxScan` + `scanCapped`.
- `packages/executor/src/kernel.ts` (**modify**) — `handleDbPaginate` threads `maxScan` in / `scanCapped` out.
- `packages/executor/src/guest.ts` (**modify**) — `QueryBuilder.paginate` `maxScan` opt + `scanCapped` in the return.
- `packages/sync/src/protocol.ts` (**modify**) — `SetAdminAuth` client message.
- `packages/sync/src/handler.ts` (**modify**) — `Session.privileged`, `verifyAdmin`, `handleSetAdminAuth`, `_admin:` routing via an `execSub` helper, `SyncUdfExecutor.runAdminQuery`.
- `packages/runtime-embedded/src/runtime.ts` (**modify**) — `adminModules` + `verifyAdmin` options; `runAdminQuery` in the sync executor; public one-shot `runAdmin`; pass `verifyAdmin` to the handler.
- `packages/admin/src/browse.ts` (**new**) — the `_admin:browseTable` module + `FilterCond` type; `admin-api.ts` `getTableData` delegates to `runtime.runAdmin`.
- `apps/dashboard/src/lib/ws-admin.ts` (**new**) — the WS admin client.
- `apps/dashboard/src/features/data-browser.tsx` + `lib/admin.ts` (**modify**) — live grid, cursor/filter UI, lazy counts.
- `CLAUDE.md` (**modify**) — correct the dashboard status.
- Tests: `packages/query-engine/test`, `packages/executor/test`, `packages/sync/test`, `packages/admin/test`, `apps/dashboard/test` (light).

---

## Task 1: Bounded pagination (`maxScan` / `scanCapped`) through the read stack

**Files:**
- Modify: `packages/query-engine/src/query-runtime.ts`, `packages/executor/src/kernel.ts`, `packages/executor/src/guest.ts`
- Test: `packages/query-engine/test/paginate-maxscan.test.ts`, `packages/executor/test/paginate-cap.test.ts`

**Interfaces:**
- Produces: `paginate(query, ts, { cursor?, pageSize, maxScan? })` → `PaginatedResult & { scanCapped: boolean }`; the guest `QueryBuilder.paginate({ cursor?, pageSize, maxScan? })` → `{ page, nextCursor, hasMore, scanCapped }`.

- [ ] **Step 1: Write the failing test**

Create `packages/query-engine/test/paginate-maxscan.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { QueryRuntime } from "../src/query-runtime";
import { encodeStorageIndexId } from "@stackbase/id-codec";
// (build a table with N rows, then paginate with a filter that matches only the last row and maxScan below N)

describe("paginate maxScan", () => {
  it("stops after maxScan rows and reports scanCapped when the page isn't filled", async () => {
    const store = new SqliteDocStore(new NodeSqliteAdapter());
    await store.setupSchema();
    const qr = new QueryRuntime(store);
    const tableNumber = 7001;
    const index = { tableNumber, index: "by_creation", indexId: encodeStorageIndexId(tableNumber, "by_creation"), fields: [] as string[] };
    // seed 10 rows (via the store's write path used elsewhere in query-engine tests — mirror an existing
    // query-runtime test's seeding helper for this store) with `n: 0..9`; only n===9 matches the filter.
    // (implementer: reuse the seeding approach from packages/query-engine/test/*.test.ts)
    // ... seed ...
    const res = await qr.paginate(
      { index, filters: [{ op: "eq", field: "n", value: 9 }] },
      await store.maxTimestamp(),
      { pageSize: 5, maxScan: 4 },
    );
    expect(res.scanCapped).toBe(true);
    expect(res.page.length).toBeLessThan(5);
    expect(res.hasMore).toBe(true);            // stopped early → may be more
  });

  it("no maxScan → unchanged (full page, scanCapped false)", async () => {
    // seed 3 rows, no filter, pageSize 50 → page has 3, hasMore false, scanCapped false
    // ... reuse seeding ...
  });
});
```

> Implementer: this file needs the same store-seeding helper the existing `packages/query-engine/test/*.test.ts` use (they write docs + index entries through the store). Copy that seeding shape; the assertions above are the contract.

Also create `packages/executor/test/paginate-cap.test.ts` proving the cap threads through `ctx.db.query(...).paginate({ pageSize, maxScan })` (via `InlineUdfExecutor`, mirroring `packages/executor/test/row-policy.test.ts`'s harness): a `query` UDF paginating a seeded table with `maxScan` returns `scanCapped: true`.

- [ ] **Step 2: Run — verify it fails**

Run: `bun run --filter @stackbase/query-engine test paginate-maxscan` and `bun run --filter @stackbase/executor test paginate-cap`
Expected: FAIL — `maxScan`/`scanCapped` unknown.

- [ ] **Step 3: Add `maxScan`/`scanCapped` to `paginate`**

In `packages/query-engine/src/query-runtime.ts`: add `scanCapped: boolean` to `PaginatedResult`; change the `paginate` opts to `{ cursor?: string | null; pageSize: number; maxScan?: number }`; replace the scan loop + return with:

```ts
    const page: DocumentValue[] = [];
    let lastIncluded: Uint8Array | null = null;
    let lastScanned: Uint8Array | null = null;
    let hasMore = false;
    let scanned = 0;
    let scanCapped = false;

    for await (const [key, doc] of this.docStore.index_scan(query.index.indexId, tableId, readTimestamp, interval, order)) {
      lastScanned = key;
      const value = doc.value.value;
      if (filters.every((f) => evaluateFilter(value, f))) {
        if (page.length >= opts.pageSize) { hasMore = true; break; }
        page.push(value);
        lastIncluded = key;
      }
      scanned++;
      if (opts.maxScan !== undefined && scanned >= opts.maxScan) {
        hasMore = true;                       // stopped early — there may be more
        if (page.length < opts.pageSize) scanCapped = true;
        break;
      }
    }

    const readSet = new RangeSet();
    readSet.add(this.consumedRange(query.index, interval, order, lastScanned));
    // When capped, resume past where we STOPPED scanning (lastScanned), not the last returned row.
    const cursorKey = scanCapped ? lastScanned : hasMore ? lastIncluded : null;
    const nextCursor = cursorKey ? bytesToBase64(cursorKey) : null;
    return { page, nextCursor, hasMore, scanCapped, readSet };
```

- [ ] **Step 4: Thread through kernel `handleDbPaginate` (`kernel.ts`)**

The paginate spec JSON already carries `cursor`/`pageSize`. Add `maxScan` to the parsed spec type and pass it through; surface `scanCapped` in the returned JSON. In `handleDbPaginate`:

```ts
  const spec = JSON.parse(argJson) as QuerySpecJson & { cursor: string | null; pageSize: number; maxScan?: number };
  // …build query, apply read policy as today…
  const { page, nextCursor, hasMore, scanCapped, readSet } = await ctx.queryRuntime.paginate(query, ctx.snapshotTs, {
    cursor: spec.cursor, pageSize: spec.pageSize, maxScan: spec.maxScan,
  });
  for (const range of readSet.toArray()) ctx.txn.recordRead(range);
  return JSON.stringify({ page: page.map((d) => convexToJson(d as Value)), nextCursor, hasMore, scanCapped });
```

- [ ] **Step 5: Thread through the guest `QueryBuilder.paginate` (`guest.ts`)**

Change the guest paginate to accept `maxScan` and return `scanCapped`:

```ts
  async paginate(opts: { cursor?: string | null; pageSize: number; maxScan?: number }): Promise<{ page: DocumentValue[]; nextCursor: string | null; hasMore: boolean; scanCapped: boolean }> {
    const res = await this.channel.call("db.paginate", JSON.stringify({ ...JSON.parse(this.serializeQuery()), cursor: opts.cursor ?? null, pageSize: opts.pageSize, maxScan: opts.maxScan }));
    const parsed = JSON.parse(res) as { page: JSONValue[]; nextCursor: string | null; hasMore: boolean; scanCapped: boolean };
    return { page: parsed.page.map((d) => jsonToConvex(d) as DocumentValue), nextCursor: parsed.nextCursor, hasMore: parsed.hasMore, scanCapped: parsed.scanCapped };
  }
```

- [ ] **Step 6: Run — verify it passes**

Run: `bun run --filter @stackbase/query-engine test paginate-maxscan` and `bun run --filter @stackbase/executor test paginate-cap`
Expected: PASS.

- [ ] **Step 7: Whole workspace green + commit**

Run: `bun run build && bun run typecheck && bun run test`
Expected: PASS — existing paginate callers (they pass no `maxScan`) unaffected; `scanCapped` is additive.

```bash
git add packages/query-engine/src/query-runtime.ts packages/executor/src/kernel.ts packages/executor/src/guest.ts packages/query-engine/test/paginate-maxscan.test.ts packages/executor/test/paginate-cap.test.ts
git commit -m "feat(query-engine): paginate maxScan cap + scanCapped, threaded through kernel/guest"
```

---

## Task 2: Admin sync channel (privileged `_admin:` subscriptions)

**Files:**
- Modify: `packages/sync/src/protocol.ts`, `packages/sync/src/handler.ts`
- Test: `packages/sync/test/admin-channel.test.ts`

**Interfaces:**
- Produces: `ClientMessage` gains `{ type: "SetAdminAuth"; key: string }`; `SyncProtocolHandler` constructor option `verifyAdmin?: (key: string) => boolean`; `SyncUdfExecutor` gains `runAdminQuery(udfPath, args): Promise<{ value: Value; tables: string[]; readRanges: readonly SerializedKeyRange[] }>`; `Session` gains `privileged: boolean`; `_admin:`-prefixed subscriptions run privileged only for privileged sessions, else `QueryFailed`.

- [ ] **Step 1: Write the failing test**

Create `packages/sync/test/admin-channel.test.ts` with a fake `SyncUdfExecutor` whose `runAdminQuery` returns a canned value + a recording `runQuery`:

```ts
import { describe, it, expect } from "vitest";
import { SyncProtocolHandler, type SyncUdfExecutor } from "../src/index";

function mkExec(): SyncUdfExecutor & { adminCalls: string[] } {
  const adminCalls: string[] = [];
  return {
    adminCalls,
    async runQuery(path) { return { value: `user:${path}` as never, tables: ["t"], readRanges: [] }; },
    async runMutation() { return { value: null as never, tables: [], writeRanges: [], commitTs: 1 }; },
    async runAdminQuery(path) { adminCalls.push(path); return { value: `admin:${path}` as never, tables: ["t"], readRanges: [] }; },
  };
}
function sock() { const sent: any[] = []; return { sent, send: (d: string) => sent.push(JSON.parse(d)), bufferedAmount: 0, close: () => {} }; }
const mods = (s: { sent: any[] }) => s.sent.flatMap((m) => m.modifications ?? []);

describe("admin sync channel", () => {
  it("a non-admin session subscribing to _admin:* is rejected (QueryFailed), no admin run", async () => {
    const ex = mkExec();
    const h = new SyncProtocolHandler(ex, { verifyAdmin: (k) => k === "SECRET" });
    const s = sock(); h.connect("s1", s as never);
    await h.handleMessage("s1", JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "_admin:browseTable", args: {} }], remove: [] }));
    expect(mods(s).find((m: any) => m.queryId === 1)?.type).toBe("QueryFailed");
    expect(ex.adminCalls).toEqual([]);
  });

  it("after SetAdminAuth with the right key, _admin:* runs privileged", async () => {
    const ex = mkExec();
    const h = new SyncProtocolHandler(ex, { verifyAdmin: (k) => k === "SECRET" });
    const s = sock(); h.connect("s1", s as never);
    await h.handleMessage("s1", JSON.stringify({ type: "SetAdminAuth", key: "SECRET" }));
    await h.handleMessage("s1", JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "_admin:browseTable", args: {} }], remove: [] }));
    expect(ex.adminCalls).toEqual(["_admin:browseTable"]);
    const upd = mods(s).find((m: any) => m.type === "QueryUpdated" && m.queryId === 1);
    expect(upd?.value).toBe("admin:_admin:browseTable");
  });

  it("a wrong key does NOT privilege the session", async () => {
    const ex = mkExec();
    const h = new SyncProtocolHandler(ex, { verifyAdmin: (k) => k === "SECRET" });
    const s = sock(); h.connect("s1", s as never);
    await h.handleMessage("s1", JSON.stringify({ type: "SetAdminAuth", key: "WRONG" }));
    await h.handleMessage("s1", JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "_admin:browseTable", args: {} }], remove: [] }));
    expect(mods(s).find((m: any) => m.queryId === 1)?.type).toBe("QueryFailed");
    expect(ex.adminCalls).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `bun run --filter @stackbase/sync test admin-channel`
Expected: FAIL — `SetAdminAuth`/`runAdminQuery`/`verifyAdmin` unknown; `_admin:` not routed.

- [ ] **Step 3: Add `SetAdminAuth` to the protocol (`protocol.ts`)**

Add to the `ClientMessage` union:

```ts
  | { type: "SetAdminAuth"; key: string }
```

- [ ] **Step 4: Wire the handler (`handler.ts`)**

- Add to `SyncUdfExecutor`:
```ts
  runAdminQuery(udfPath: string, args: JSONValue): Promise<{ value: Value; tables: string[]; readRanges: readonly SerializedKeyRange[] }>;
```
- `Session` gains `privileged: boolean`; in `connect`, set `privileged: false`.
- The constructor options type gains `verifyAdmin?: (key: string) => boolean`; store `this.verifyAdmin = opts.verifyAdmin ?? (() => false)`.
- Add the message case in `handleMessage`: `case "SetAdminAuth": return this.handleSetAdminAuth(session, msg);` and:
```ts
  private async handleSetAdminAuth(session: Session, msg: Extract<ClientMessage, { type: "SetAdminAuth" }>): Promise<void> {
    session.privileged = this.verifyAdmin(msg.key);
    // The client sends SetAdminAuth before subscribing; no re-run needed here.
  }
```
- Factor the per-subscription run into one helper and use it in EVERY place a sub runs (initial subscribe, `SetAuth` re-run, and the invalidation re-run path):
```ts
  /** Run a subscription's query — privileged for _admin:* on a privileged session; else identity-scoped. */
  private async execSub(session: Session, udfPath: string, args: JSONValue): Promise<{ value: Value; tables: string[]; readRanges: readonly SerializedKeyRange[] }> {
    if (udfPath.startsWith("_admin:")) {
      if (!session.privileged) throw new Error("Forbidden: admin subscription requires admin auth");
      return this.executor.runAdminQuery(udfPath, args);
    }
    return this.executor.runQuery(udfPath, args, session.identity);
  }
```
- In `handleModifyQuerySet`, replace the `await this.executor.runQuery(q.udfPath, q.args, session.identity)` call with `await this.execSub(session, q.udfPath, q.args)`, wrapped in try/catch so a thrown `Forbidden` becomes a `QueryFailed` modification for that `queryId` (do not subscribe it).
- In `handleSetAuth`'s re-run loop, replace its `runQuery(...)` with `this.execSub(session, sub.udfPath, sub.args)`.
- In the invalidation re-run path (grep `handler.ts` for the other `executor.runQuery(` — it re-runs intersecting subscriptions on `notifyWrites`), look up the sub's `Session` (by `sub.sessionId`) and run via `execSub(session, sub.udfPath, sub.args)` so an admin sub re-runs privileged. If the session is gone, skip.

> The invalidation re-run currently calls `runQuery(sub.udfPath, sub.args, <identity>)`. It MUST use `execSub` or an `_admin:` subscription would re-run non-privileged on a data change and fail. This is the load-bearing edit for live admin browsing.

- [ ] **Step 5: Run — verify it passes**

Run: `bun run --filter @stackbase/sync test admin-channel`
Expected: PASS (reject without auth; privileged run after correct key; wrong key stays unprivileged).

- [ ] **Step 6: Whole workspace green + commit**

Run: `bun run build && bun run typecheck && bun run test`
Expected: PASS — the `SyncUdfExecutor` interface gained a method; update the runtime's `syncExecutor` object in the NEXT task (it will fail typecheck until Task 3 adds `runAdminQuery`). If typecheck fails ONLY on the runtime's `syncExecutor` missing `runAdminQuery`, add a minimal throwing stub there in this task's commit to keep the workspace green, then flesh it out in Task 3. (Prefer: add the real `runAdminQuery` stub now — `async runAdminQuery() { throw new Error("admin modules not configured"); }` — replaced in Task 3.)

```bash
git add packages/sync/src/protocol.ts packages/sync/src/handler.ts packages/runtime-embedded/src/runtime.ts packages/sync/test/admin-channel.test.ts
git commit -m "feat(sync): admin sync channel — SetAdminAuth + privileged _admin: subscriptions via execSub"
```

---

## Task 3: Runtime `adminModules` + `_admin:browseTable` + `getTableData` delegate (end-to-end)

**Files:**
- Modify: `packages/runtime-embedded/src/runtime.ts`, `packages/admin/src/admin-api.ts`, `packages/admin/src/index.ts`
- Create: `packages/admin/src/browse.ts`
- Test: `packages/admin/test/browse-live.test.ts`

**Interfaces:**
- Consumes: Task 1's guest `paginate({ maxScan })` + `scanCapped`; Task 2's `SyncUdfExecutor.runAdminQuery` + `verifyAdmin`.
- Produces: `EmbeddedRuntimeOptions.adminModules?: Record<string, RegisteredFunction>` + `verifyAdmin?: (key: string) => boolean`; `runtime.runAdmin(path, args): Promise<UdfResult>` (privileged one-shot from `adminModules`); the `browseTable` module + `FilterCond` type; `getTableData` delegates to `runAdmin`.

- [ ] **Step 1: Write the failing test**

Create `packages/admin/test/browse-live.test.ts` — the end-to-end reactive + security proof through the REAL runtime + sync handler:

```ts
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { composeComponents } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { defineSchema, defineTable, v } from "@stackbase/values";
import { mutation, query, type RegisteredFunction } from "@stackbase/executor";
import { browseTableModule } from "../src/browse";

function systemModules(): Record<string, RegisteredFunction> {
  return { "_system:insertDocument": mutation(async (ctx, a: { table: string; fields: Record<string, unknown> }) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ctx.db.insert(a.table, a.fields as any)) };
}

async function makeRuntime() {
  const schema = defineSchema({ notes: defineTable({ body: v.string() }) });
  const c = composeComponents({ schemaJson: schema.export(), moduleMap: {
    "notes:add": mutation(async (ctx, { body }: { body: string }) => ctx.db.insert("notes", { body })),
  } }, []);
  return EmbeddedRuntime.create({
    store: new SqliteDocStore(new NodeSqliteAdapter()), catalog: c.catalog, modules: c.moduleMap,
    systemModules: systemModules(), componentNames: c.componentNames, contextProviders: c.contextProviders,
    policyRegistry: c.policyRegistry, policyProviders: c.policyProviders, relationRegistry: c.relationRegistry, bootSteps: c.bootSteps,
    adminModules: { "_admin:browseTable": browseTableModule }, verifyAdmin: (k) => k === "SECRET",
  });
}

describe("admin live browse", () => {
  it("admin subscription to _admin:browseTable is live; non-admin is rejected", async () => {
    const r = await makeRuntime();
    await r.run("notes:add", { body: "one" });
    const sent: any[] = [];
    const sock = { sent, send: (x: string) => sent.push(JSON.parse(x)), bufferedAmount: 0, close: () => {} };
    const last = (): any => { for (let i = sent.length - 1; i >= 0; i--) for (const m of [...(sent[i]?.modifications ?? [])].reverse()) if (m.queryId === 1) return m; return undefined; };
    r.handler.connect("s1", sock);

    // no admin auth → rejected
    await r.handler.handleMessage("s1", JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "_admin:browseTable", args: { table: "notes" } }], remove: [] }));
    expect(last().type).toBe("QueryFailed");

    // admin auth → live page
    await r.handler.handleMessage("s1", JSON.stringify({ type: "SetAdminAuth", key: "SECRET" }));
    await r.handler.handleMessage("s1", JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "_admin:browseTable", args: { table: "notes" } }], remove: [] }));
    expect(last().value.documents.map((d: any) => d.body)).toEqual(["one"]);

    // a write to the table live-updates the subscription
    await r.run("notes:add", { body: "two" });
    await new Promise((res) => setTimeout(res, 50));
    expect(last().value.documents.map((d: any) => d.body).sort()).toEqual(["one", "two"]);
  });

  it("getTableData delegates to runAdmin (cursor + filter parity)", async () => {
    const r = await makeRuntime();
    await r.run("notes:add", { body: "a" });
    const page = await r.runAdmin("_admin:browseTable", { table: "notes" });
    expect((page.value as any).documents.map((d: any) => d.body)).toEqual(["a"]);
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `bun run --filter @stackbase/admin test browse-live`
Expected: FAIL — `browseTableModule`, `adminModules`/`verifyAdmin`/`runAdmin` unknown.

- [ ] **Step 3: The `browseTable` module (`packages/admin/src/browse.ts`)**

```ts
import { query, type RegisteredFunction } from "@stackbase/executor";
import { convexToJson, type JSONValue, type Value } from "@stackbase/values";
import type { ComparisonOp } from "@stackbase/query-engine";

export interface FilterCond { field: string; op: ComparisonOp; value: JSONValue }
const MAX_SCAN = 1000;
const PAGE_SIZE = 50;

/** Privileged, subscribable table browser. Reads any full-named table via cursor paginate + filters. */
export const browseTableModule: RegisteredFunction = query(async (ctx, args: {
  table: string; cursor?: string | null; pageSize?: number; filter?: FilterCond[];
}) => {
  const b = (ctx as unknown as { db: { query(t: string, i: string): { where(op: ComparisonOp, f: string, v: Value): unknown; paginate(o: { cursor?: string | null; pageSize: number; maxScan: number }): Promise<{ page: unknown[]; nextCursor: string | null; hasMore: boolean; scanCapped: boolean }> } } })
    .db.query(args.table, "by_creation");
  for (const c of args.filter ?? []) (b as { where(op: ComparisonOp, f: string, v: Value): unknown }).where(c.op, c.field, c.value as Value);
  const res = await (b as { paginate(o: { cursor?: string | null; pageSize: number; maxScan: number }): Promise<{ page: unknown[]; nextCursor: string | null; hasMore: boolean; scanCapped: boolean }> })
    .paginate({ cursor: args.cursor ?? null, pageSize: args.pageSize ?? PAGE_SIZE, maxScan: MAX_SCAN });
  return {
    documents: (res.page as Value[]).map((d) => convexToJson(d)),
    nextCursor: res.nextCursor, hasMore: res.hasMore, scanCapped: res.scanCapped,
  } as JSONValue;
});
```

> The `ctx.db` casts mirror how other admin/system modules access the guest reader; the `.where(op, field, value)` builder + `.paginate({maxScan})` are the guest `QueryBuilder` methods (Task 1). A privileged query reads `args.table` as a full name.

Export it from `packages/admin/src/index.ts`: `export * from "./browse";`

- [ ] **Step 4: Runtime wiring (`runtime.ts`)**

Add to `EmbeddedRuntimeOptions`:
```ts
  adminModules?: Record<string, RegisteredFunction>;
  verifyAdmin?: (key: string) => boolean;
```
In `create`: `const adminModules: Record<string, RegisteredFunction> = { ...(options.adminModules ?? {}) };`. Add `runAdminQuery` to the `syncExecutor` object (replacing the Task-2 stub) — privileged, resolves from `adminModules`:
```ts
      async runAdminQuery(path, args) {
        const fn = adminModules[path];
        if (!fn) throw new Error(`unknown admin function: ${path}`);
        const r = await executor.run(fn, jsonToConvex(args), { path, privileged: true });
        return { value: r.value as Value, tables: writtenTablesFromRanges(r.readRanges), readRanges: r.readRanges.map(serializeKeyRange) };
      },
```
Pass `verifyAdmin` to the handler: `new SyncProtocolHandler(syncExecutor, { autoNotifyOnMutation: false, verifyAdmin: options.verifyAdmin })`. Store `adminModules` on the instance (constructor param + field). Add the public one-shot:
```ts
  /** Run a privileged admin built-in (`_admin:*`) once (e.g. for the HTTP fallback). Trusted callers only. */
  async runAdmin<T = unknown>(path: string, args: JSONValue): Promise<UdfResult<T>> {
    const fn = this.adminModules[path];
    if (!fn) throw new FunctionNotFoundError(`unknown admin function: ${path}`);
    return this.executor.run<T>(fn, jsonToConvex(args), { path, privileged: true });
  }
```

- [ ] **Step 5: `getTableData` delegates (`admin-api.ts`)**

Replace `getTableData`'s whole-table scan with a delegation to `runAdmin("_admin:browseTable", …)`, mapping the new `{ table, cursor, pageSize, filter }` params through and returning `{ documents, nextCursor, hasMore, scanCapped }`. (Keep `listTables` unchanged — mitigation #1.)

```ts
  async getTableData(table: string, opts: { cursor?: string | null; pageSize?: number; filter?: FilterCond[] } = {}): Promise<{ documents: JSONValue[]; nextCursor: string | null; hasMore: boolean; scanCapped: boolean }> {
    const r = await this.deps.runtime.runAdmin("_admin:browseTable", { table, cursor: opts.cursor ?? null, pageSize: opts.pageSize, filter: opts.filter });
    return r.value as { documents: JSONValue[]; nextCursor: string | null; hasMore: boolean; scanCapped: boolean };
  }
```

Update the `/_admin/tables/:t/data` router handler + `TableDataPage` type accordingly (cursor/filter query params → `getTableData` args; response shape). Import `FilterCond` from `./browse`.

- [ ] **Step 6: Run — verify it passes**

Run: `bun run --filter @stackbase/admin test browse-live`
Expected: PASS — non-admin rejected; admin subscription live-updates on a table write; `runAdmin` one-shot works.

- [ ] **Step 7: Whole workspace green + commit**

Run: `bun run build && bun run typecheck && bun run test`
Expected: PASS (existing admin/sync/runtime suites green; the sync `runAdminQuery` stub from Task 2 is now the real one).

```bash
git add packages/runtime-embedded/src/runtime.ts packages/admin/src/browse.ts packages/admin/src/admin-api.ts packages/admin/src/index.ts packages/admin/test/browse-live.test.ts
git commit -m "feat(admin): _admin:browseTable live query + runtime adminModules/runAdmin; getTableData delegates"
```

---

## Task 4: Dashboard live grid + cursor/filter UI + docs

**Files:**
- Create: `apps/dashboard/src/lib/ws-admin.ts`
- Modify: `apps/dashboard/src/features/data-browser.tsx`, `apps/dashboard/src/lib/admin.ts`, `CLAUDE.md`
- Test: `apps/dashboard/test/ws-admin.test.ts` (light)

**Interfaces:**
- Consumes: Task 2/3's `SetAdminAuth` + `_admin:browseTable`; `@stackbase/client`'s `websocketTransport`.
- Produces: `AdminBrowse` — a small live-subscription client the grid consumes.

- [ ] **Step 0: Give the dashboard a test runner (it has none yet)**

`apps/dashboard` has no `test` script / vitest. Add vitest so this task's test can run: add `vitest` to its `devDependencies` (use the workspace catalog version if present — check the root `package.json` `workspaces.catalog`), add `"test": "vitest run"` to its `scripts`, and add a `test: { environment: "node" }` block to `apps/dashboard/vite.config.ts` (the `AdminBrowse` client is pure TS — no DOM/jsdom needed). Run `bun install`. The `@stackbase/dashboard` turbo `test` task will now be picked up by `bun run test`.

- [ ] **Step 1: Write the failing test**

Create `apps/dashboard/test/ws-admin.test.ts` exercising the client against a fake transport (no real WebSocket):

```ts
import { describe, it, expect } from "vitest";
import { AdminBrowse, type AdminTransport } from "../src/lib/ws-admin";

// A fake transport that records sent messages and lets the test push server messages.
function fakeTransport() {
  const sent: any[] = []; let onMsg: ((m: any) => void) | null = null;
  const t: AdminTransport = { send: (m) => sent.push(m), onMessage: (cb) => { onMsg = cb; }, close: () => {} };
  return { t, sent, push: (m: any) => onMsg?.(m) };
}

describe("AdminBrowse client", () => {
  it("sends SetAdminAuth then subscribes to _admin:browseTable and surfaces page updates", async () => {
    const { t, sent, push } = fakeTransport();
    const pages: any[] = [];
    const b = new AdminBrowse(t, "SECRET");
    b.open("notes", (page) => pages.push(page));
    expect(sent[0]).toEqual({ type: "SetAdminAuth", key: "SECRET" });
    expect(sent[1].type).toBe("ModifyQuerySet");
    expect(sent[1].add[0].udfPath).toBe("_admin:browseTable");
    // simulate a server Transition with a QueryUpdated for the browse query
    push({ type: "Transition", modifications: [{ type: "QueryUpdated", queryId: sent[1].add[0].queryId, value: { documents: [{ body: "x" }], nextCursor: null, hasMore: false, scanCapped: false } }] });
    expect(pages.at(-1).documents).toEqual([{ body: "x" }]);
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `bun run --filter @stackbase/dashboard test ws-admin` (or the dashboard's test command)
Expected: FAIL — `AdminBrowse` doesn't exist.

- [ ] **Step 3: Implement `ws-admin.ts`**

```ts
// A minimal admin sync client for the data browser: authenticates with the admin key and keeps ONE
// live subscription to _admin:browseTable, re-subscribing when table/cursor/filter change.
export interface AdminTransport {
  send(msg: unknown): void;
  onMessage(cb: (msg: any) => void): void;
  close(): void;
}
export interface BrowsePage { documents: Record<string, unknown>[]; nextCursor: string | null; hasMore: boolean; scanCapped: boolean }
export interface FilterCond { field: string; op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte"; value: unknown }

export class AdminBrowse {
  private queryId = 0;
  private onPage: ((p: BrowsePage) => void) | null = null;
  constructor(private readonly t: AdminTransport, adminKey: string) {
    this.t.send({ type: "SetAdminAuth", key: adminKey });
    this.t.onMessage((m) => {
      if (m?.type !== "Transition") return;
      for (const mod of m.modifications ?? []) {
        if (mod.type === "QueryUpdated" && mod.queryId === this.queryId) this.onPage?.(mod.value as BrowsePage);
      }
    });
  }
  /** (Re)subscribe to a table page. Replaces any prior subscription. */
  subscribe(table: string, opts: { cursor?: string | null; filter?: FilterCond[] }, onPage: (p: BrowsePage) => void): void {
    const prev = this.queryId;
    this.queryId += 1;
    this.onPage = onPage;
    this.t.send({ type: "ModifyQuerySet",
      add: [{ queryId: this.queryId, udfPath: "_admin:browseTable", args: { table, cursor: opts.cursor ?? null, filter: opts.filter ?? [] } }],
      remove: prev ? [prev] : [] });
  }
  open(table: string, onPage: (p: BrowsePage) => void): void { this.subscribe(table, {}, onPage); }
  close(): void { this.t.close(); }
}
```

> A real transport wrapper over `@stackbase/client`'s `websocketTransport(url)` (a `send`/`onMessage`/`close` adapter) is a thin addition — the grid constructs `AdminBrowse(new WsTransport(url), adminKey)`. Keep the WebSocket URL derivation next to `admin.ts`'s key resolution.

- [ ] **Step 4: Wire the live grid (`data-browser.tsx`)**

Replace the react-query `getTableData` poll for the ROW GRID with the `AdminBrowse` subscription: on table/cursor/filter change, call `browse.subscribe(table, { cursor, filter }, setPage)`; render `page.documents` in the existing `@tanstack/react-table` grid; add a next/prev cursor control driven by `page.nextCursor`/`page.hasMore` (keep a cursor stack for "prev"); add the structured filter UI (rows of field + op-select + value → `FilterCond[]`); show a "scan limit reached — narrow the filter" banner when `page.scanCapped`. Keep the left-rail table LIST on the existing HTTP `listTables` (loaded on open + a manual refresh button; mitigation #1). Keep the `DocEditor` + delete on the existing admin HTTP calls, and REMOVE their `qc.invalidateQueries` (the live subscription reflects writes automatically).

- [ ] **Step 5: Run — verify it passes**

Run: `bun run --filter @stackbase/dashboard test ws-admin`
Expected: PASS.

- [ ] **Step 6: Correct `CLAUDE.md`**

In `CLAUDE.md`, move the dashboard out of the "Honestly deferred" list and note it under what-works: the dashboard (`apps/dashboard`) exists with a **live** data browser (admin sync subscriptions), plus logs and a function runner. Adjust the "build order" note so the dashboard isn't listed as an unstarted slice.

- [ ] **Step 7: Whole workspace green + commit**

Run: `bun run build && bun run typecheck && bun run test`
Expected: PASS.

```bash
git add apps/dashboard/src/lib/ws-admin.ts apps/dashboard/src/features/data-browser.tsx apps/dashboard/src/lib/admin.ts apps/dashboard/test/ws-admin.test.ts CLAUDE.md
git commit -m "feat(dashboard): live data browser via admin sync subscription + cursor/filter UI"
```

---

## Self-Review (completed by plan author)

**Spec coverage:** §3 admin channel → Task 2. §4 browseTable → Task 3. §5 getTableData delegate → Task 3. §6 mitigations: (1) lazy table list → Task 4 (grid live, list HTTP); (2) maxScan cap → Task 1 + Task 3 (browseTable sets it); (3) same-node doc → covered in spec, no code. §7 dashboard client → Task 4. §8 security/reactivity → Task 2 (unit) + Task 3 (end-to-end). §9 testing → each task. §10 files → matches. §11 out-of-scope → not built. ✅

**Placeholder scan:** No TBD/TODO. Task 1's query-engine test leaves the store-seeding to "reuse the existing test's helper" (the store's low-level write path is verbose and codebase-specific) — the assertions are concrete; Task 4 Step 4 is a precise construction recipe for the React grid rather than full verbose JSX, with the testable `ws-admin.ts` client given complete. These are the two deliberate "recipe not transcription" spots, both flagged.

**Type consistency:** `paginate({ maxScan })` + `scanCapped` identical across query-runtime (Task 1), kernel/guest (Task 1), and `browseTable` (Task 3). `SyncUdfExecutor.runAdminQuery` defined in Task 2, implemented in Task 3's runtime. `SetAdminAuth { key }` and `verifyAdmin(key)` consistent across protocol/handler (Task 2), runtime (Task 3), and the client (Task 4). `FilterCond { field, op, value }` consistent between `browse.ts` (Task 3) and `ws-admin.ts` (Task 4). `_admin:browseTable` path string identical everywhere. `runAdmin` (public) vs `runAdminQuery` (sync executor) — distinct names, both from `adminModules`, both privileged. ✅
```
