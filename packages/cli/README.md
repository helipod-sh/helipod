# @helipod/cli

The `helipod` command-line tool: run, deploy, and build Helipod apps — a local dev server with hot reload, a production server, push-based live deploys, single-binary compiles, data import/export, and typed codegen.

Most users should install the umbrella package [`helipod`](https://www.npmjs.com/package/helipod) instead — it bundles this CLI (the `helipod` bin ships inside it) along with the server function helpers, the client SDK, and the React hooks.

```sh
bun add helipod   # or: npm install helipod
```

## Usage

```sh
# local development: watch helipod/, hot-reload functions, serve the sync
# WebSocket + HTTP API + dashboard on one port
bunx helipod dev

# production: requires HELIPOD_ADMIN_KEY, binds 0.0.0.0, no codegen at boot
HELIPOD_ADMIN_KEY=... bunx helipod serve
```

## Commands

- `helipod dev` — run the engine locally with hot reload and the dashboard.
- `helipod serve` — run the production server (requires `HELIPOD_ADMIN_KEY`, graceful shutdown on SIGTERM/SIGINT).
- `helipod deploy` — deploy the app: `--target <serve|cloudflare|docker|railway|fly|aws>`, `--env <name>`, with `--dry-run` and `--check` modes. Deploying to a running `serve` hot-swaps functions and additive schema changes with no restart.
- `helipod build` — compile the app and its components into a single self-contained executable (via `bun build --compile`), with cross-compile targets for Linux, macOS, and Windows.
- `helipod migrate` — convert an existing project from another backend into a Helipod project (rewrites imports, emits a divergence report). `migrate export` / `migrate import` move app data as a portable JSON dump between deployments.
- `helipod codegen` — regenerate the typed `_generated/` output (typed `api`, `Doc`/`Id` types, `mintId`) for your functions directory.

Common options: `--port <n>`, `--ip <addr>`, `--dir <functionsDir>`, `--data <dbPath>`, `--database-url <url>` (Postgres; SQLite is the zero-config default).

## Features

- One-command local dev: functions, reactive sync, HTTP API, and dashboard on a single port.
- SQLite by default, Postgres via `--database-url` — no app-schema migrations either way.
- Live deploys to a running server (`serve --allow-deploy`), rejected if the schema change is destructive.
- Single-binary output that embeds the runtime, your functions, and the dashboard.

Part of [Helipod](https://github.com/helipod-sh/helipod) — docs at https://helipod-six.vercel.app/docs

License: FSL-1.1-Apache-2.0
