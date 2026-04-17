---
title: Dev Server
---

# Dev Server

> Local dev workflow with `stackbase dev`.

Day-to-day development: start the dev server, generate types, run functions, and inspect data.

## Start dev server

```bash
stackbase dev
```

Defaults:

| Option | Default | Flag |
|---|---|---|
| Port | `3000` | `--port <n>` |
| Hostname | `127.0.0.1` (localhost only) | `--ip <addr>` |
| Function directory | `convex/` | `--dir <path>` |
| Database | SQLite at `.stackbase/data.db` | `--data <path>` |

`stackbase dev` watches your functions, re-runs codegen, hot-reloads on change, and serves the sync
WebSocket, `/api/*`, your `httpAction` routes, and the dashboard.

Other flags: `--web <dir>` (serve a static web UI alongside the API), `--database-url <url>`
(Postgres instead of SQLite), `--storage-bucket` / `--storage-endpoint` (S3-compatible file
storage).

### Runtime selection

The runtime is **auto-detected** — Bun if you're running under Bun, otherwise Node. There are no
`--bun`, `--node`, or `--cf` flags; run the CLI with the runtime you want:

```bash
bun stackbase dev     # Bun (primary)
node stackbase dev    # Node
```

Bun is the primary runtime. There is no Cloudflare dev mode — see
[Cloudflare](/deploy/cloudflare) for what that (experimental) deployment path actually looks like.

### Node.js requirements

> **Node.js 22.5+ required**: The Node.js path uses the built-in `node:sqlite` module, which
> requires Node.js 22.5 or higher with experimental flags.

If you see `Cannot find module 'node:sqlite'`, check your Node.js version and that you're running
with `--experimental-sqlite`.

---

## Generate types

```bash
stackbase codegen
stackbase codegen --dir convex   # if your functions aren't in ./convex
```

Writes `convex/_generated/`. `stackbase dev` does this automatically on change; you need the
explicit command before [`stackbase serve`](/self-hosting), which never runs codegen.

---

## Run functions

There is no `stackbase run` command. Use the **dashboard's function runner**
(`http://localhost:3000/_dashboard`), or `POST /api/run`:

```bash
curl -X POST http://localhost:3000/api/run \
  -H 'content-type: application/json' \
  -d '{"path": "messages:list", "args": {"limit": 5}}'
```

The response is `{"value": …, "committed": …, "commitTs": "…"}`.

---

## Browse data

There is no `stackbase data` command. Use the dashboard at
`http://localhost:3000/_dashboard` — it has a live data browser with cursor pagination and
structured filters.

---

## CLI commands reference

`stackbase help` is the source of truth:

| Command | Description |
|---------|-------------|
| `stackbase dev` | Run the engine with hot reload + dashboard |
| `stackbase serve` | Run the production server (requires `STACKBASE_ADMIN_KEY`) |
| `stackbase deploy` | Push `convex/` to a running `serve --allow-deploy` and hot-swap it live |
| `stackbase build` | Compile the app to a self-contained executable |
| `stackbase migrate` | Migrate a Convex project into Stackbase (imports + report) |
| `stackbase codegen` | Regenerate `convex/_generated` types |
| `stackbase fleet reshard` | Change a stopped fleet's shard count |
| `stackbase objectstore reshard` | Change a stopped object-storage deployment's shard count |
| `stackbase help` | Show help |

> 🚧 **Planned, not built:** `stackbase init` (project scaffolding), `stackbase run` (invoke a
> function from the shell), and `stackbase data` (browse tables from the shell). Today, create
> projects by hand ([Quickstart](/quickstart)) and use the dashboard or `/api/run`.

### Components

Components (`@stackbase/scheduler`, `@stackbase/workflow`, `@stackbase/triggers`,
`@stackbase/auth`, `@stackbase/authz`) are **opt-in per project via `stackbase.config.ts`** — there
is no `stackbase components` command and no auto-install. See
[`examples/chat/stackbase.config.ts`](../../examples/chat) for the reference pattern.

---

## Common questions

- **Where is local data stored?** `.stackbase/data.db` by default (`--data` to change it).
- **How do I change the port?** `stackbase dev --port 4000`.
- **How do I switch runtimes?** Run the CLI under Bun or Node; it auto-detects.
- **Can I clear my local data?** Delete `.stackbase/` and restart.
- **Is the server reachable from my LAN?** Not by default — it binds `127.0.0.1`. Use
  `--ip 0.0.0.0` to expose it.

---
