---
title: Tauri
---

# Tauri

> Run Stackbase sidecar-less inside a Tauri webview using embedded runtime + SQL plugin.

Stackbase can run fully in Tauri's JavaScript context. This removes localhost sidecars and uses `@tauri-apps/plugin-sql` for SQLite persistence.

## Architecture

```
┌────────────────────────────────────────────────┐
│  Tauri App                                     │
│  ┌──────────────────────────────────────────┐  │
│  │  Rust Backend                            │  │
│  │  Registers tauri-plugin-sql              │  │
│  └──────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────┐  │
│  │  Webview (React)                         │  │
│  │  @stackbase/runtime-embedded             │  │
│  │  Loopback WebSocket transport            │  │
│  │  @stackbase/docstore-tauri-sql           │  │
│  └──────────────────────────────────────────┘  │
└────────────────────────────────────────────────┘
```

## Prerequisites

- [Rust](https://rustup.rs/) toolchain
- [Tauri CLI v2](https://v2.tauri.app/start/prerequisites/)

## Quick start

### 1. Add dependencies

Frontend package:

```json
{
  "devDependencies": {
    "@stackbase/runtime-embedded": "workspace:*",
    "@stackbase/docstore-tauri-sql": "workspace:*",
    "@tauri-apps/plugin-sql": "^2.0.0"
  }
}
```

Rust package (`src-tauri/Cargo.toml`):

```toml
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-sql = { version = "2", features = ["sqlite"] }
```

### 2. Register SQL plugin in Rust

```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::new().build())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### 3. Bootstrap embedded Stackbase in the webview

```tsx
import Database from "@tauri-apps/plugin-sql";
import { ConvexReactClient } from "convex/react";
import { SqliteDocStore } from "@stackbase/docstore-tauri-sql";
import { createStackbase } from "@stackbase/runtime-embedded";

const modules = import.meta.glob(["../convex/**/*.{ts,tsx,js,jsx}", "!../convex/_generated/**"], {
  eager: true,
});

const db = await Database.load("sqlite:stackbase.db");
const runtime = createStackbase({
  docstore: new SqliteDocStore(db),
  modules,
  clientUrl: "http://localhost",
});

await runtime.start();
const transport = runtime.createTransport();

const client = new ConvexReactClient(transport.clientUrl, {
  webSocketConstructor: transport.webSocketConstructor,
});
```

Use the `client` exactly as you would in a normal Convex app.

## Optional: run runtime in a Worker

If you want isolation from your UI global scope, host the runtime in a Worker and bridge over `postMessage`:

- Worker side: `attachEmbeddedRuntimeWorkerServer(runtime, self)`
- UI side: `createWorkerTransport(worker)`

This keeps global patching and UDF execution away from the UI thread while preserving the Convex client API.

## Optional: sidecar mode

If you prefer a server process instead of running in-process, you can use a `stackbase build`'d binary as a Tauri sidecar:

```bash
# Build the standalone binary
bunx stackbase build --outfile src-tauri/binaries/stackbase
```

Configure `tauri.conf.json`:

```json
{
  "bundle": {
    "externalBin": ["binaries/stackbase"]
  }
}
```

Spawn it from Rust using `tauri-plugin-shell`, and parse the startup JSON (`{"ready":true,"port":3456,"url":"http://127.0.0.1:3456"}`) to get the server URL.

Switch between modes with an env var:

```bash
VITE_STACKBASE_MODE=sidecar VITE_STACKBASE_URL=http://127.0.0.1:3210 bun run tauri dev
```

## Notes

- The in-process path avoids sidecar startup latency and large sidecar binaries.
- For environments without `AsyncLocalStorage`, embedded runtime defaults to serialized UDF execution (`executionMode: "auto"`) to avoid context bleed.
- `@stackbase/docstore-tauri-sql` includes busy-retry logic for SQLite contention and schema versioning for forward/backward compatibility.

## Full example

See [`examples/tauri`](https://github.com/stackbase/stackbase/tree/main/examples/tauri) for a complete sidecar-less setup.

## Limitations

- **Single instance.** SQLite requires exclusive file access. Don't run multiple instances writing to the same database.
- **No sync to cloud.** Data lives only on the user's machine. Cloud sync is a future feature.

---

