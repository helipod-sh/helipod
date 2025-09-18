# Write-Sharding Research Corpus (2025-08-28)

Raw outputs of the 10-agent adversarial research workflow (wf_5951700e-904) that produced the
**Fenced Frontier** verdict. Orientation/decision layer:
[`../../architecture/write-sharding-research.md`](../../architecture/write-sharding-research.md).

| Phase | File | Agent |
|---|---|---|
| Evidence | [evidence-modern-systems.md](evidence-modern-systems.md) | web sweep: TiDB TSO, CRDB closed ts, Spanner, FoundationDB, Calvin/VoltDB, Kafka, Vitess/Citus |
| Evidence | [evidence-ancestors.md](evidence-ancestors.md) | clean-room study of `.reference/` (concave, Lunora, convex-backend) — describe-only, no code copied |
| Evidence | [evidence-invariants.md](evidence-invariants.md) | file:line audit of our own global-ts assumptions (MUST-HOLD / MAY-RELAX lists) |
| Design | [design-a-central-order.md](design-a-central-order.md) | "One Line, Many Hands" — central order, parallel execute |
| Design | [design-b-shard-logs.md](design-b-shard-logs.md) | per-shard logs, frontier versions |
| Design | [design-c-sequenced-batches.md](design-c-sequenced-batches.md) | "Sequenced Epochs" — deterministic batch ordering |
| Debate | [critique-correctness.md](critique-correctness.md) | falsified Design A as written; supplied the fencing-first repair |
| Debate | [critique-performance.md](critique-performance.md) | latency/contention/frontier-economics attacks |
| Debate | [critique-dx-deploy.md](critique-dx-deploy.md) | tier-uniformity, footguns, buildability attacks |
| Verdict | [**verdict.md**](verdict.md) | **the canonical Fenced Frontier protocol** + slice plan B1–B5 + open questions |
