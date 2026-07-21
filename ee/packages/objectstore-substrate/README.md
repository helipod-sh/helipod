# @helipod/objectstore-substrate

Object-storage substrate for Helipod: the durable commit log and manifests live in an object store (S3-compatible or filesystem), while each node keeps a local SQLite database as a queryable cache — storage/compute separation with no standalone database server.

## License

Source-available under the Helipod Commercial License (see the LICENSE file in this package). In the current phase it is free to use in production — no license key is required. It may not be copied, modified, or distributed as part of a product or service that competes with Helipod, and it does not convert to an open-source license.

## What it provides

- **Durable log + manifests in object storage.** Commits are encoded as immutable segments; a manifest object is the source of truth for the log's tip. Local SQLite holds the same data in queryable form and is rebuildable from the bucket.
- **Writer fencing via CAS manifests.** A writer holds a lease (kept alive by a heartbeat driver) and advances the log with compare-and-swap on the manifest, so a stale writer is fenced out (`FencedError`, graceful shutdown) instead of corrupting the log. A crashed writer's lease expires on its own and the next boot takes over.
- **Sharded lanes.** A single node can own multiple object-storage lanes (`--shards N`), partitioning writes across per-shard logs, with an offline reshard path (`reshardObjectStore`) to change the count on a stopped deployment.
- **Replica serving.** Read-only replicas tail the bucket's log into their own local SQLite and serve queries and reactive subscriptions from it, optionally forwarding mutations to the writer.
- **Garbage collection.** A background GC driver compacts and reclaims superseded segments (cadence via `HELIPOD_OBJECTSTORE_GC_MS`, default ~60 s).

## Usage

Install alongside `helipod` in the project you deploy:

```sh
bun add helipod @helipod/objectstore-substrate
```

Object-store mode is activated by `helipod serve --object-store <url>` (or `HELIPOD_OBJECT_STORE`; the flag wins). The CLI has no static dependency on this package — it loads `@helipod/objectstore-substrate` via dynamic import when `--object-store` is set and fails fast with an actionable message if it is not installed. `--object-store` is mutually exclusive with `--fleet`.

Accepted URL forms:

```sh
helipod serve --object-store file:///data/objects            # filesystem (a bare path also works)
helipod serve --object-store s3://key:secret@minio:9000/helipod-objects
helipod serve --object-store "s3:///my-bucket?region=us-west-2"   # AWS S3, credentials from env
```

`s3+http://` / `s3+https://` pin the endpoint protocol; credentials fall back to `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`. Run the writer with `--shards N` for multiple lanes, and point read nodes at the same bucket with `--replica` (plus `--writer-url <url>` to forward writes).

Part of [Helipod](https://github.com/helipod-sh/helipod) — docs at https://helipod-six.vercel.app/docs
