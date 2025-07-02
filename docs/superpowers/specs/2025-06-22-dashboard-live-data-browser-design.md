# Dashboard — Live Data Browser (admin sync subscriptions) — design

**Status:** approved (brainstorming) — 2025-06-22
**Slice:** dashboard build-order slice #2, data-browser first. Upgrades the EXISTING data browser (not a greenfield build).
**Predecessor context:** `apps/dashboard` already has a working data browser (`features/data-browser.tsx`): list tables, a `@tanstack/react-table` grid, a JSON `DocEditor` (create/edit/patch/delete). `@stackbase/admin` serves `/_admin/*` HTTP with a static admin key (`verifyAdminKey`, constant-time). Its `getTableData` scans the whole table into memory per request; browsing is not live (react-query invalidation, not the sync WebSocket); filtering is a single `field:value` exact match. The reactive engine is range-precise (read/write ranges drive subscription invalidation), and the query engine's `paginate` is cursor-based + store-level. NOTE: `CLAUDE.md` still lists the dashboard as a deferred "later slice" — that is stale and is corrected by this slice.

---

## 1. Goal

Make the data browser **live** — a real client of the product's own reactive engine — and fix its two load/UX weaknesses (whole-table-scan pagination, weak filtering), while keeping the dashboard's footprint small on the shared instance.

- **Live grid:** the current table's visible page updates live via an **admin-authenticated privileged sync subscription** (the product dogfooding its reactive tier).
- **Cursor pagination:** replace the whole-table scan with the cursor-based `paginate`.
- **Richer filtering:** a small structured predicate compiled to the engine's `FilterExpr`.
- **Three load mitigations** (below) so the internal dashboard doesn't pressure the shared production DB/infra.

---

## 2. Locked decisions (from brainstorming)

1. **Option B — true sync-WebSocket subscription**, not notify-refetch. The dashboard authenticates a sync session with the admin key and subscribes to a privileged browse query; live-ness comes from the shipped read-set/write-set invalidation. Rationale: dogfoods the reactive engine, is the foundation the rest of a live dashboard (logs, activity) will reuse, and its hard part (reactivity) already exists.
2. **Only the grid is live; the table list is not** (mitigation #1).
3. **Three mitigations baked in:** (1) table list / per-table counts stay on-demand HTTP, never recomputed on writes; (2) a bounded per-page filter scan (`maxScan` cap); (3) same-node co-location documented as the intended self-host model with a Tier-2 replica seam — no code now.

---

## 3. Admin sync channel (the engine addition)

The security boundary of the whole slice. Today a sync session carries `identity` (a user token) and runs subscribed queries **non-privileged**, namespace-scoped. This adds an admin-privileged path.

- **`Session` gains `privileged: boolean`** (default `false`), alongside the existing `identity`.
- **New client message `SetAdminAuth { key }`.** `SyncProtocolHandler` is constructed with a `verifyAdmin(key: string): boolean` callback; on `SetAdminAuth` it sets `session.privileged = verifyAdmin(msg.key)`. A wrong/absent key leaves the session unprivileged and pushes an error; it never throws the connection down. `identity` stays `null` for an admin session (admin is not a user).
- **Query routing in `handleModifyQuerySet`:** for each added query, if `udfPath` starts with the reserved prefix **`_admin:`**:
  - if `!session.privileged` → reject that query with an error (`Forbidden: admin subscription requires admin auth`), do not subscribe it;
  - else run it via a new `SyncUdfExecutor.runAdminQuery(udfPath, args)` (resolves from the runtime's `adminModules` map, runs `executor.run(..., { privileged: true })`), and subscribe on its `readRanges` exactly as a normal query.
  - a non-`_admin:` path runs through the existing `runQuery(udfPath, args, session.identity)` unchanged.
- `SyncUdfExecutor` gains `runAdminQuery(udfPath, args): Promise<{ value; tables; readRanges }>` (same result shape as `runQuery`).

**Invariant:** privilege is granted *only* by a successful `SetAdminAuth`, and privileged execution happens *only* for `_admin:`-prefixed subscriptions on a privileged session. Every existing path is untouched and unprivileged.

---

## 4. `_admin:browseTable` — the privileged, subscribable query

Registered in the runtime's `adminModules` (a new map, parallel to `systemModules` but subscribable via the sync handler). It is a `query` UDF:

```
_admin:browseTable({ table: string, cursor?: string | null, pageSize?: number, filter?: FilterCond[] })
  → { documents: JSONValue[], nextCursor: string | null, hasMore: boolean, scanCapped: boolean }
```

- Runs privileged, so `ctx.db.query(table, "by_creation")` reads the **full-named** table raw (`auth/users`, `authz/role_assignments`, app tables) — the admin dashboard sees everything.
- `.paginate({ cursor, pageSize: pageSize ?? 50, maxScan: 1000 })` — cursor-based, store-level; `maxScan` bounds the scan (mitigation #2).
- `filter` is a `FilterCond[]` — each `{ field, op, value }` (`op ∈ eq|ne|lt|lte|gt|gte`) becomes one `FilterExpr` comparison passed in the query's `filters` array (the engine AND-combines a `filters` array), so no `WhereInput` compiler is involved.
- Because the dashboard *subscribes* to it, `paginate`'s recorded read-set (the scanned index range) drives **range-precise invalidation**: a committed write into the visible page's range re-runs `browseTable` and pushes the updated page; a write elsewhere does not wake it.

---

## 5. Cursor pagination + richer filtering (also the HTTP path)

`getTableData` (the one-shot admin HTTP endpoint, kept as a non-live fallback) is rewritten to **delegate to the exact same `browseTable` module** via a new privileged one-shot `runtime.runAdmin(path, args)` (resolves from `adminModules`, runs `{ privileged: true }`) — so the HTTP and subscription paths share ONE implementation, not two `paginate` copies. Its response gains `nextCursor`/`hasMore`/`scanCapped` and takes an optional `{ cursor, pageSize, filter: FilterCond[] }`. Filtering moves from a single `field:value` string to the structured `FilterCond[]`.

---

## 6. The three mitigations

1. **Table list not live.** `listTables` (with its per-table `store.count`) stays an on-demand HTTP call — loaded on first open / manual refresh and cached client-side. It is never subscribed and never recomputed on writes. Only the grid subscribes.
2. **Bounded filter scan.** `paginate` gains an optional `maxScan?: number` (max index rows examined while filling a page). When the interval scan reaches `maxScan` before collecting `pageSize` matches, it stops and returns the partial page with `scanCapped: true`. `browseTable`/`getTableData` set `maxScan: 1000`. The UI shows a "scan limit reached — narrow the filter" banner on `scanCapped`.
3. **Same-node co-location** is the intended self-host model (Convex/Supabase/PocketBase all do this); the dashboard is a normal admin-key client. Pointing it at a read replica or gating it to an operator network is a Tier-2 seam — documented, no code now.

---

## 7. Dashboard client

- **A small WS admin client** (`apps/dashboard/src/lib/ws-admin.ts`) reusing `@stackbase/client`'s `websocketTransport`: connects to the sync WebSocket, sends `SetAdminAuth(adminKey)` (the same key `admin.ts` already resolves), subscribes to `_admin:browseTable({ table, cursor, pageSize, filter })`, and exposes an `onUpdate(page)` stream + a `setPage(cursor)` / `setFilter(conds)` control. It manages one subscription (the active table view), re-subscribing when table/cursor/filter change.
- **The grid** (`features/data-browser.tsx`) moves from the react-query `getTableData` poll to this live subscription. It renders `documents`, a next/prev cursor control (using `nextCursor`/`hasMore` + a cursor stack for back), the structured filter UI (field + op + value rows), and the `scanCapped` banner.
- **The `DocEditor` + delete stay on admin HTTP** (`patch`/`insert`/`delete`). They no longer need `invalidateQueries` — the live subscription reflects the write automatically (edit/create/delete a row → `browseTable` re-runs → grid updates). This is itself a demonstration of the reactive tier.
- The table list (left rail) stays on the HTTP `listTables` (loaded on open, manual refresh button), per mitigation #1.

---

## 8. Reactivity & security

Live-ness is entirely the shipped engine (read-set/write-set intersection, range-precise) — no second reactivity mechanism. Security rests on the single gate in §3: a `_admin:` subscription runs privileged **iff** the session passed `SetAdminAuth` with the correct key (constant-time `verifyAdminKey`); all other subscriptions are unchanged and unprivileged. A non-admin (or wrong-key) session that tries to subscribe to `_admin:browseTable` is rejected and never reads privileged data.

---

## 9. Testing

- **Query engine (`paginate`):** with `maxScan`, a filter that matches nothing within the cap returns a bounded (possibly empty) page + `scanCapped: true`; without a filter, normal cursor paging is unaffected.
- **`_admin:browseTable`:** privileged read of a full-named non-app table (e.g. `auth/users`); cursor pages advance; a `filter` narrows results; `scanCapped` fires past `maxScan`.
- **Admin sync channel (the security assertions):**
  - an admin-authed session (`SetAdminAuth` with the right key) subscribing to `_admin:browseTable` receives a value AND a **live push when a write lands in the viewed page** (the headline);
  - a session that did NOT `SetAdminAuth`, and a session that sent a WRONG key, are **rejected** when subscribing to `_admin:*` (no privileged read);
  - a normal (non-`_admin:`) subscription still runs non-privileged/identity-scoped (regression).
- **HTTP `getTableData`:** cursor + `FilterCond[]` filtering parity + `scanCapped`.
- **Dashboard (light):** the WS admin client subscribes and renders a page; editing a row via the HTTP editor updates the grid with no manual refetch (asserted via the client's onUpdate stream against a fake/loopback transport).
- **Regression:** existing sync, admin, query-engine, and dashboard suites green; `runtime` boot + existing subscriptions unaffected.

---

## 10. File structure

**Modify**
- `packages/query-engine/src/query-runtime.ts` — `paginate` gains `maxScan` + returns/enables a `scanCapped` signal.
- `packages/sync/src/handler.ts` (+ the client-message types) — `Session.privileged`, `SetAdminAuth`, `_admin:` routing, `runAdminQuery` on `SyncUdfExecutor`.
- `packages/runtime-embedded/src/runtime.ts` — `EmbeddedRuntimeOptions.adminModules` + `verifyAdmin`; a privileged one-shot `runAdmin(path, args)` (from `adminModules`) + `runAdminQuery` wired into the `SyncUdfExecutor`; pass `verifyAdmin` to the handler.
- `packages/admin/src/*` — the `browseTable` admin `query` module (registered in `adminModules`); `getTableData` → delegates to `runtime.runAdmin("_admin:browseTable", …)`; the `FilterCond` type; export the admin module for the runtime to register.
- `apps/dashboard/src/lib/admin.ts` / `features/data-browser.tsx` — the live grid + cursor/filter UI; lazy table-list counts.
- `CLAUDE.md` — correct the dashboard/data-browser status (built, live; not a deferred slice).

**New**
- `apps/dashboard/src/lib/ws-admin.ts` — the WS admin client.
- the `browseTable` module + tests (`packages/admin/test`, `packages/sync/test`, `packages/query-engine/test`).

---

## 11. Out of scope (later slices)

Live table list / live counts; schema-aware typed editing + `v.id` reference navigation (the not-chosen option — a natural follow-up); column sorting; live logs + live function-activity (which reuse this same admin-subscription channel); admin subscriptions across the Tier-2 fleet; approximate/estimated row counts; a full admin-auth session model beyond the static key.
