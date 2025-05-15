---
title: Dev Server
---

# Dev Server

> Local dev workflow with Bun, Node, or Cloudflare dev.

Day-to-day development workflows: start the dev server, generate types, run functions, and inspect data.

## Start dev server

```bash
# Auto-detect bun or node
stackbase dev

# Force runtime
stackbase dev --bun
stackbase dev --node
stackbase dev --cf
```

Notes:
- Bun/Node dev uses local SQLite + filesystem blobstore in `./.stackbase/local`.
- Cloudflare dev uses `wrangler dev` under the hood.

---

## Runtime selection

| Runtime | Best for | Requirements |
|---------|----------|--------------|
| **Bun** (default) | Fast local dev | Bun installed |
| **Node.js** | Node-only environments | Node.js 22.5+ with flags |
| **Cloudflare** | Testing CF behavior | Wrangler installed |

### Hostname defaults

Each runtime has different default binding behavior:

| Runtime | Default hostname | Accessible from |
|---------|------------------|-----------------|
| **Bun** | `0.0.0.0` | All network interfaces (LAN accessible) |
| **Node.js** | `127.0.0.1` | Localhost only |
| **Cloudflare** | N/A | Via wrangler |

> **Security note**: Bun's default (`0.0.0.0`) makes the server accessible from other devices on your network. For local-only development, use `--ip 127.0.0.1` or set `ip: "127.0.0.1"` in your config.

### Node.js requirements

> **Node.js 22.5+ required**: The Node.js runtime uses the built-in `node:sqlite` module, which requires Node.js version 22.5 or higher with experimental flags.

Node.js SQLite support requires:

1. Node.js version **22.5 or higher**
2. Experimental flags when running:

```bash
# The CLI handles this automatically, but for manual runs:
node --experimental-sqlite --experimental-vm-modules server.js
```

If you see `Cannot find module 'node:sqlite'`, check your Node.js version.

---

## Generate types

```bash
# Runtime analysis (preferred)
stackbase codegen

# Static fallback
stackbase codegen --static
```

---

## Run functions

```bash
stackbase run messages:list
stackbase run users:create '{"name":"Alice"}'
```

---

## Browse data

```bash
stackbase data
stackbase data users --limit 50
```

Or use the dashboard at `http://localhost:3000/_dashboard`.

---

## CLI commands reference

| Command | Description |
|---------|-------------|
| `stackbase init` | Initialize a new Stackbase project with starter files |
| `stackbase dev` | Start the development server |
| `stackbase codegen` | Generate TypeScript types from your functions |
| `stackbase run <fn> [args]` | Execute a function from the command line |
| `stackbase data [table]` | Browse database contents |
| `stackbase deploy` | Deploy to Cloudflare Workers |
| `stackbase components` | Manage Convex components (experimental) |

### stackbase init

Creates a new Stackbase project with starter files:

```bash
stackbase init
```

This creates:
- `convex/` directory with a sample function
- `convex/_generated/` for generated types
- Basic project structure

### stackbase components

Experimental support for Convex components:

```bash
stackbase components
```

> **Note**: Full component support is not yet implemented. This command provides basic component management for early adopters.

---

## Common questions

- **Where is local data stored?** `./.stackbase/local/` (SQLite database and file storage).
- **How do I change the port?** `stackbase dev --port 4000` or set `port` in config.
- **How do I switch runtimes?** Use `--bun`, `--node`, or `--cf`.
- **Can I clear my local data?** Delete the `.stackbase/local/` directory and restart.

---

