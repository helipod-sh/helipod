---
title: stackbase deploy
---

# stackbase deploy

> Push your local `convex/` to a running `stackbase serve` deployment. Live. No restart.

`stackbase deploy` transpiles your local functions and additive schema changes and pushes them to
a running production server, which hot-swaps them in atomically — the same process keeps serving
requests throughout, and a rejected deploy never leaves it partially applied.

## Prerequisites

- A running `stackbase serve` deployment (see [Docker Self-Hosting](/self-hosting)), started with
  deploys explicitly enabled (see below).
- The deployment's `STACKBASE_ADMIN_KEY`.

## Enabling it: `--allow-deploy`

A running `serve` does **not** accept deploys by default. Start it with `--allow-deploy` (or set
`STACKBASE_ALLOW_DEPLOY=1`) to opt in:

```bash
stackbase serve --dir convex --allow-deploy
# or
STACKBASE_ALLOW_DEPLOY=1 stackbase serve --dir convex
```

Without this flag, `POST /_admin/deploy` isn't registered at all — it falls through to the generic
admin-router 404, indistinguishable from a nonexistent endpoint.

**Why opt-in:** the admin key already grants full read/write access to your data (it's what the
dashboard and `stackbase deploy` both authenticate with). Without a separate gate, a leaked admin
key would mean arbitrary remote code execution — every deploy replaces the functions that run
inside the transaction. Requiring `--allow-deploy` keeps "read/write my data" and "replace my
running code" as two deliberate, separately-opted-into capabilities, even though they share one
key today.

## Usage

From your app's project root (where `convex/` lives):

```bash
STACKBASE_ADMIN_KEY=… stackbase deploy --url https://myapp.example
```

Flags:

- `--url <url>` — the target deployment's base URL (or set `STACKBASE_DEPLOY_URL`).
- `--dir <convexDir>` — defaults to `convex`.

`stackbase deploy`:

1. Refreshes your local `convex/_generated/` (same codegen `stackbase dev`/`stackbase codegen`
   produce), so your client's typed API stays in sync with what you're about to push.
2. Transpiles every `.ts` file under `convex/` (types stripped, imports untouched — bare
   `@stackbase/*` imports resolve against the target's own `node_modules`, exactly like the Docker
   image; relative imports resolve within the pushed tree).
3. `POST`s the resulting file tree to `/_admin/deploy` with `Authorization: Bearer $STACKBASE_ADMIN_KEY`.

On success:

```
✓ deployed rev 4b3187d88b93 (7 functions)
```

The new functions are callable immediately — no server restart, and existing WebSocket
subscriptions keep working and reactively pick up writes made through the newly-deployed code.

## Additive-only schema — destructive changes are rejected

There are no data migrations yet. A deploy may:

- add new tables,
- add new **optional** fields to an existing table.

A deploy is **rejected** (server stays on the previous version, nothing swaps) if it would:

- remove or rename a table,
- change a table's internal table number,
- remove a field,
- change a field's type,
- turn an existing optional field required,
- add a new **required** field to an existing table.

Any of these come back as `deploy failed: <reason>` with exit code 1, and the running deployment is
completely unaffected — validation (load + schema diff) always completes before anything is
swapped, so a rejected deploy can't leave the server half-updated.

## Component set is fixed at boot

The components composed into a deployment (e.g. `@stackbase/scheduler`, `@stackbase/workflow`) are
whatever `stackbase.config.ts` declared when `serve` booted. `stackbase deploy` can push new
functions and additive schema against that fixed component set, but it cannot add or remove
components on a live server — changing `stackbase.config.ts`'s component list requires a restart
(redeploy the container / restart the process).

## Known limitation: functions must be top-level under `convex/`

The function loader is top-level only — it does not recurse into subdirectories of `convex/`.
Keep your query/mutation/action modules directly under `convex/*.ts` (e.g. `convex/items.ts`), not
nested under a subfolder (e.g. `convex/lib/items.ts`); nested modules are silently not loaded. This
applies to `stackbase dev`/`stackbase serve` as well as `stackbase deploy`.

## Reverse proxy / TLS

Same as `serve` itself: Stackbase speaks plain HTTP, so `stackbase deploy --url` should point at
whatever terminates TLS in front of it (nginx, Caddy, Traefik) — see
[Docker Self-Hosting](/self-hosting#reverse-proxy--tls) for the reverse-proxy note in full.

## Related

- [Docker Self-Hosting](/self-hosting) — how to run the `serve` target this pushes to.
- Data migrations, a rollback command, and multi-node deploys are not part of this slice — see the
  repo `CLAUDE.md` for what's shipped vs. deferred.
