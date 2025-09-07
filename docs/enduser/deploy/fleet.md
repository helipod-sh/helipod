---
title: Fleet (Multi-Node)
---

# Fleet (Multi-Node)

> `stackbase serve --fleet` — N identical nodes over one shared Postgres database. Any node
> serves any request; exactly one is the writer at a time; kill it and another takes over live.

This is Stackbase's first multi-node deployment story (Tier 2, slice 1): a small, symmetric
fleet of `stackbase serve` processes that share a single Postgres database. There is no
coordinator service and no "primary"/"replica" flag to set — every node runs the *identical*
command, and the fleet decides its own roles at boot (and again on failover) using a lease
that lives in the database itself.

## What it is

- **Symmetric nodes.** Every node runs `stackbase serve --fleet ...` with the same flags. The
  first node to acquire the shared **write lease** (a Postgres advisory lock, discoverable via a
  `fleet_lease` row) becomes the **writer**; every other node is a **sync node**.
- **Connect to any node.** A client can open its WebSocket / HTTP connection to *any* node in the
  fleet. Queries and subscriptions are always served locally by whichever node the client is
  connected to. Mutations, actions, and `httpAction` requests are transparently **forwarded** to
  the current writer if they land on a sync node — the client never needs to know or care which
  node is the writer.
- **Reactive updates cross the process boundary.** When the writer commits, it `NOTIFY`s the
  shared Postgres database; every sync node is `LISTEN`ing and re-runs/pushes affected
  subscriptions, with a 1-second poll fallback if a `NOTIFY` is ever missed (the write log itself
  is always the source of truth, so a missed notification costs latency, never a missed update).
- **Live failover.** If the writer process dies (crash, `SIGKILL`, a bad deploy), its Postgres
  session — and with it the advisory lock — is released automatically. A sync node's retry loop
  picks up the lease, typically within a couple of seconds, and promotes itself to writer. No
  restart of the other nodes is needed.

This is built on the same Postgres storage adapter as [single-node self-hosting with
Postgres](/self-hosting#using-postgres) — a fleet is that same adapter, plus a small `ee/`
package (`@stackbase/fleet`) that adds the lease, the cross-process wake-up, and write
forwarding.

## Requirements

- **Postgres**, not SQLite. Fleet mode requires `--database-url`/`STACKBASE_DATABASE_URL`
  pointed at a real Postgres database — SQLite has no concept of a shared lease across
  processes, so `--fleet` with SQLite (or no database URL at all) fails fast at startup.
- **`@stackbase/fleet` installed.** It's the enterprise package that implements the fleet
  runtime — source-available under the commercial license (`ee/LICENSE`), **free to use today**
  (see [Business Model & Licensing](../../dev/business-model-and-licensing.md); no license key is
  required for this slice). `stackbase serve` loads it via a dynamic `import()` — core Stackbase
  has no hard dependency on it — so if `--fleet` is passed and the package can't be resolved,
  serve fails fast with an install instruction (`bun add @stackbase/fleet`) instead of a cryptic
  module-not-found error.
- **An advertised URL per node.** `--advertise-url`/`STACKBASE_ADVERTISE_URL` is the URL *other*
  fleet nodes should use to reach this node — recorded on the lease when this node is the writer,
  and used by sync nodes to forward writes / proxy `httpAction`s to it.
- **The same `STACKBASE_ADMIN_KEY` on every node.** Nodes authenticate to each other's internal
  forwarding endpoint with this key (a plain bearer token), so it must be identical across the
  fleet — same as it already needs to be a single strong secret per deployment.

## Starting a fleet node

```bash
STACKBASE_ADMIN_KEY=... stackbase serve \
  --dir convex \
  --database-url postgres://user:pass@host:5432/db \
  --fleet \
  --advertise-url http://10.0.0.5:3000
```

Or via environment variables (equivalent, useful for container orchestration):

```bash
export STACKBASE_ADMIN_KEY=...
export STACKBASE_DATABASE_URL=postgres://user:pass@host:5432/db
export STACKBASE_FLEET=1
export STACKBASE_ADVERTISE_URL=http://10.0.0.5:3000
stackbase serve --dir convex
```

Every node in the fleet runs this same command (or the env-var equivalent) — only
`--advertise-url` differs per node, because it's *this node's own* reachable address.

### Fail-fast checks

| Misconfiguration | Result |
|---|---|
| `--fleet` without `--database-url`/`STACKBASE_DATABASE_URL` (or a SQLite URL) | Exits: `fleet mode requires --database-url (Postgres) — set --database-url postgres://… or STACKBASE_DATABASE_URL.` |
| `--fleet` without `--advertise-url`/`STACKBASE_ADVERTISE_URL` | Exits: `fleet mode requires --advertise-url (or STACKBASE_ADVERTISE_URL) — the URL other fleet nodes reach this node at, e.g. --advertise-url http://10.0.0.2:3000` |
| `--fleet` without `@stackbase/fleet` installed | Exits: `fleet mode requires @stackbase/fleet — install it (bun add @stackbase/fleet).` |
| No `--fleet` at all | **Unchanged** — today's single-node behavior, including the existing single-writer advisory-lock fail-fast if a second engine points at the same Postgres database. |

### The ready line grows a role field

`serve`'s machine-readable startup line gains two additive fields in fleet mode:

```json
{"level":"info","msg":"stackbase serve","url":"http://0.0.0.0:3000","fleet":true,"role":"writer"}
```

`role` is `"writer"` or `"sync"` depending on which one this node became at boot (or after a later
promotion — the JSON line is only printed once at startup, so watch the dashboard/logs, not this
line, to observe a live promotion). Non-fleet `serve` never includes `fleet`/`role` at all.

## Example: 2-node fleet with Docker Compose

This extends the base [Docker self-hosting](/self-hosting) compose file: same `stackbase:latest`
image (built from the repo's `Dockerfile`, `target: runner`), a shared `postgres:16` service
instead of the SQLite volume, and **two** `stackbase` services instead of one — each pointed at
the other via its own Compose service name as the advertise URL.

```yaml
services:
  stackbase-a:
    build:
      context: .
      target: runner
    image: stackbase:latest
    ports:
      - "3000:3000"
    volumes:
      - ./convex:/app/convex:ro
    environment:
      STACKBASE_ADMIN_KEY: ${STACKBASE_ADMIN_KEY:?set STACKBASE_ADMIN_KEY in a .env file}
      STACKBASE_DATABASE_URL: postgres://stackbase:stackbase@postgres:5432/stackbase
      STACKBASE_FLEET: "1"
      STACKBASE_ADVERTISE_URL: http://stackbase-a:3000
    command: serve --dir /app/convex
    depends_on:
      - postgres
    restart: unless-stopped

  stackbase-b:
    build:
      context: .
      target: runner
    image: stackbase:latest
    ports:
      - "3001:3000"
    volumes:
      - ./convex:/app/convex:ro
    environment:
      STACKBASE_ADMIN_KEY: ${STACKBASE_ADMIN_KEY:?set STACKBASE_ADMIN_KEY in a .env file}
      STACKBASE_DATABASE_URL: postgres://stackbase:stackbase@postgres:5432/stackbase
      STACKBASE_FLEET: "1"
      STACKBASE_ADVERTISE_URL: http://stackbase-b:3000
    command: serve --dir /app/convex
    depends_on:
      - postgres
    restart: unless-stopped

  postgres:
    image: postgres:16
    restart: unless-stopped
    environment:
      POSTGRES_USER: stackbase
      POSTGRES_PASSWORD: stackbase
      POSTGRES_DB: stackbase
    volumes:
      - postgres-data:/var/lib/postgresql/data

volumes:
  postgres-data:
```

`docker compose up` boots both nodes racing for the lease — whichever wins becomes `role:
"writer"` (check each container's startup log line); the other becomes `role: "sync"`. Point a
client at either `http://localhost:3000` or `http://localhost:3001` — both serve the same
reactive data. To see failover, `docker compose kill stackbase-a` (whichever one won the race)
and watch `stackbase-b`'s logs / a live subscription kept open against it: it keeps working
throughout, and a mutation sent to it starts committing locally once it promotes.

**Note:** unlike the base single-node compose file (smoke-tested against a real container), this
2-node example is not itself run through a container smoke test in this slice — the fleet
runtime is proven end-to-end via real `stackbase serve --fleet` processes spawned directly (see
`ee/packages/fleet/test/fleet-e2e.test.ts`), not via Docker Compose specifically. If your built
image can't resolve `@stackbase/fleet`, install it explicitly per the fail-fast message above.

### Plain-processes variant (no Docker)

The same idea without containers — run on two machines/terminals sharing one Postgres:

```bash
# Node A
STACKBASE_ADMIN_KEY=secret STACKBASE_DATABASE_URL=postgres://... \
  stackbase serve --dir convex --fleet --advertise-url http://host-a:3000 --port 3000

# Node B
STACKBASE_ADMIN_KEY=secret STACKBASE_DATABASE_URL=postgres://... \
  stackbase serve --dir convex --fleet --advertise-url http://host-b:3000 --port 3000
```

## Behavior in detail

### Writes forwarded transparently

A sync node forwards any mutation, action, or `httpAction` request it receives to the current
writer over an internal, admin-key-authenticated endpoint, waits for the result, and relays it
back to the caller exactly as if it had executed locally. Queries and subscriptions are **never**
forwarded — every node always serves those from its own connection to the shared Postgres
database.

### Failover timing and in-flight requests

- A dead writer's Postgres session — and its advisory lock — is released as soon as Postgres
  notices the connection is gone. A sync node's lease-acquire retry loop polls every ~2 seconds,
  so failover typically completes within a couple of seconds and up to roughly 10 seconds in the
  worst case, not longer. This has been proven end-to-end by killing a live writer with `SIGKILL`
  mid-test and observing a sync node promote and start serving writes.
- **Any mutation/action in flight against the dying writer at the moment it dies fails visibly**
  to its caller (a connection error, not a silent hang) — there is no in-flight request migration.
  Treat these the same way you'd treat any other transient network failure: **retry from the
  client/app**, the same way you'd already handle a dropped connection.
- Subscriptions on the *surviving* nodes are never affected by a writer failing over — they keep
  streaming from their own local connection to Postgres throughout.
- There is no demotion path: a writer that loses its Postgres session must exit (a process
  supervisor/Docker restarts it), after which it rejoins the fleet as a sync node. A running
  writer never voluntarily hands off the lease.

## Current limits

Be realistic about what this slice is and isn't:

- **Single writer.** Exactly one node executes mutations/actions at a time — write throughput is
  the throughput of one node, same as single-node Postgres self-hosting. Multi-writer/sharded
  writes are a later slice, not this one.
- **Sync nodes read the shared Postgres directly.** Every sync node holds its own connection to
  the same Postgres database and reads from it live — there's no embedded local replica yet. This
  is fine at a handful of nodes; an embedded log-tailed replica (removing primary read load at
  10+ nodes) is the next slice, a drop-in swap behind the same storage seam with no protocol
  changes.
- **No autoscaler.** You start and stop nodes yourself; there's no controller that adds/removes
  fleet nodes based on load.
- **No load balancer included.** Point clients directly at any node, or put your own load
  balancer/reverse proxy in front of the fleet — Stackbase doesn't ship one. (The same TLS-
  termination note from [Docker self-hosting](/self-hosting#reverse-proxy--tls) applies: front
  the fleet with nginx/Caddy/Traefik/your cloud LB if you need TLS or single-hostname routing.)
- **`ee/` licensing.** `@stackbase/fleet` lives under the commercial license (`ee/LICENSE`) — it's
  source-available and free to use in production today (no key gate in this phase), but it isn't
  under the same FSL-1.1-Apache-2.0 license as the rest of the repo. See [Business Model &
  Licensing](../../dev/business-model-and-licensing.md) for the framing; no pricing exists yet.

## Related

- [Docker Self-Hosting](/self-hosting) — the single-node baseline this builds on, including
  [Using Postgres](/self-hosting#using-postgres) (the storage backend a fleet requires).
- [`stackbase deploy`](/deploying) — live code push to an already-running `serve`. Works the same
  against a fleet's writer node; the component set and schema still apply fleet-wide since every
  node reads the same Postgres database.
- [Standalone Binary](/deploy/standalone-binary) — single-process compiled binary; not fleet-aware
  (a compiled binary is still one process, use `serve --fleet` for multi-node).

---
