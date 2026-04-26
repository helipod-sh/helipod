# @stackbase/runtime-cloudflare

The single-shard **Cloudflare Durable Object host** for Stackbase — Slice 3 of the DO-native program
(`docs/superpowers/specs/2026-03-20-do-host-slice3-design.md`). A **leaf host package**: every
Cloudflare shape lives here (as narrow structural interfaces) and in the deploy rig; nothing below it
(`runtime-embedded`/`transactor`/`sync`) ever references a Cloudflare type.

## The one-DO design (decision 1)

`StackbaseDurableObject` is a **unified** Durable Object: one object owns the OCC writer, the DO-SQLite
store (`ctx.storage.sql`), the hibernatable WebSockets, the subscription index (the union of every
live socket's attachment), and the wake alarm (`ctx.storage.setAlarm`). Because the writer and the
subscription index are the **same object**, a mutation's reactive fan-out is an **in-process call in
the same turn** — so the engine's shipped **G1/G4 frontier-ordering guarantees survive by
construction** (there is no RPC hop to reorder across). The transactor-DO/sync-DO split is deferred to
Slice 6; `notifyWrites` stays a single named in-process method so that split is a later swap, not a
rewrite.

```ts
import { StackbaseDurableObject, createWorkerHandler } from "@stackbase/runtime-cloudflare";
// (a real app uses the codegen'd worker.ts — see the rig)
export class StackbaseDO extends StackbaseDurableObject {
  appConfig(env) { return { loaded, components, adminKey: env.STACKBASE_ADMIN_KEY }; }
}
export default createWorkerHandler("STACKBASE_DO");
```

## Load-bearing decisions

- **16 KB attachment stores the subscription DEFINITION, not the read-set** (decision 2). On revival
  the query is re-run to re-derive the read-set — reusing the shipped subscription-resume tokens.
  Overflow is bounded by a **per-socket cap** (`MAX_SUBSCRIPTIONS_PER_SOCKET`, a `QueryFailed`, never a
  silent truncation).
- **Eager rehydrate-all-on-wake** (decision 3): every hibernated socket's session is reconstructed
  from its attachment before serving, so a fan-out's read-set intersection never misses a subscriber.
- **App code is statically bundled** (decision 4): `generateWorkerEntrySource` emits static imports of
  every module/schema/config (no dir-scan in a DO), the twin of `stackbase build`'s entrypoint codegen.
- **Fan-out stays INLINE, never `waitUntil`-deferred** (decision 5) — deferring would let a
  `MutationResponse` beat its own G4 origin-frontier advance.
- **Process-shaped timers disarmed** (decision 6): the DO socket omits `ping` and the runtime boots
  with `disableSyncBackgroundTimers`, so the handler arms no `setInterval` sweep or per-session ping
  heartbeat (both fight DO hibernation / scale-to-zero); keepalive moves to `setWebSocketAutoResponse`.

## Not built here (deliberate)

The transactor/sync DO split (Slice 6), file-storage byte I/O on a DO (§8.9), and the outbound
fingerprint capture that would make rehydrate a `QueryUnchanged` rather than a full re-send (a bandwidth
optimization; rehydrate is correct without it).

## Test fidelity

| Tier | Runtime | What it proves | Command |
|---|---|---|---|
| Node API-shape (`test/`) | Node + DO-SQLite stand-in | boot, health, run+read-back, subscribe→commit→push, hibernation-rehydrate, cap, wake, neutrality, codegen | `bun run test` |
| **real workerd** (`test-workers/`) | workerd via `@cloudflare/vitest-pool-workers` | `DoSqliteAdapter` on **real** DO-SQLite (`runInDurableObject`); the DO host serve→subscribe→commit→push over a **real WebSocket** inside a **real DO** | `bun run test:workers` |
| real Cloudflare (`rig/`) | deployed DO | latency vs container→R2, real hibernation | deploy-ready-but-unrun — see `rig/README.md` |
