# docs/dev — Engineering & Architecture

Internal engineering docs for **building** Stackbase. (End-user product docs live in [`docs/enduser/`](../enduser/index.md) — keep the two separate.)

## Start here

- **[Architecture: System Design (North Star)](./architecture/system-design.md)** — the synthesized Stackbase architecture: the reactive-transaction core primitive, the storage seam, and the tiered (lightweight → scalable) model that reconciles all four design goals.
- **[Business Model & Licensing (locked decision)](./business-model-and-licensing.md)** — free now / gate scale later: everything free to win adoption, then a paid license key unlocks scaling up (deploy anywhere, BYO cloud — the n8n/GitLab-EE model, no mandatory cloud). FSL from day one; paid `ee/` under a separate license; set the license now, add the paywall later.

## Scaling & deployment

- [Deployment Topologies & the TypeScript-vs-Rust Question](./architecture/deployment-and-language.md) — the deployment matrix (single binary · npm without Docker · Docker · a DigitalOcean droplet · Railway/Fly · edge), the whole-system language decision ("could we have used Rust? could users still use it like a package?"), how the single binary scales, and an honest snapshot of what ships vs. what's designed.
- [Scalability Spectrum](./architecture/scalability-spectrum.md) — Tier 0 → Tier 2, per-conversation write sharding, the connection-sharded sync fleet, and the seams the Foundation must reserve.
- [Scaling Reality](./architecture/scaling-reality.md) — the numbers-grounded answer to "won't a JS/Bun engine fall over at WhatsApp-class connection counts?" (the connection-tier half of the language question).

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
