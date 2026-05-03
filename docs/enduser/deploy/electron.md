---
title: Electron
status: planned
---

# Electron

> Embed Stackbase in an Electron desktop app with local-first SQLite storage.

> 🚧 **Planned — not yet shipped.** This page describes the intended design. The `createStackbase`
> API and the `@stackbase/runtime-node` / `@stackbase/blobstore-node-fs` packages below **do not
> exist** — the code will not run.
>
> **What works today:** [`stackbase build`](/deploy/standalone-binary) compiles your app into a
> self-contained executable that you can ship as an Electron **sidecar**. It prints a
> machine-readable `{"ready":true,"port":N,"url":"…"}` line on stdout precisely so a parent process
> can wait for startup and learn the port.

Run Stackbase inside Electron's main process for fully offline-capable desktop apps. Data is stored locally in SQLite — no server required.

## Architecture

```
┌─────────────────────────────────────────────┐
│  Electron App                               │
│  ┌────────────────────────────────────────┐ │
│  │  Main Process                          │ │
│  │  Stackbase Server (@stackbase/runtime-   │ │
│  │  node + better-sqlite3)                │ │
│  │  Listens on localhost:PORT             │ │
│  └────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────┐ │
│  │  Renderer Process                      │ │
│  │  React + ConvexReactClient             │ │
│  │  Connects to localhost:PORT            │ │
│  └────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

Stackbase runs as a library in the main process — no child process, no sidecar. The renderer connects to it via the standard Convex client over localhost.

## Prerequisites

- Node.js 22+
- Electron 28+
- `electron-rebuild` (to compile `better-sqlite3` native addon for Electron)

## Why better-sqlite3?

Electron bundles Node.js but cannot pass `--experimental-sqlite`, which `node:sqlite` requires. The `@stackbase/docstore-better-sqlite3` adapter uses [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) instead, which:

- Has first-class Electron support via `electron-rebuild`
- Is the most popular synchronous SQLite binding for Node.js
- Has an API nearly identical to `bun:sqlite`

## Quick start

### 1. Install dependencies

```bash
npm install @stackbase/runtime-node @stackbase/docstore-better-sqlite3 @stackbase/blobstore-node-fs
npm install --save-dev electron electron-rebuild
```

### 2. Rebuild native modules for Electron

```bash
npx electron-rebuild
```

This recompiles `better-sqlite3` against Electron's Node.js headers.

### 3. Main process setup

```ts
// electron/main.ts
import { app, BrowserWindow } from "electron";
import path from "node:path";
import { createStackbase } from "@stackbase/runtime-node";
import { SqliteDocStore } from "@stackbase/docstore-better-sqlite3";
import { FsBlobStore } from "@stackbase/blobstore-node-fs";

async function startStackbaseServer() {
  const dataDir = path.join(app.getPath("userData"), "stackbase");

  const server = createStackbase({
    docstore: new SqliteDocStore(path.join(dataDir, "db.sqlite")),
    blobstore: new FsBlobStore(path.join(dataDir, "storage")),
    convexDir: path.join(__dirname, "../convex"),
  });

  await server.listen({ port: 0 }); // Dynamic port
  return server;
}

app.whenReady().then(async () => {
  const server = await startStackbaseServer();

  const win = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
    },
  });

  // Pass the server URL to the renderer
  process.env.STACKBASE_URL = server.url;

  win.loadFile("dist/index.html");
});
```

### 4. Preload script

```ts
// electron/preload.ts
import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  stackbaseUrl: process.env.STACKBASE_URL ?? "http://127.0.0.1:3000",
});
```

### 5. Renderer

```tsx
// src/main.tsx
import { StackbaseProvider } from "@stackbase/client/react";
import { StackbaseClient, webSocketTransport } from "@stackbase/client";

const stackbaseUrl = window.electronAPI?.stackbaseUrl ?? "http://localhost:3000";
const wsUrl = stackbaseUrl.replace(/^http/, "ws") + "/api/sync";
const client = new StackbaseClient(webSocketTransport(wsUrl));

// Use <StackbaseProvider client={client}> as normal
```

The renderer uses the same `@stackbase/client/react` bindings as any Stackbase app — the same shape as Convex's `ConvexProvider`/`ConvexReactClient`, so an app brought over with `stackbase migrate` needs only this import swapped. No special APIs needed.

## TypeScript module loading

Stackbase loads your `convex/` directory at runtime. If it contains TypeScript files, register `tsx` programmatically in the main process before creating the server:

```ts
import { register } from "tsx/esm/api";
register();

// Now createStackbase() can load .ts files from convex/
```

Alternatively, pre-compile your `convex/` directory to JavaScript as part of your build step.

## Data storage

| What | Where |
|------|-------|
| SQLite database | `{userData}/stackbase/db.sqlite` |
| Blob storage | `{userData}/stackbase/storage/` |

`app.getPath("userData")` resolves to:
- macOS: `~/Library/Application Support/{appName}/`
- Windows: `%APPDATA%/{appName}/`
- Linux: `~/.config/{appName}/`

All data persists across app restarts. Uninstalling the app removes it (on macOS/Windows).

## Dynamic port allocation

Use `port: 0` so the OS assigns an available port. This avoids conflicts if the user runs multiple instances or has another service on port 3000.

```ts
await server.listen({ port: 0 });
console.log(server.port); // e.g., 52431
```

## Production build

```bash
# Build the renderer (Vite/webpack)
npm run build

# Compile Electron main process
tsc -p tsconfig.electron.json

# Package with electron-builder
npx electron-builder
```

When using `electron-builder`, `better-sqlite3` is automatically included as a native dependency. Make sure `electron-rebuild` runs as part of your build pipeline.

## Full example

See [`examples/electron`](https://github.com/stackbase/stackbase/tree/main/examples/electron) for a complete working Notes app.

## Limitations

- **Single instance only.** SQLite requires exclusive file access. Don't run multiple copies of the app writing to the same database.
- **No sync to cloud.** Data lives only on the user's machine. Cloud sync is a future feature.
- **Native dependency.** `better-sqlite3` requires compilation via `electron-rebuild`. This is standard for Electron apps with native modules.

---

