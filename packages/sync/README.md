# @helipod/sync

The WebSocket sync tier of the Helipod engine: reactive query subscriptions and the
protocol that serves them.

This package implements the version-bracketed sync protocol, the subscription manager
that tracks each session's live queries, and the protocol handler that re-runs and
pushes query results when a committed write intersects a subscription's recorded read
set — range-precise invalidation, so a write only wakes the subscriptions whose data
it actually touched. It also handles reconnect resume (unchanged results are
acknowledged with a small marker instead of resent, and briefly disconnected
subscriptions can skip re-execution entirely) and per-session backpressure so a slow
client cannot stall the engine.

It talks only to abstract socket and executor interfaces, so the same code serves an
embedded single-process engine or a multi-node deployment.

> This is an internal package of the Helipod engine. Most applications should install
> [`helipod`](https://www.npmjs.com/package/helipod) instead.

Part of [Helipod](https://github.com/helipod-sh/helipod) — docs at https://helipod-six.vercel.app/docs

License: FSL-1.1-Apache-2.0
