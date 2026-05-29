---
title: Vite Plugin
---

# Vite Plugin

> `@stackbase/vite` — one `vite` command, frontend and backend on one origin.

If your app already runs on Vite (React, Vue, Svelte, plain TS — anything Vite serves), the
`@stackbase/vite` plugin spawns `stackbase dev` for you and proxies the engine's routes through
Vite's own dev server. You run `vite` (or `vite dev`) and get both your frontend AND your
Stackbase backend on **one browser origin** — no second terminal, no manual proxy config, no CORS.

## Install

```bash
bun add -D @stackbase/vite
# or: npm install -D @stackbase/vite
```

## Setup

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { stackbase } from "@stackbase/vite";

export default defineConfig({
  plugins: [stackbase()],
});
```

Run Vite as usual:

```bash
vite
```

The plugin spawns `stackbase dev` in the background (codegen runs, the engine boots), waits for it
to become ready, then wires Vite's dev-server proxy at `/api` (including the `/api/sync` WebSocket
upgrade), `/_dashboard`, and `/_admin` to the running engine. Your frontend code calls
`useQuery`/`useMutation` and hits `/api/sync` on `location.host` — same origin as your app, no
`VITE_STACKBASE_URL` env var to configure, no CORS headers to reason about.

The child `stackbase dev` process is torn down when Vite's dev server closes (including on
`SIGINT`/`SIGTERM`), so `Ctrl-C` cleanly stops both.

## What it does

- Resolves a free port for the backend (or uses the one you specify).
- Resolves how to invoke the CLI: your project's local `node_modules/.bin/stackbase` if present,
  else falls back to `npx stackbase` (or an explicit `command` override — see below).
- Spawns `stackbase dev --port <port> --dir <convexDir>` (plus any extra `args`), pipes its
  stdout/stderr into Vite's own logger prefixed `[stackbase]`, and waits for the port to accept
  connections before Vite finishes starting.
- Injects proxy rules into Vite's dev-server config for `/api` (`ws: true`), `/_dashboard`, and
  `/_admin`, all pointed at the spawned backend. If you already have your own `server.proxy`
  entries in `vite.config.ts`, Vite merges them — the plugin doesn't clobber your config.
- Kills the backend process when Vite's `httpServer` closes, and on `SIGINT`/`SIGTERM`.

## Options

```ts
stackbase({
  convexDir: "convex",
  port: 3210,
  command: "node ./node_modules/.bin/stackbase",
  args: ["--database-url", "postgres://…"],
})
```

| Option | Type | Default | Description |
|---|---|---|---|
| `convexDir` | `string` | `"convex"` | App functions directory, passed as `stackbase dev`'s `--dir`. |
| `port` | `number` | an OS-assigned free port | Backend port to proxy to. Set this if you need a stable/predictable backend port. |
| `command` | `string` | local `node_modules/.bin/stackbase`, else `npx stackbase` | How to invoke the CLI. Split on whitespace, so `"bun /path/to/stackbase"`-style overrides work too. |
| `args` | `string[]` | `[]` | Extra flags forwarded to `stackbase dev` (e.g. `["--database-url", "postgres://…"]`, `["--storage-bucket", "…"]`). |

## This complements `stackbase dev`, it doesn't replace it

`@stackbase/vite` is for the common case: a Vite-based frontend that wants its Stackbase backend
on the same origin during local dev. It is **not** a replacement for the `stackbase` CLI:

- Backend-only work (no frontend, or a frontend that isn't on Vite) — keep using
  [`stackbase dev`](/local/dev-server) directly.
- `stackbase codegen`, `stackbase deploy`, `stackbase build`, `stackbase serve`, and every other
  CLI command are unchanged — the plugin only wraps `stackbase dev` for local development. Deploy
  tooling doesn't go through Vite at all.
- Production builds don't involve this plugin. Build your Vite frontend normally and deploy your
  Stackbase backend via [`stackbase serve`](/self-hosting) / Docker / [`stackbase
  build`](/deploy/standalone-binary) as usual — `@stackbase/vite` is a `devDependency`, dev-only.

## Phase 2 (not built)

Today the plugin spawns a **separate `stackbase dev` OS process** and proxies to it over HTTP/WS —
simple, robust, and it reuses the exact same dev server every other entry point uses. A possible
follow-on is an **in-process embed**: running the engine directly inside Vite's Node process
instead of spawning a child, trading a little isolation for a faster boot and one fewer process to
manage. That's not built — the spawn-and-proxy model is the whole of `@stackbase/vite` v1.
