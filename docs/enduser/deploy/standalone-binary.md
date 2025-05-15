---
title: Standalone Binary
---

# Standalone Binary

> Compile Stackbase into a single executable with stackbase build.

Package Stackbase as a standalone binary using `stackbase build`. The result is a single executable that bundles the Bun runtime, Stackbase core, SQLite, your Convex functions, and all dependencies. No runtime installation or `convex/` directory needed at deployment time.

## What's in the binary

| Component | Bundled? | Notes |
|-----------|----------|-------|
| Bun runtime | Yes | Full runtime including `bun:sqlite`, `Bun.serve()` |
| Stackbase core | Yes | Query engine, transaction system, sync protocol |
| SQLite (`bun:sqlite`) | Yes | Built into Bun — no external dependency |
| npm dependencies | Yes | `convex`, `jose`, etc. are bundled |
| User UDF code (`convex/`) | **Yes** | Embedded at compile time via dynamic imports |
| Dashboard | Optional | Included by default, exclude with `--no-dashboard` |

User code **is** bundled into the binary. At deploy time, the only thing you need is the binary itself and a data directory for SQLite.

## Prerequisites

Install the CLI and runtime dependencies:

```bash
bun add @stackbase/cli convex
bun add @stackbase/runtime-bun @stackbase/docstore-bun-sqlite @stackbase/blobstore-bun-fs @stackbase/core
```

Initialize your project if you haven't already:

```bash
bunx stackbase init
```

Generate types before building:

```bash
bunx stackbase codegen
```

## Build

### For the current platform

```bash
bunx stackbase build
```

Output: `./stackbase-server` (~60MB self-contained binary)

### Custom output path

```bash
bunx stackbase build --outfile ./dist/my-backend
```

### Cross-compilation

```bash
# Linux x64
bunx stackbase build --target linux-x64 --outfile ./dist/server-linux

# macOS Apple Silicon
bunx stackbase build --target darwin-arm64 --outfile ./dist/server-macos

# Windows x64
bunx stackbase build --target windows-x64 --outfile ./dist/server-windows.exe
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--outfile <path>` | `./stackbase-server` | Output path for the binary |
| `--target <platform>` | Current platform | Cross-compile target (e.g., `linux-x64`, `darwin-arm64`) |
| `--no-dashboard` | — | Exclude the dashboard UI from the binary |
| `--verbose` | — | Show detailed build output |

## Usage

```bash
./stackbase-server --port 3000 --data-dir ./data
```

### CLI flags

| Flag | Default | Description |
|------|---------|-------------|
| `--port` | `3000` | Port to listen on. |
| `--hostname` | `127.0.0.1` | Hostname to bind to. Use `0.0.0.0` for all interfaces. |
| `--data-dir` | `./data` | Directory for SQLite database and blob storage. |
| `--help` | — | Show help message. |

## Machine-readable startup

On successful startup, the binary outputs a single JSON line to stdout:

```json
{"ready":true,"port":3000,"url":"http://127.0.0.1:3000"}
```

This is designed for parent process integration. Electron, Tauri, and other wrappers can parse this line to know when the server is ready and on which port to connect.

## Deployment patterns

### Standalone server

Run the binary directly on a VPS or bare metal server:

```bash
./stackbase-server --hostname 0.0.0.0 --port 8080
```

Pair with a frontend served from a CDN or the same machine.

### Docker

```dockerfile
FROM ubuntu:24.04

COPY stackbase-server /usr/local/bin/stackbase-server

VOLUME /app/data
EXPOSE 3000

CMD ["stackbase-server", "--data-dir", "/app/data", "--hostname", "0.0.0.0"]
```

No Bun, Node.js, or `convex/` directory needed in the container — the binary is fully self-contained.

### Embedded in desktop apps

The standalone binary is the foundation for desktop deployment:

- **[Tauri](/deploy/tauri)** — Build with `stackbase build --outfile src-tauri/binaries/stackbase` and spawn as a sidecar
- **[Electron](/deploy/electron)** — Use `@stackbase/runtime-node` + `better-sqlite3` directly in the main process, or spawn the binary as a child process

### systemd service

```ini
[Unit]
Description=Stackbase Server
After=network.target

[Service]
Type=simple
ExecStart=/opt/stackbase/server --data-dir /var/lib/stackbase --hostname 0.0.0.0
Restart=on-failure
User=stackbase

[Install]
WantedBy=multi-user.target
```

## What works in compiled binaries

`bun build --compile` produces a fully functional single-file executable. Everything Stackbase needs works:

| Feature | Status |
|---------|--------|
| `bun:sqlite` | Built into Bun runtime |
| `Bun.serve()` | HTTP + WebSocket on the same port |
| Dynamic `import()` | User modules embedded at compile time |
| `node:fs` | Bun's Node.js compat layer |
| `AsyncLocalStorage` | Used by Stackbase for request context |
| npm packages | Bundled into the binary at compile time |

## Graceful shutdown

The binary handles `SIGINT` (Ctrl+C) and `SIGTERM` for clean shutdown:

1. Stops accepting new connections
2. Drains in-flight requests
3. Closes the SQLite database
4. Exits with code 0

## Full example

See [`examples/standalone`](https://github.com/stackbase/stackbase/tree/main/examples/standalone) for a React app powered by the standalone binary.

## Limitations

- **Binary size.** ~60MB due to the bundled Bun runtime.
- **Single instance.** SQLite requires exclusive file access. For horizontal scaling, use [Cloudflare Workers](/deploy/cloudflare).

---

