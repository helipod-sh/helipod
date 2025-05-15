---
title: Dashboard Slice — Design Spec
status: draft (awaiting review)
date: 2025-05-15
audience: engineering (internal)
---

# Dashboard Slice — Design Spec

The second build-order slice: a Convex-grade, PocketBase-crisp **local + self-hosted dashboard** —
a data browser, function runner, schema/tables overview, and a live log stream. Clean-room (we
study Convex/concave for UX patterns only; their dashboards are FSL — never copied). Built as a
**client of a new admin API**, so a multi-project control plane can layer on later without a rewrite.

## 1. Scope

**In (v1):**
- **Live data browser** — browse/filter/edit/delete documents per table; updates in real time.
- **Function runner** — pick a query/mutation, pass args, run, see result/error.
- **Schema & tables overview** — sidebar of tables with fields, indexes, and document counts.
- **Logs / observability** — live stream of function executions (path, kind, duration, status, error).
- **Admin-key auth boundary** on all admin endpoints (frictionless locally; env key when self-hosted).

**Out (non-goals):**
- Multi-project / team / deployment hierarchy (a *control plane* — a later layer above this; §7).
- Real end-user auth (that is build-order slice #3; the admin key is a stopgap, not that system).
- Billing, env-var management UI, deployment history, file/search browsers (later slices own those).

## 2. Architecture

```
apps/dashboard  (Vite + React + TS + Tailwind + shadcn-style components on Base UI
                 + TanStack Router / Query / Table)
        │  built to static assets, shipped with the CLI
        ▼
dev server (packages/cli)
   GET  /_dashboard/*  → serve the SPA (replaces today's status stub)
   ALL  /_admin/*      → admin/system API  (admin-key guarded)
   WS   /api/sync      → existing reactive sync (reused for LIVE table data)
        ▼
   engine: runtime.run() · docstore.index_scan · schema.export() · NEW execution-log sink
```

**Governing principle: the dashboard is a *client of an admin API*, not special server code.** The
engine stays ignorant of the UI; the admin surface is testable without a browser; and the same API
is exactly what a future multi-project control plane aggregates.

## 3. Components

### 3.1 Admin/system API — `packages/admin` (new, single-purpose)

Clean-room reimplementation of the concave `system-functions` pattern. Pure logic over the engine
seams (`EmbeddedRuntime`/`DocStore`/schema); the CLI routes `/_admin/*` to it. Endpoints:

| Endpoint | Purpose | Built on |
|---|---|---|
| `GET /_admin/tables` | tables → fields, indexes, doc counts | `schema.export()` + count scan |
| `GET /_admin/tables/:t/data?cursor&pageSize&filter` | paginated documents | `index_scan` / query engine |
| `GET /_admin/functions` | function manifest (path, kind, visibility) | CLI project manifest |
| `POST /_admin/run` | run a function with args → result/error | `runtime.run()` |
| `POST /_admin/tables/:t/docs` · `PATCH …/:id` · `DELETE …/:id` | create/edit/delete a doc (real mutations; UI guards "this writes to your DB") | system mutations |
| `GET /_admin/logs?since&kind&status` | execution log page | log sink (§3.2) |

All responses use the existing `convexToJson` codec (bigint/bytes-safe). All routes pass through the
auth middleware (§3.3).

### 3.2 Execution-log sink — `packages/executor` (the one new engine capability)

- Add a pluggable `LogSink` interface; the UDF executor pushes one entry per execution:
  `{ id, path, kind: "query"|"mutation"|"action", ts, durationMs, status: "ok"|"error", error? }`.
- Default `InMemoryLogSink` = a bounded ring buffer (concave's `InMemoryLogSink` pattern); `NoopLogSink`
  for when observability is off. The runtime composes a sink; the admin API reads it via `queryLog(filter)`.
- This is the *only* genuinely new engine plumbing; everything else reuses existing capabilities.

### 3.3 Auth boundary (carries us until the Auth slice)

One middleware guarding `/_admin/*`, expecting `Authorization: Bearer <adminKey>`:
- `stackbase dev` **auto-generates** a per-run admin key and bootstraps the served dashboard HTML
  with it (injected token) → **zero friction locally**.
- Self-hosted: operator sets `STACKBASE_ADMIN_KEY`; the dashboard prompts for it once and stores it.
- When slice #3 (Auth) lands, it augments/replaces this single middleware — not scattered checks.

### 3.4 Dashboard app — `apps/dashboard` (new)

- **Stack:** Vite + React + TypeScript · Tailwind · **shadcn/ui component approach on Base UI
  primitives** (not Radix; hand-roll with Tailwind where a Base UI primitive is missing) ·
  **TanStack Router** (type-safe routes) · **TanStack Query** (admin server-state) · **TanStack
  Table** (data grid).
- **Routes:** `/` (overview) · `/data/$table` (browser) · `/functions` (runner) · `/logs` (stream).
- **Build/serve:** built to static assets and **shipped inside the CLI package**, served at
  `/_dashboard` via the existing static-serve. No separate process.

## 4. Data flow

- **Live data browser:** a TanStack Query keyed by `(table, page, filter)` does the initial
  `/_admin/tables/:t/data` fetch; the dashboard *also* subscribes to that table over `/api/sync`, and
  reactive pushes call `queryClient.setQueryData(...)` to keep the cached page live (the **WS→Query
  bridge**, §Insight). Edits/deletes are admin mutations; the push reflects them automatically.
- **Function runner:** a TanStack Query mutation → `POST /_admin/run` → render result or error.
- **Logs:** a TanStack Query polling/streaming `/_admin/logs?since=…`, appended to a virtualized list.

## 5. Multi-project seam (honoring the chosen scope)

Everything the dashboard needs is `/_admin/*` on **one** deployment. A future control plane is an
additive layer that stores many `(deploymentUrl, adminKey)` pairs and renders the **same** dashboard
components inside a deployment-switcher shell. No component rewrite; the admin API is the contract.

## 6. Testing

- **Admin API + log sink:** vitest units (table listing, pagination+filter, run, doc edit, log
  query) — same discipline as the rest of the engine.
- **Dashboard SPA:** a Playwright smoke (load `/_dashboard`, browse a seeded table, run a function,
  see a log line) — the way we verified `examples/chat`.

## 7. Build order (milestones, each independently green)

- **D0** — `packages/admin` + the log sink in `packages/executor`; vitest units. (No UI.)
- **D1** — wire `/_admin/*` + the admin-key middleware into the CLI dev server; integration tests.
- **D2** — `apps/dashboard` scaffold (Vite + Tailwind + Base UI + TanStack Router/Query/Table); shell + overview.
- **D3** — Data browser (TanStack Table + the WS→Query live bridge) + edit/delete.
- **D4** — Function runner.
- **D5** — Logs stream.
- **D6** — Build the SPA into the CLI; serve at `/_dashboard`; Playwright smoke; reconcile `docs/enduser/local/dashboard.md`.

## 8. Open decisions (to confirm during planning)

1. **Filter syntax** for the data browser v1 — simple `field:value` equality (matches our enduser doc)
   vs a richer expression. *Lean: start with `field:value` equality over indexed fields.*
2. **Log transport** — poll `/_admin/logs?since` vs push logs over `/api/sync`. *Lean: poll for v1
   (simpler); upgrade to push later.*
3. **Dashboard packaging** — ship pre-built assets inside `@stackbase/cli` vs a separate
   `@stackbase/dashboard` package the CLI depends on. *Lean: separate `apps/dashboard`, built assets
   copied into the CLI at build time.*
