---
title: Standalone Binary
---

# Standalone Binary

> Compile Stackbase into a single executable with `stackbase build`.

Package Stackbase as a standalone binary using `stackbase build`. The result is a single
self-contained executable — the Bun runtime, the Stackbase engine, `bun:sqlite`, your app's
`convex/` functions and schema, and any components composed in `stackbase.config.ts` are all
embedded at compile time via `bun build --compile`. No `bun`/`node` install and no `convex/`
directory needed at deployment time — only the binary and a data directory for SQLite.

## What's in the binary

| Component | Bundled? | Notes |
|-----------|----------|-------|
| Bun runtime | Yes | `bun build --compile` embeds the full runtime |
| Stackbase engine | Yes | Query engine, transaction system, sync protocol |
| SQLite (`bun:sqlite`) | Yes | Built into Bun — no external dependency |
| Your `convex/` functions + schema | Yes | Embedded at compile time via a generated static-import entrypoint |
| Composed components (`@stackbase/scheduler`, `@stackbase/workflow`, ...) | Yes | Whatever `stackbase.config.ts` composes |
| Dashboard | Optional | Included by default; exclude with `--no-dashboard` |
| SQLite **database file** | **No** | Lives on disk under `--data-dir`, external to the binary |

## Prerequisites

Install the CLI (and any components your app composes) as ordinary dependencies:

```bash
bun add @stackbase/cli

# only if your stackbase.config.ts composes them:
bun add @stackbase/scheduler @stackbase/workflow
```

There is no `stackbase init` scaffolder — you just need a `convex/` directory (schema +
functions) and, optionally, a `stackbase.config.ts` next to it (see
`examples/auth-demo/stackbase.config.ts` for the reference pattern). `stackbase build` runs
its own codegen internally, so there's no separate codegen step to run first.

## Build

### For the current platform

```bash
stackbase build
```

Output: `./stackbase-server`.

### Custom output path

```bash
stackbase build --outfile ./dist/my-backend
```

### Cross-compilation

```bash
# Linux x64
stackbase build --target linux-x64 --outfile ./dist/server-linux

# Linux ARM64
stackbase build --target linux-arm64 --outfile ./dist/server-linux-arm64

# macOS Apple Silicon
stackbase build --target darwin-arm64 --outfile ./dist/server-macos

# macOS Intel
stackbase build --target darwin-x64 --outfile ./dist/server-macos-x64

# Windows x64
stackbase build --target windows-x64 --outfile ./dist/server-windows.exe
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--dir <path>` | `convex` | Path to the app's `convex/` directory to build |
| `--outfile <path>` | `./stackbase-server` | Output path for the binary |
| `--target <platform>` | current platform | One of `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `windows-x64` |
| `--no-dashboard` | — | Exclude the dashboard UI from the binary |
| `--verbose` | — | Stream the underlying `bun build --compile` output |

Note: the compile step deliberately omits `--bytecode` — the generated entrypoint uses a
top-level `await` (to boot the runtime before serving), which `bun build --compile --bytecode`
rejects. Cold-start speed is negligible for a long-running self-hosted server binary.

## Run

```bash
STACKBASE_ADMIN_KEY=your-strong-secret ./stackbase-server --port 3000 --hostname 0.0.0.0 --data-dir ./data
```

`STACKBASE_ADMIN_KEY` is **required** — the binary fails fast (exit 1) if it isn't set. Unlike
`stackbase dev`, it is never auto-generated; this is production-facing, same as `stackbase serve`.

### CLI flags

| Flag | Default | Description |
|------|---------|-------------|
| `--port` | `3000` (or `$PORT`) | Port to listen on |
| `--hostname` | `0.0.0.0` | Address to bind to |
| `--data-dir` | `./data` | Directory holding the SQLite database (`db.sqlite`) |

### Environment variables

| Variable | Required | Description |
|----------|----------|--------------|
| `STACKBASE_ADMIN_KEY` | **Yes** | Bearer token for the dashboard + admin API. No default — the binary refuses to start without it. |
| `PORT` | No | Fallback for `--port` when the flag isn't passed |

## Machine-readable startup

On successful startup, the binary writes exactly one JSON line to stdout, after the listener is
up:

```json
{"ready":true,"port":3000,"url":"http://0.0.0.0:3000"}
```

This is designed for a parent process (Electron, Tauri, a supervisor script) to read stdout and
know exactly when the server is ready and which port it bound.

## Graceful shutdown

The binary handles `SIGINT` and `SIGTERM`: it stops the server, closes the SQLite database, and
exits with code 0.

## Deployment patterns

### Standalone server

Run the binary directly on a VPS or bare metal:

```bash
STACKBASE_ADMIN_KEY=your-strong-secret ./stackbase-server --hostname 0.0.0.0 --port 8080 --data-dir /var/lib/stackbase
```

### Minimal Docker image

The runtime-based image described in [Self-Hosting](/self-hosting) bind-mounts `convex/` into a
generic Bun image. If you'd rather ship one tiny, immutable image with nothing but the compiled
binary, build for `linux-x64`/`linux-arm64` and copy just that executable into a distroless (or
`scratch`) base — no Bun, no `node_modules`, no source:

```bash
stackbase build --target linux-x64 --outfile ./dist/stackbase-server
```

```dockerfile
# Dockerfile.binary
FROM gcr.io/distroless/base-debian12

COPY dist/stackbase-server /stackbase-server

EXPOSE 3000
VOLUME /data

ENTRYPOINT ["/stackbase-server", "--hostname", "0.0.0.0", "--data-dir", "/data"]
```

```bash
docker build -f Dockerfile.binary -t my-app-binary .
docker run -p 3000:3000 -e STACKBASE_ADMIN_KEY=your-strong-secret -v stackbase-data:/data my-app-binary
```

This is the tiny-image alternative to the runtime-based image in [Self-Hosting](/self-hosting):
build once per target platform, ship a single executable, no bind-mounted `convex/` at all
(it's already embedded).

### Embedded in desktop apps

The standalone binary works as a sidecar for desktop app wrappers:

- **[Tauri](/deploy/tauri)** — build with `stackbase build --outfile src-tauri/binaries/stackbase` and spawn as a sidecar, parsing the `{"ready":...}` line for the URL.
- **[Electrobun](/deploy/electrobun)** — prefers running Stackbase in-process in the Bun main process, but the binary can be spawned as a child process instead if you want process isolation.

### systemd service

```ini
[Unit]
Description=Stackbase Server
After=network.target

[Service]
Type=simple
Environment=STACKBASE_ADMIN_KEY=your-strong-secret
ExecStart=/opt/stackbase/stackbase-server --data-dir /var/lib/stackbase --hostname 0.0.0.0
Restart=on-failure
User=stackbase

[Install]
WantedBy=multi-user.target
```

## Full example

There is no packaged `examples/standalone` app yet — any of the existing `examples/*` apps'
`convex/` directory can be pointed at with `stackbase build --dir <path>`.

## Limitations

- **Single instance.** SQLite requires exclusive file access — one binary process per data directory.
- **No live hot-swap.** Unlike `stackbase serve --allow-deploy`, the binary doesn't expose `POST /_admin/deploy` — functions, schema, and the composed component set are all fixed at build time. Shipping a change means rebuilding and redeploying the binary, not `stackbase deploy`.
- **The component set is fixed at build time.** Composing a new component (e.g. adding `@stackbase/workflow`) requires a rebuild.
- **No Postgres adapter yet.** SQLite only (slice 6c is unbuilt).

---
