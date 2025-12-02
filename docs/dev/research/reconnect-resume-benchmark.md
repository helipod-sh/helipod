# Subscription Resume Benchmark — reconnect bytes and time-to-answered

**Status:** RECORDED (2025-11-28). Measures the bandwidth/latency effect of the subscription-resume
fingerprint (`resultHash`/`QueryUnchanged`, design
[`2025-11-28-subscription-resume-design.md`](../../superpowers/specs/2025-11-28-subscription-resume-design.md)):
on reconnect, a client echoes its last-known server-minted hash for each still-subscribed query; if
the server's fresh re-run hashes the same, it replies with a tiny `QueryUnchanged` frame instead of
resending the full value.

**Harness:** `packages/cli/test/bench-resume-ws.test.ts` — a real `startDevServer` (in-memory
SQLite) sits behind a controllable TCP proxy (mirrors `outbox-e2e.test.ts`'s `makeProxy`); one real
`StackbaseClient` over a real WebSocket (`ws` package) subscribes to 50 queries, each returning one
row from a 50-group table whose `data` field is padded so each query's JSON result spans ~2KB
(group 0) to ~10KB (group 49). The proxy's live TCP pair is killed to force a disconnect; the
client's own `webSocketTransport` reconnect (exponential backoff, tuned to 25–150ms for a fast test)
reopens the socket and replays `resync()` — ONE `ModifyQuerySet` frame carrying all 50 live
subscriptions (each echoing its `resultHash` unless stripped), answered by ONE `Transition` frame
whose `modifications` array covers all 50. Bytes are counted at a frame-capturing transport wrapper:
every incoming `ServerMessage` is re-encoded with the exact function the server sends through
(`encodeServerMessage`, `@stackbase/sync`) and its UTF-8 byte length summed, from the moment the
proxy kills the connection until all 50 query ids have appeared in a `QueryUpdated` or
`QueryUnchanged` modification. Wall time is `performance.now()` from the same start point to the
same all-answered condition.

Two matrix cells, same client code, same data, same reconnect trigger:

- **fingerprints ON** — the normal client; `resync()` echoes each subscription's `resultHash`.
- **fingerprints OFF** — the identical client wrapped in a transport that strips `resultHash` from
  outgoing `ModifyQuerySet` frames before they reach the socket. No client API change; this is the
  "as if the client had never sent a hash" baseline (today's pre-resume byte-for-byte behavior),
  isolating the fingerprint's effect from everything else in the reconnect path (backoff, `Connect`
  handshake — absent here, no outbox configured — socket re-open cost).

Re-run: `STACKBASE_BENCH_RESUME=1 bun run --filter @stackbase/cli test -- bench-resume-ws` (or
`bunx vitest run test/bench-resume-ws.test.ts` from `packages/cli` with the env set). Without the
env the file's suite is skipped entirely (asserted in the task run).

## Results

One run of the matrix, N = 50 subscriptions, results ~2–10KB each (50-group table, one padded row
per group):

| | bytes (resume window) | frames | time-to-all-answered |
|---|---:|---:|---:|
| fingerprints ON  |     2 052 | 1 | ~17–26 ms |
| fingerprints OFF |   310 882 | 1 | ~19–24 ms |
| **Δ** | **-308 830 (-99.3%)** | 0 | noise-level |

Bytes are exactly reproducible run-to-run (deterministic payload, deterministic hash match/miss);
three repeated runs all landed on `2052` / `310882` bytes. Time-to-answered was noisy in both
directions across repeated runs (~17–26ms either way) and did **not** show a directionally clear win
for the ON cell at N=50 — at this scale, one round trip carrying either a ~2KB or a ~310KB frame over
a loopback TCP proxy is dominated by reconnect/backoff/socket-open overhead, not by payload
serialization or transmission time. The wall-clock win from a smaller frame would be expected to grow
with N (more subscriptions ⇒ bigger OFF payload) and with real network latency/bandwidth (a loopback
proxy on one machine has effectively unlimited bandwidth) — this harness does not vary either axis;
see "Reproduce with a bigger N" below if a future pass wants that curve.

Both cells resolve in exactly **1 frame** — the server batches every query in one `ModifyQuerySet`
into a single `Transition` reply (`SyncProtocolHandler.doModifyQuerySet` builds one `modifications`
array for the whole `add` list), so this benchmark's "frames" axis is a fixed point at N=50, not a
per-cell variable — the bandwidth number is the entire story here.

## Why 99.3%, and what that number is (and isn't)

50 subscriptions × ~2–10KB values ≈ 310KB of `QueryUpdated` payload today. With nothing changed
between subscribe and reconnect, every one of those 50 re-runs hashes identically to what the client
already has — so `QueryUnchanged{queryId}` (a few dozen bytes, mostly JSON structural overhead) is
correct and sufficient. The 99.3% figure is close to a ceiling case (zero writes during the
disconnect window): a real deployment's reconnect will usually see a mix of unchanged and changed
subscriptions, so production savings will sit somewhere between this ceiling and 0% depending on how
much data actually moved while the client was offline. The `resume-e2e.test.ts` correctness suite
(Task 3, sibling to this benchmark) covers the mixed case functionally (one query mutated while
disconnected resumes as full `QueryUpdated`, the rest `QueryUnchanged`); this benchmark only
measures the all-unchanged ceiling, deliberately, to isolate the fingerprint mechanism's maximum
effect.

## The honest note: this is a bandwidth win only

**Compute is unchanged.** Every subscription still fully re-executes its query handler and re-hashes
the fresh result on every resubscribe — `QueryUnchanged` only replaces the outgoing *value* with a
tiny marker once that re-run's hash matches what the client already has; it does not skip the
re-run itself. Server CPU/IO cost of a resume with fingerprints ON is the same as with them OFF (the
same 50 query re-executions happen either way) — this slice buys network bytes, not compute. Saving
the *compute*, too — e.g. retaining a subscription's prior read-set across a disconnect and only
re-running queries whose read-set a commit during the gap actually touched, true watermark/resume —
is the explicit **v2 seam** this design is forward-compatible with (documented as a non-goal in the
design spec); it is not attempted here, and this benchmark does not measure it.

## Machine context (caveats — read before comparing numbers)

- **Hardware:** Apple M-series (arm64), macOS (Darwin 25.3.0). A developer laptop, not a quiesced
  bench box — treat the byte numbers as exact (they're deterministic) but the millisecond numbers
  as ±a lot at this tiny scale.
- **Runtime:** Node v24.14.1, vitest 2.1.9 (this suite runs under Node — see the project's
  "tests run under Node" convention; the `ws` npm package stands in for the platform `WebSocket`).
- **Store:** in-memory SQLite (`NodeSqliteAdapter`) — query re-execution cost itself is not what
  this benchmark measures (see the compute note above); it only affects how fast the server can
  answer the resubscribe, not the size of the answer.
- **Network:** a loopback TCP proxy on the same machine — effectively zero latency and unbounded
  bandwidth. The measured bytes transfer to any deployment unchanged (they're wire-protocol bytes);
  the measured milliseconds do not — a real network's higher latency/lower bandwidth would make the
  99.3%-smaller frame's time advantage far more visible than it is here.
- **N is fixed at 50** with one reconnect trial per cell (matching the design spec's Testing §4:
  "N=50 subscriptions with realistic payloads... measure... with and without fingerprints", run
  once). Bytes are exactly reproducible at this N regardless of trial count; time was independently
  sanity-checked over 3 repeated runs (noted above) rather than folded into the recorded table.

## Reproduce

```bash
# the resume bandwidth/time matrix (opt-in, ~1-2s)
STACKBASE_BENCH_RESUME=1 bun run --filter @stackbase/cli test -- bench-resume-ws
```

The ungated `bun run test` does not run this file's contained `it` at all (the whole `describe` is
`.skip`ped without the env) — it is not part of the CI-fast smoke suite.

---
_Raw: `{"n":50,"payloadRangeBytes":[2000,10000],"cells":{"fingerprintsOn":{"bytes":2052,"frames":1,"timeMsSamples":[25.59,25.67,23.42,16.74]},"fingerprintsOff":{"bytes":310882,"frames":1,"timeMsSamples":[19.30,24.36,18.92,22.35]}},"bandwidthSavingsPct":99.3,"note":"compute unchanged both cells — every subscription still fully re-runs and re-hashes on resubscribe; this measures bytes-on-the-wire only, not server CPU/IO. Retained-read-set / true watermark resume (saving the re-run itself) is the deferred v2 compute seam."}`_
