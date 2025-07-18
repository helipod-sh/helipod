# docs/dev — Engineering & Architecture

Internal engineering docs for **building** Stackbase. (End-user product docs live in [`docs/enduser/`](../enduser/index.md) — keep the two separate.)

## Start here

- **[Architecture: System Design (North Star)](./architecture/system-design.md)** — the synthesized Stackbase architecture: the reactive-transaction core primitive, the storage seam, and the tiered (lightweight → scalable) model that reconciles all four design goals.

## Reference research

How the systems we draw from actually work, and the one transferable idea from each:

- [Comparison & Transferable Ideas](./research/comparison.md) — the decision-grade matrix; **read this second**.
- [Convex](./research/convex.md) — reactive read-set/write-set core; runs on plain SQLite/Postgres (not FoundationDB).
- [concave](./research/concave.md) — narrow timestamp-aware storage seam; storage-independent sync tier; deploy anywhere.
- [SpacetimeDB](./research/spacetimedb.md) — in-memory hot path, incremental subscription eval, binary deltas; why it's fast.
- [Supabase](./research/supabase.md) — schema-as-source-of-truth + RLS; and the operational weight to avoid.
- [PocketBase](./research/pocketbase.md) — single binary + embedded SQLite; the lightweight tier.
- [Lunora](./research/lunora.md) — the closest *shipped* prior art (Convex-style backend on Cloudflare DOs, alpha); client-sync playbook (watermarks, bookmark resume, offline), poke/membership-diff protocol, advisory guardrails. Authz-specific deep-dive lives in [`components/authz/docs/research.md`](../../components/authz/docs/research.md).

## The design goals (user brief)

Convex-like **DX** · PocketBase-like **lightweight** · SpacetimeDB-like **fastest realtime** · concave-like **deploy-anywhere at lowest cost** · **scalable**. These conflict; the system design resolves them with a **tiered architecture** (same app code from single-binary to distributed).

## How this fits the workflow

`docs/dev/` (research + architecture) → per-slice design specs in `docs/superpowers/specs/` → implementation. See the repo `CLAUDE.md` for locked decisions and build order. Raw upstream reference material is in `.reference/`.
