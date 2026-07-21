# @helipod/vite

Vite plugin for Helipod: `vite` alone serves your frontend and the Helipod backend on one browser origin — no manual proxy configuration, no CORS.

Unlike most Helipod packages, this one is installed directly (it is not part of the umbrella `helipod` package):

```sh
bun add -D @helipod/vite   # or: npm install -D @helipod/vite
```

## Usage

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { helipod } from "@helipod/vite";

export default defineConfig({
  plugins: [helipod()],
});
```

Run `vite` and the plugin brings the backend up alongside the dev server. `/api` (including the `/api/sync` WebSocket), `/_dashboard`, and `/_admin` are served from the same origin as your app.

## Modes

- `"proxy"` (default): spawns `helipod dev` as a child process on a free port and proxies the engine-owned path prefixes to it. Uses Node builtins only; the `@helipod/cli` peer dependency stays optional.
- `"embed"`: boots the engine inside Vite's own process as middleware plus a `/api/sync` WebSocket — no child process, no proxy hop. Requires `@helipod/cli` to be installed; reached via `helipod({ mode: "embed" })`.

## Options

- `mode` — `"proxy"` | `"embed"` (default `"proxy"`).
- `functionsDir` — app functions directory (default `"helipod"`).
- Proxy mode: `port`, `command` (how to invoke the CLI), `args` (extra flags forwarded to `helipod dev`).
- Embed mode: `dataPath` (SQLite file, default `<root>/.helipod/dev.db`), `databaseUrl` (opt-in Postgres), `adminKey` (default: an ephemeral per-run key).

The child process is cleaned up when the Vite server closes or receives a signal.

Part of [Helipod](https://github.com/helipod-sh/helipod) — docs at https://helipod-six.vercel.app/docs

License: FSL-1.1-Apache-2.0
