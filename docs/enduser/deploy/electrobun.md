---
title: Electrobun
status: planned
---

# Electrobun

> Embed Stackbase in an Electrobun desktop app with Bun and bun:sqlite for lightweight, local-first storage.

> 🚧 **Planned — not yet shipped.** This page describes the intended design. The `createStackbase`
> API and the `@stackbase/runtime-bun` package below **do not exist** — the code will not run.
>
> **What works today:** [`stackbase build`](/deploy/standalone-binary) compiles your app into a
> self-contained executable (embedding Bun and `bun:sqlite`) that you can ship as a sidecar. It
> prints a machine-readable `{"ready":true,"port":N,"url":"…"}` line on stdout for parent-process
> integration.

Run Stackbase inside Electrobun's Bun main process for lightweight, offline-capable desktop apps. Uses the system WebView instead of bundled Chromium — ~14 MB bundles, sub-50ms cold starts.

## Architecture

```
┌─────────────────────────────────────────────┐
│  Electrobun App                             │
│  ┌────────────────────────────────────────┐ │
│  │  Bun Main Process                     │ │
│  │  Stackbase Server (@stackbase/runtime-  │ │
│  │  bun + bun:sqlite)                    │ │
│  │  Listens on localhost:PORT            │ │
│  └────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────┐ │
│  │  System WebView                       │ │
│  │  React + ConvexReactClient            │ │
│  │  Connects to localhost:PORT           │ │
│  └────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

Stackbase runs as a library in the Bun main process — no child process, no sidecar. The system WebView (WebKit on macOS, Edge WebView2 on Windows, WebKitGTK on Linux) connects to it via the standard Convex client over localhost.

## Prerequisites

- [Bun](https://bun.sh/) 1.1+
- [Electrobun](https://blackboard.sh/electrobun/) (`bun install electrobun`)

## Why Electrobun?

Electrobun uses Bun as its main process runtime and the platform's native WebView for rendering. Compared to Electron:

- **~14 MB** compressed bundle vs 150 MB+ (no bundled Chromium)
- **Sub-50ms** cold start vs 2–5 seconds
- **Pure TypeScript** — no Rust (vs Tauri) or native addons (vs Electron + better-sqlite3)
- **bun:sqlite** is built into Bun — no native compilation or `electron-rebuild` step

## Quick start

### 1. Install dependencies

```bash
bun install electrobun @stackbase/runtime-bun @stackbase/docstore-bun-sqlite @stackbase/blobstore-bun-fs
```

### 2. Main process setup

Electrobun's main process runs on Bun, so you use `@stackbase/runtime-bun` directly. Since Electrobun's bundler doesn't support `import.meta.glob`, import your convex modules explicitly:

```ts
// src/bun/index.ts
import { BrowserWindow } from "electrobun/bun";
import { createStackbase, SqliteDocStore, FsBlobStore } from "@stackbase/runtime-bun";
import path from "node:path";
import os from "node:os";

import * as schema from "../../convex/schema";
import * as notes from "../../convex/notes";

const convexModules = {
  "convex/schema.ts": schema,
  "convex/notes.ts": notes,
};

const dataDir = path.join(os.homedir(), ".my-app");

const server = createStackbase({
  modules: convexModules,
  docstore: new SqliteDocStore(path.join(dataDir, "db.sqlite")),
  blobstore: new FsBlobStore(path.join(dataDir, "storage")),
});

await server.listen({ port: 0 });
```

### 3. Create the window

Inject the server URL into the WebView via Electrobun's `preload` option:

```ts
// src/bun/index.ts (continued)
const win = new BrowserWindow({
  title: "My App",
  titleBarStyle: "hiddenInset",
  frame: { width: 960, height: 680 },
  url: "views://renderer/index.html",
  preload: `window.__STACKBASE_URL__ = ${JSON.stringify(server.url)};`,
});
```

The `views://` protocol loads bundled content from Electrobun's build output. The `preload` script runs before page scripts, making the URL available to the renderer.

### 4. Renderer

```tsx
// src/renderer/index.tsx
import { StackbaseProvider } from "@stackbase/client/react";
import { StackbaseClient, webSocketTransport } from "@stackbase/client";

const stackbaseUrl = window.__STACKBASE_URL__;
const wsUrl = stackbaseUrl.replace(/^http/, "ws") + "/api/sync";
const client = new StackbaseClient(webSocketTransport(wsUrl));

// Use <StackbaseProvider client={client}> as normal
```

The renderer uses the same `@stackbase/client/react` bindings as any Stackbase app — the same shape as Convex's `ConvexProvider`/`ConvexReactClient`, so an app brought over with `stackbase migrate` needs only this import swapped. No special APIs needed.

### 5. Electrobun config

```ts
// electrobun.config.ts
export default {
  app: {
    name: "My App",
    identifier: "dev.myapp",
    version: "0.0.1",
  },
  build: {
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    views: {
      renderer: {
        entrypoint: "src/renderer/index.tsx",
      },
    },
    copy: {
      "src/renderer/index.html": "views/renderer/index.html",
      "src/renderer/index.css": "views/renderer/index.css",
    },
  },
};
```

## Module loading

Electrobun's bundler does not support `import.meta.glob`. Instead, explicitly import each convex module and build a module map:

```ts
import * as schema from "../../convex/schema";
import * as tasks from "../../convex/tasks";
import * as messages from "../../convex/messages";

const modules = {
  "convex/schema.ts": schema,
  "convex/tasks.ts": tasks,
  "convex/messages.ts": messages,
};
```

The keys use the `convex/<module>.ts` format. Stackbase's module loader normalizes these to resolve `api.tasks.list`, `api.messages.send`, etc.

## Data storage

| What | Where |
|------|-------|
| SQLite database | `~/.my-app/db.sqlite` |
| Blob storage | `~/.my-app/storage/` |

Use `os.homedir()` to build a platform-appropriate path. On macOS that's `/Users/<name>/.my-app/`, on Linux `~/.my-app/`, on Windows `C:\Users\<name>\.my-app\`.

## Dynamic port allocation

Use `port: 0` so the OS assigns an available port. This avoids conflicts if the user runs multiple instances.

```ts
await server.listen({ port: 0 });
console.log(server.url); // e.g., http://127.0.0.1:52431
```

## Production build

```bash
# Development build + run
bun start

# Production build
electrobun build --env=stable
```

Electrobun produces a compressed, self-extracting app bundle. Subsequent builds generate binary diff patches as small as 14 KB for incremental updates.

## Full example

See [`examples/electrobun`](https://github.com/stackbase/stackbase/tree/main/examples/electrobun) for a complete working Notes app.

## Limitations

- **Single instance only.** SQLite requires exclusive file access. Don't run multiple copies of the app writing to the same database.
- **No sync to cloud.** Data lives only on the user's machine. Cloud sync is a future feature.
- **macOS 14+, Windows 11+, Ubuntu 22.04+.** Electrobun's system WebView support matches these platform versions.

---

