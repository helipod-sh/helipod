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

**Slice 2** adds an embedded local replica to every sync node, so reads no longer touch the
shared database at all: each sync node tails the shared write log into a local, file-backed
SQLite replica and serves every query and subscription from it. The primary's per-sync-node
load drops to a single tail cursor. Mutations/actions still forward to the writer and commit
through Postgres exactly as in slice 1 — this is a read-path change only.

## What it is

- **Symmetric nodes.** Every node runs `stackbase serve --fleet ...` with the same flags. The
  first node to acquire the shared **write lease** (a Postgres advisory lock, discoverable via a
  `fleet_lease` row) becomes the **writer**; every other node is a **sync node**.
- **Connect to any node.** A client can open its WebSocket / HTTP connection to *any* node in the
  fleet. Queries and subscriptions are always served **locally** by whichever node the client is
  connected to — on a sync node this means its own embedded local replica (see [Reads served from
  a local replica](#reads-served-from-a-local-replica) below), never a round-trip to Postgres.
  Mutations, actions, and `httpAction` requests are transparently **forwarded** to the current
  writer if they land on a sync node — the client never needs to know or care which node is the
  writer.
- **Reactive updates cross the process boundary.** When the writer commits, it `NOTIFY`s the
  shared Postgres database; every sync node's replica tailer is `LISTEN`ing (with a 1-second poll
  fallback if a `NOTIFY` is ever missed) and applies the newly-committed batch to its local
  replica, derives the invalidation, and re-runs/pushes affected subscriptions — the write log
  itself is always the source of truth, so a missed notification costs latency, never a missed
  update.
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
- **A unique data directory per node.** A sync node now keeps its own local replica file
  alongside its SQLite data path — at `<dir>/fleet-replica.db`, where `<dir>` is the directory
  containing whatever `--data`/`STACKBASE_DATA_DIR` you gave it (see [Reads served from a local
  replica](#reads-served-from-a-local-replica) below). Every node in the fleet must point at its
  own directory — this is not currently validated, so two nodes sharing a data directory will
  silently stomp each other's replica file (and each other's SQLite file, if not on Postgres)
  rather than fail fast. Give each node's `--data`/`STACKBASE_DATA_DIR` its own path, the same way
  you'd already isolate two ordinary `stackbase serve` processes.

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

### Reads served from a local replica

Every sync node runs a small **replica tailer** that follows the shared Postgres write log and
applies each committed batch, verbatim, onto a local file-backed replica at
`<dir>/fleet-replica.db` — where `<dir>` is the directory holding whatever `--data`/
`STACKBASE_DATA_DIR` path you gave the node (the same directory a non-fleet `serve` would put its
SQLite file in). It's a plain embedded SQLite store, the same storage engine single-node
self-hosting uses, just fed by the tail instead of by local writes. All queries and subscriptions
on that node are served entirely from this local file; the node's connection to Postgres is used
**only** to pull the next batch of committed writes, never to answer a read. This is what removes
the slice-1 concern about primary read load growing with fleet size — a sync node's load on the
shared database is one tail cursor, not a live connection serving arbitrary reads.

- **New nodes catch up before reporting ready.** A brand-new node (or one whose replica file was
  deleted) starts its replica from scratch and replays the write log before its startup line
  prints `"ready":true` — first boot against a large existing log takes longer than a warm
  restart. There's no partial-ready state: a sync node either serves the full, caught-up dataset
  or hasn't reported ready yet.
- **Restarts resume, they don't replay.** A sync node restarted against the *same* data directory
  reopens its existing replica file and resumes tailing from its own last-applied position — this
  is fast, not a full re-bootstrap.
- **The replica file is safe to delete.** It's a rebuildable mirror, never a source of truth.
  Delete `<dir>/fleet-replica.db` (and its `-wal`/`-shm` sidecars, if present) and restart the
  node — it re-bootstraps cleanly from the primary's log, the same as a first boot. A corrupted
  replica file (e.g. from a hard crash mid-write) is handled the same way automatically: the node
  detects the failure to open it, deletes it, and rebuilds once before giving up.
- **A replica file from a different deployment is detected and rebuilt automatically.** Every
  deployment stamps a one-time identity marker on the primary the first time it boots a writer,
  and every sync node mirrors that stamp onto its own replica file (this can't happen via the
  tail — it's a direct local write). If a replica file ever gets reused against a *different*
  primary — a data directory copied between environments, or reattached to a different database —
  the mismatch (or an old replica that predates this check) is caught the moment the node boots:
  it's deleted and rebuilt from the current primary before serving a single read, the same
  automatic recovery as a corrupted file. There's nothing to configure or clean up by hand.

### Read-your-own-writes

A mutation's success response, from **any** node, carries a guarantee: an immediate follow-up read
against **that same node** sees the write. Concretely — send a mutation to sync node B (which
forwards it to the writer and gets back a committed result), then immediately query B, and you're
guaranteed to see the write, even though B answers that query from its own local replica rather
than from Postgres. Internally this works by having the node wait for its local replica to catch
up to the mutation's commit before returning the mutation's result to the caller, bounded at 5
seconds — if the replica hasn't caught up within that window, the mutation still returns rather
than hanging, and in that rare case an immediately-following read could be stale.

**This guarantee covers `action` calls too, including their inner writes.** An action's own
top-level response has no single commit of its own — but the engine tracks the highest commit
timestamp across everything the action wrote via its inner `ctx.runMutation`/`ctx.runAction` calls
(recursively — an action calling another action picks up that inner action's own writes too) and
carries it on the action's response. The forwarding node waits on that same timestamp before
returning, exactly as it does for a plain mutation — same 5-second bound, same same-node guarantee.
An action that performs no writes at all (a pure read, or one that only calls other actions/queries
that don't write) simply has nothing to wait on, and its response returns as soon as the handler
completes.

### Reads keep working through a Postgres outage; writes don't

If the shared Postgres database becomes unreachable (network partition, restart, maintenance),
sync nodes keep answering queries and live subscriptions keep pushing updates — they're reading
from their own local replica file, which needs nothing from Postgres to serve a read it has
already tailed. This is proven end-to-end by pausing (`docker pause`) the underlying Postgres
container mid-test: a sync node's reads and an already-open subscription both keep working
throughout the outage.

Writes do not share this tolerance. A mutation forwarded to the writer during the outage fails
visibly (the writer's own commit hangs against the unreachable database, so the caller sees a
bounded failure, not a silent success or an indefinite hang) rather than being queued or served
stale. Once Postgres comes back, the writer resumes committing and the fleet reconverges
automatically — no manual restart needed.

Be precise about what this means: it's read availability, not general high availability.
Fleet mode's outage tolerance is reads-survive/writes-fail — don't describe it as HA beyond that.

### Writes forwarded transparently

A sync node forwards any mutation, action, or `httpAction` request it receives to the current
writer over an internal, admin-key-authenticated endpoint, waits for the result, and relays it
back to the caller exactly as if it had executed locally. Queries and subscriptions are **never**
forwarded — every node always serves those locally, from its own embedded replica on a sync node
or directly on the writer (see [Reads served from a local
replica](#reads-served-from-a-local-replica) above).

### Slow clients

This isn't fleet-specific — it applies to every node's WebSocket connections — but matters more
in a fleet where a node may be fanning updates out to more connections. A client whose connection
can't keep up with pushed updates (a slow network, a backgrounded tab) doesn't grow the server's
memory without bound: its outbound updates queue up to a cap, and past that cap the server starts
dropping the newest update rather than queuing indefinitely. A dropped update isn't lost data —
the client SDK detects the resulting gap and automatically resyncs (re-subscribes its live queries
from scratch) the next time it hears from the server, with no app code involved. A connection that
stops responding entirely (not just slow, actually gone) is detected and closed by a periodic
heartbeat, freeing its resources. None of this requires manual intervention.

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
  streaming from their own local embedded replica throughout.
- **Writer self-exit is real, not aspirational.** There is no demotion path — a running writer
  never voluntarily hands off the lease, so the only way it stops being the writer is by exiting.
  A dropped Postgres connection is detected immediately (the advisory lock lives on that
  connection and is released by Postgres the instant it goes away); a connection that goes
  silently wedged instead of erroring is caught by a backstop liveness probe within a few seconds.
  Either way the process exits within seconds of losing the lease — a process supervisor (Docker's
  `restart: unless-stopped`, systemd, Kubernetes, etc.) restarts it, and it rejoins the fleet as a
  fresh sync node. A promotion that fails partway through (a Postgres error while it's catching
  its write oracle up, for example) exits the same way, rather than leaving the node stuck
  half-promoted.

## Current limits

Be realistic about what this slice is and isn't:

- **Single writer.** Exactly one node executes mutations/actions at a time — write throughput is
  the throughput of one node, same as single-node Postgres self-hosting. Multi-writer/sharded
  writes are a later slice, not this one.
- **A sync node's data-directory uniqueness isn't validated.** Nothing stops you from accidentally
  pointing two nodes at the same `--data`/`STACKBASE_DATA_DIR` directory — see
  [Requirements](#requirements) above. Get this wrong and both nodes' replica state corrupts
  silently rather than failing fast at boot.
- **Read availability, not full HA.** Sync nodes keep serving reads/subscriptions through a
  Postgres outage, but writes still fail during one — see [Reads keep working through a Postgres
  outage; writes don't](#reads-keep-working-through-a-postgres-outage-writes-dont) above. There's
  still exactly one writer and no write-side failover faster than the lease timing described above.
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
