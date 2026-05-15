# Docs Rewrite (fumadocs) — Design

**Status:** approved structure; foundation-first milestone.
**Date:** 2026-05-15
**Worktree:** `docs-rewrite` (branched from `main`).

## Problem

The existing `docs/enduser/` (31 markdown files) was **derived from concave's scraped
docs and functioned as a roadmap**, not as documentation of what stackbase actually
ships. It has drifted and duplicated (e.g. `testing.md` at both top level and under
`build/`; `deploying.md` vs `deploy/self-hosted.md`; `files.md` vs the storage pages),
and it documents features that don't exist (search/vector). Some real content was
recently written into it (`build/auth.md`, `build/notifications.md`) but it sits beside
the roadmap pages with no coherent information architecture.

We are rebuilding the public documentation from scratch in a new `docs_new/` directory
using **fumadocs**, writing pages carefully, one at a time, documenting **only what
stackbase really has**.

## Principles

1. **Real-only (anti-roadmap).** Every page maps to a shipped, working capability.
   Deferred/unbuilt features are **not** documented until they ship — this is the exact
   failure of the old docs. Explicitly excluded for now (not shipped): full-text/vector
   **search**, true **V8-isolate global sandboxing**, built-in **TLS termination**, and
   any other item on the "honestly deferred" list in `CLAUDE.md`.
2. **Naming: "stackbase"** everywhere, to match the shipping artifacts — the `@stackbase/*`
   npm packages and the `stackbase` CLI. (The product may later be renamed "Crest"; if that
   rename executes, the docs follow then. Until then, docs must match the real import/command
   names or they'd be wrong.)
3. **Concept → hands-on → reference.** Anchored on the SpacetimeDB docs' structure (which the
   user likes): a genuine conceptual on-ramp (What is / How it works) before the API surface,
   because stackbase's reactive model is novel and needs explaining, not just listing.
4. **Modern OSS docs baseline.** Fast static site, good search, dark/light, copyable code,
   versionable — the table stakes a developer expects when evaluating an open-source backend.

## Tooling

- **fumadocs** (Next.js App Router + MDX) as a **self-contained app** under `docs_new/`.
- **Isolated from the backend build.** `docs_new/` is NOT a Bun-workspace member and NOT in
  the Turborepo pipeline — it has its own `package.json` and `node_modules`, its own
  `bun run dev`/`build`. Rationale: the engine is a Bun/TS backend monorepo; pulling
  Next.js/React into its `typecheck`/`build` matrix would be a large, unrelated cost and a
  drift risk. The docs app depends on nothing in the workspace; it only *describes* it.
- **Content** lives in `docs_new/content/docs/**.mdx`; the **sidebar** is driven by
  `meta.json` files per folder, ordered to match the IA below.
- **Package manager:** Bun (consistent with the repo).
- Deployment target (eventual `docs.stackbase.dev`) is **out of scope** for this milestone —
  we build a site that runs locally (`bun run dev`) and builds cleanly (`bun run build`).

## Information Architecture (the approved sidebar)

```
GET STARTED
  What is stackbase?          the reactive-BaaS pitch + the mental model
  How it works                THE reactive model: queries record read-sets, mutations
                              compute write-sets, a subscription re-runs only when a
                              committed write-set intersects its read-set → pushed
  Quickstart                  install → first reactive app running
  Tutorial                    build a small app end-to-end            (stub for now)

CORE CONCEPTS  (the always-on engine)
  Schema & tables             defineSchema, validators, indexes
  Queries                     reactive, deterministic, read-set recorded
  Mutations                   the only writers; one serializable transaction     (stub)
  Actions                     side effects outside the transaction               (stub)
  Reactivity                  subscriptions, invalidation, determinism rules     (stub)
  HTTP & webhooks             httpAction + the router                            (stub)
  File storage                _storage, ctx.storage, uploads                     (stub)

CLIENT
  Client SDK                  useQuery/useMutation/useAction, React              (stub)
  Optimistic updates          withOptimisticUpdate, the no-flicker contract      (stub)
  Offline sync                the Receipted Outbox, IndexedDB/fs, client ids     (stub)

COMPONENTS  (opt-in, composed via stackbase.config.ts)
  Overview                    the component model                                (stub)
  Auth                        sessions, email, OAuth, MFA/TOTP, passkeys         (stub)
  Authorization               RBAC, ReBAC, row policies                          (stub)
  Notifications               email/SMS/in-app/push, preferences, digest         (stub)
  Scheduling                  runAfter/runAt, cron jobs                          (stub)
  Workflows                   durable multi-step, saga/compensation              (stub)
  Triggers                    onChange over the MVCC log                         (stub)

DEPLOY & OPERATE
  Local dev & dashboard       stackbase dev, the data browser                    (stub)
  Self-hosting (Docker)       stackbase serve, docker compose up                 (stub)
  Postgres                    --database-url, the Postgres adapter               (stub)
  Deploy & build              stackbase deploy (live hot-swap), single binary    (stub)
  Cloudflare                  DO-native host                                     (stub)
  Scaling (fleet)             Tier-2 multi-node (ee/)                            (stub)

REFERENCE
  CLI                         dev/serve/deploy/build/migrate/codegen             (stub)
  Testing                     @stackbase/test                                    (stub)
  Migrate from Convex         stackbase migrate                                  (stub)
  Configuration               stackbase.config.ts, env vars                      (stub)
  FAQ                                                                            (stub)
```

**Structural decisions (locked):** Client is its own group (the reactive-hooks + optimistic +
offline story is substantial and frontend-audience-distinct); Components is a top-level group
(matching Convex — it signals "opt-in add-ons," which is architecturally true: each is composed
in `stackbase.config.ts`); "How it works" is one moderate conceptual page for now, expandable
into a SpacetimeDB-style cluster later.

## First milestone: "Foundation + spine"

**In scope — a working fumadocs app that renders the full sidebar skeleton, with these
pages written for real:**

1. `docs_new/` scaffolded: runnable fumadocs (Next.js) app, isolated from the workspace,
   `bun run dev` serves it, `bun run build` succeeds.
2. The complete IA above wired via `meta.json` files — every section/entry present in the
   sidebar (non-spine entries are short stub pages: a one-line summary + a "documentation in
   progress" note, so the structure is browsable and no link 404s).
3. **Spine pages written in full:**
   - Docs home / landing (`index.mdx`)
   - *What is stackbase?*
   - *How it works* (the reactive model)
   - *Quickstart* (install → a first reactive query/mutation running against `stackbase dev`)
   - *Schema & tables* (core-concept exemplar #1)
   - *Queries* (core-concept exemplar #2 — closes the reactive loop with the above)
4. Every spine page's commands, imports, and code samples are **verified against the real
   shipping surface** (the `@stackbase/*` packages / `stackbase` CLI as they exist on `main`),
   not invented.

**Out of scope for this milestone:**

- Writing the ~25 stub pages' real content (each is a follow-up, one at a time).
- Deleting or modifying `docs/enduser/` — it stays as a reference until `docs_new` reaches
  parity, then a later cleanup removes it.
- Deploying to a domain / CI for the docs site.
- Visual/brand theming beyond fumadocs defaults (a later polish pass).

## Success criteria

- `cd docs_new && bun run dev` serves the site; the full sidebar (all groups/entries above)
  renders; navigation works with no broken links.
- `cd docs_new && bun run build` succeeds.
- The six spine pages read as real documentation of shipped behavior — a developer can go from
  *What is stackbase?* → *Quickstart* → a running reactive app, and understand *Schema* + *Queries*.
- The backend workspace is untouched: `bun run build`/`typecheck` at the repo root are unaffected
  by `docs_new/` (it is not a workspace member).

## Non-goals / deferred

- Full content authoring of every section (incremental, page-by-page follow-ups).
- Old-docs removal (separate cleanup once parity is reached).
- Search-provider wiring beyond fumadocs' built-in, brand theming, versioned docs, i18n.
