# Wake seam — recurring drivers on a host that stops the process

**Date:** 2026-03-20
**Status:** Design approved, not yet implemented
**Slice:** Cloudflare compatibility (Tier 0 on Workers + Containers + R2)

## The problem

Cloudflare stops the container **~5 seconds after the last incoming request**. `sleepAfter` counts
incoming requests only — internal `setInterval`/`setTimeout` activity does not keep it alive.

So on Cloudflare today, `@stackbase/scheduler`, `@stackbase/triggers`, and `@stackbase/storage`'s
reaper **silently never fire**. `ctx.scheduler.runAfter(300_000, …)` schedules work into a process
that will not exist in 5 seconds. A cron set for 03:00 does not run unless traffic happens to arrive
at 03:00.

This is a **correctness break, not a performance issue** — and it is invisible until someone notices
their emails never sent.

### Measured context (2026-03-12/16, not speculation)

Everything below was proven against real Cloudflare and real R2 before this design was written:

| Claim | Evidence |
|---|---|
| R2 holds the single-writer lease | `packages/objectstore-s3/test/r2.conformance.test.ts` — 9/9 on real R2, incl. the 8-racer one-winner race and `assertCasSupported` (commit `aeb68cc`) |
| The substrate boots on R2 | `stackbase serve --object-store s3+https://…r2…` → `{"objectStore":true}`, health in 5s |
| Ephemeral disk is survivable | wiped the local materialized SQLite → rebooted → full rehydrate from R2, same `_id`/`_creationTime` |
| Cloudflare hosts the process | Worker → Container → `serve` → R2: `/api/health` ok, `lists:create` committed, read-back included a row written earlier **by a different machine** (a laptop) |
| Cold start | 7.3s first, 4.5s warm-image |
| **The gap** | container `Exited (0)` ~5s after last request **while drivers were ticking**. Graceful SIGTERM path worked unmodified. |

The `Exited (0)` is load-bearing: scale-to-zero **works** (falsifying the "always-on billing"
objection to Cloudflare), and it is the *same mechanism* that breaks the drivers. We want to keep the
economics and fix the correctness.

## The key discovery: the seam already exists

`DriverContext.setTimer(atMs, cb)` takes an **absolute wall-clock instant**, not a delay. That is
exactly `DurableObjectStorage.setAlarm(T)`'s shape. All three drivers already use it **exclusively** —
there is not one `setInterval` or direct `setTimeout` anywhere in the driver path. The scheduler passes
its `earliestFutureTs` to `setTimer` raw and unmodified; it is already an alarm timestamp.

The only gap: `EmbeddedRuntime` hardcodes `setTimeout` in its `DriverContext` factory
(`packages/runtime-embedded/src/runtime.ts:685-696`) with no injection point. `options.now` is already
injectable; `options.setTimer` simply is not.

**This is plumbing, not a new engine concept.** The "engine must never import a host primitive" locked
decision already did the hard part.

## Non-goals

- **Not** a `runtime-cloudflare` package. The engine gains a type and two optional options; the
  Cloudflare-specific code lives entirely in the deployment rig.
- **Not** a DO-SQLite docstore adapter. Deferred pending measurement — see "Open question" below.
- **Not** WebSocket hibernation. An idle subscription still stops the container; out of scope.
- **Not** a change to how next-wake is computed. Drivers already do that correctly.

## Design

### 1. The seam — `packages/component/src/define-component.ts`

```ts
/** A host's ability to wake the process at a wall-clock instant. The runtime multiplexes ALL driver
 *  timers down to ONE pending wake, so a host implements exactly one alarm — which is all a Durable
 *  Object has. */
export interface WakeHost {
  /** Arm a single wake at absolute `atMs`, replacing any prior. `null` = nothing pending. */
  armWake(atMs: number | null): void;
}
```

Plus one addition to the existing `DriverContext`:

```ts
  /** Cadence for a PURE BACKSTOP poll (not a next-work wake). A long-lived host returns `defaultMs`
   *  unchanged; a host where every wake costs a cold start may stretch it. The CALL SITE is the tag:
   *  calling this is how a driver declares "this timer is a backstop, not real work". */
  backstopMs(defaultMs: number): number;
```

**Why absolute, not a delay.** A delay forces the runtime to compute `T - now()` and the host to add
it back, across two clocks that disagree — a hibernating DO's process clock may have skipped hours. An
absolute instant keeps one source of truth. It also means a timer armed by *yesterday's* process is
correctly already-overdue when today's process re-peeks. A delay-based seam would restart the countdown
on every cold boot, so repeated sleeps could defer a job forever — an intermittent production-only bug.

### 2. The multiplexer — `packages/runtime-embedded/src/runtime.ts`

The `timers` map stays. `setTimer`/`clearTimer` keep their exact signatures — **no driver changes**.

- Each `setTimer`/`clearTimer` recomputes `min(atMs)` across live handles.
- **Only if the minimum moved**, call `wakeHost.armWake(min)`. A driver arming far-future timers must
  not thrash the host's schedule.
- New `runtime.fireDueTimers()`: run every timer with `atMs <= now()`, drop them, re-arm to the new min.

`EmbeddedRuntimeOptions` gains:

```ts
  wakeHost?: WakeHost;                        // default: setTimeout-based (today's behavior)
  backstopMs?: (defaultMs: number) => number; // default: identity
```

**Both default to current behavior, so every existing deployment is byte-for-byte unchanged.**

A DO has exactly one alarm but there are up to N+3 live timers; multiplexing is generic, so it lives
once in the runtime and no host re-implements it.

### 3. Backstop cadence — one line each

`components/scheduler/src/driver.ts` (`SWEEP_MS`), `components/triggers/src/driver.ts` (`BEAT_MS`),
and `packages/storage/src/reaper.ts` (`sweepMs`) read `ctx.backstopMs(X)` instead of the constant.

These three are **fixed-interval pollers**, not next-work wakes:

| Timer | Cadence | Purpose |
|---|---|---|
| scheduler `sweepTimer` | 30s | backstop: reclaims jobs orphaned by an infra kill |
| triggers `beatTimer` | 30s | the **only** thing that notices `triggers:resume` (its own control-table writes are deliberately not reacted to, else cursor bookkeeping self-wakes forever) |
| storage reaper | 60s | sweeps orphaned bytes |

On a long-lived process they are free. On Cloudflare each one is an alarm → a container wake → a **4.5s
cold start**, every 30s, forever: a ~15% duty cycle for a completely idle app, destroying the
scale-to-zero property we just proved.

Cloudflare sets `backstopMs: (d) => Math.max(d, 15 * 60_000)`. Duty cycle drops from ~15% to <1%.

**Accepted cost, to be documented:** un-pausing a trigger via `triggers:resume` takes up to ~15 minutes
on Cloudflare instead of ~30 seconds.

### 4. The Cloudflare host — deployment rig only

**Arm (container → DO)** via **Outbound Workers** (`@cloudflare/containers` ≥ 0.2.0, shipped
2026-03-26). The container issues a plain `fetch` to a magic hostname; the request never leaves the
Workers runtime — it is intercepted and turned into a DO call. No public URL, no shared secret, no
internet round trip. `ctx.containerId` yields the container's own DO for free:

```ts
// In the container (the WakeHost impl) — one line:
armWake: (atMs) => void fetch("http://wake.do/arm", { method: "POST", body: String(atMs ?? "") })

// In the Worker:
StackbaseContainer.outboundByHost = {
  "wake.do": async (request, env, ctx) => {
    const id = env.STACKBASE.idFromString(ctx.containerId);
    return env.STACKBASE.get(id).armWake(await request.text());
  },
};
```

**Fire (DO → container):**

```ts
async armWake(atMs: string) {
  await this.schedule(new Date(Number(atMs)), "driverWake");  // NOT alarm()
}
async driverWake() {
  await this.containerFetch("/_admin/wake");   // boots the container if stopped
}
```

**Landmine, verbatim from Cloudflare's docs:** *"Do not override `alarm()` directly. The `Container`
class uses the alarm handler to manage the container lifecycle, so use `schedule()` instead."*
Overriding `alarm()` silently breaks lifecycle management.

`/_admin/wake` is an engine-side endpoint calling `runtime.fireDueTimers()`. It cannot be a direct call:
`fireDueTimers()` lives in the container's process, across a network boundary from the DO. The same
request that fires the timers is also what **boots** the container — one mechanism, both jobs.

### 5. CLI wiring — how `serve` is told to use a wake host

`wakeHost` is a JS closure, but the container runs the **shipped `stackbase serve` binary** inside a
built image. The rig cannot inject a closure into it. So the Cloudflare `WakeHost` must be
**constructible from configuration**, exactly like `--object-store` / `--database-url` already are.

`packages/cli` gains two config inputs (flag or env, flag wins — mirroring `objectStoreUrl`'s existing
shape in `serve.ts:275,301`):

| Config | Meaning |
|---|---|
| `--wake-url <url>` / `STACKBASE_WAKE_URL` | Unset → no wake host, `setTimeout` default (every existing deployment). Set → `serve` builds an HTTP `WakeHost` that POSTs the absolute `atMs` to that URL. On Cloudflare: `http://wake.do/arm`. |
| `--backstop-min-ms <n>` / `STACKBASE_BACKSTOP_MIN_MS` | Unset → identity (30s/60s stay). Set → `backstopMs = (d) => Math.max(d, n)`. On Cloudflare: `900000`. |

Both are injected as container env vars by the rig's `Container.envVars`, alongside
`STACKBASE_OBJECT_STORE`, so nothing Cloudflare-specific is baked into the image. The image stays the
generic `stackbase serve`; only its environment differs.

`serve` also registers **`POST /_admin/wake`** → `runtime.fireDueTimers()`, gated behind the same
`STACKBASE_ADMIN_KEY` bearer check as the rest of the admin router. On Cloudflare the DO holds the key
(it already injects it) and the route is unreachable from the public internet regardless, since the
Worker fronts every request.

**The HTTP `WakeHost` is fire-and-forget**: `armWake` returns `void` (the driver must not block on a
network hop), so the POST is issued without awaiting and a failure is logged, not thrown. A lost arm
degrades to a missed wake, which self-heals per the error table below.

## Data flow

Steady state (a cron due at 03:00, no traffic all night):

```
t=0     request → container boots → drivers start()
        scheduler wake() → peeks tables → earliestFutureTs = 03:00
        ctx.setTimer(03:00, cb)
          → runtime: min moved → wakeHost.armWake(03:00)
          → fetch("http://wake.do/arm") → DO: schedule(03:00, "driverWake")   [durable]

t=5s    no more requests → Cloudflare stops the container   [Exited(0)]
        DO stays alive. Alarm armed at 03:00.

03:00   DO alarm → driverWake() → containerFetch("/_admin/wake")
          → container COLD STARTS (4.5s) → drivers start() → wake()
          → re-peeks tables → job due → dispatches → re-arms → armWake(next)
```

Two paths through `/_admin/wake`, no branching in the host:

| Container state | What happens |
|---|---|
| **Stopped** (common) | The fetch *boots* it. `start()→wake()` does the work. `fireDueTimers()` finds nothing — harmless no-op. |
| **Running** | `fireDueTimers()` runs the actual pending callback, drops it, re-arms to the new min. |

Multiplexing: scheduler job at 03:00, beat at 03:10, reaper at 03:12 →

```
setTimer(03:00) → min 03:00 → armWake(03:00)      ← one alarm, earliest wins
setTimer(03:10) → min unchanged → no re-arm
setTimer(03:12) → min unchanged → no re-arm
03:00 fires → fireDueTimers() runs it → min now 03:10 → armWake(03:10)
```

## Error handling

**No shutdown flush is needed, and none is added.** `armWake` fires **eagerly at arm time**, not at
death — by the time Cloudflare stops the container, the alarm is already durable in the DO. Next-wake is
also *derivable from committed table state*: on restart, `start()` calls `wake()`, which re-peeks and
re-arms. The information never needed to survive the process.

| Failure | Behavior |
|---|---|
| SIGKILL / container killed | Nothing lost. The alarm was armed eagerly and lives in the DO. |
| DO evicted | DO storage + alarms are durable; survives eviction, redeploys, runtime updates. |
| Wake fails (`containerFetch` throws — image pull, boot crash) | Alarm handler throws → Cloudflare retries. Work deferred, never dropped. |
| Stale/early wake | `fireDueTimers()` finds nothing due, re-arms to real min, exits. Cheap. |
| Missed wake entirely | Self-heals: any later request boots the container → `start()→wake()` → dispatches anything overdue. The durable table state is the truth; the alarm only decides *when to look*. |
| `armWake` POST fails (fire-and-forget) | Logged, not thrown — a driver must never block or fail on a network hop. Degrades to a missed wake (row above). The next arm re-pushes the min. |
| `--wake-url` set but unreachable | Every arm logs a failure; drivers still run whenever the process is awake. Loud in logs, not silently broken. |
| Clock skew across a sleep | Absolute instants; an overdue timer dispatches immediately, which is correct. |
| `triggers:resume` while asleep | Noticed within `backstopMs` (~15min on Cloudflare). Documented cost. |

**Known latent trap (not fixed by this design, flagged for the plan):**
`runtime.ts:1180-1188` `stopDriversInternal()` clears every timer **before** calling any `driver.stop?.()`.
So a driver can never observe its own pending wake at shutdown. This design does not need it
(next-wake is re-derived), but anyone who later assumes a `stop()` hook can flush timer state will find
it already destroyed. Fix if touched: move the `clearTimeout` loop *after* the `stop()` loop.

**Fleet/multi-shard:** drivers already follow the DEFAULT_SHARD lease ("drivers follow the default
shard", `ee/packages/fleet/src/node.ts:1278-1289`) — one driver set per deployment, not per shard, and
`objectStoreShards` does not fan them out. On a DO the DO *is* the singleton, so the election machinery
simply does not engage. No changes needed.

## Testing

**Unit — `packages/runtime-embedded`, fake `WakeHost`:**
- three timers → `armWake` called once with the min
- arming a *later* timer → no re-arm
- clearing the min → re-arms to the next
- `fireDueTimers()` → runs only due timers, re-arms the remainder
- `backstopMs` default is identity

This closes a **real existing gap**: nothing currently proves a `setTimer` fires and does work. The E2Es
deliberately exercise only the reactive `onCommit` path (5–8s budgets vs 30–60s timers), so the
fixed-interval paths are unit-tested only via `__tick()`/`__wake()` against a faked `DriverContext`.

**Component:** a host returning `d * 30` stretches the beat; the driver still functions.

**E2E through the real rig** (the flagship — the only test that proves the actual claim):

```
deploy → commit a job due in ~60s
       → let the container STOP (assert: zero running containers)
       → stay SILENT
       → assert the job fired
       → assert the container was woken by the ALARM, not by a request
```

The silence is the test. A harness that polls `/api/health` while waiting keeps the container alive and
passes for the wrong reason. This mirrors the existing scheduler E2E's own discipline — it bans
`__tick()`/`__wake()` precisely so dispatch must happen via the shipped server's reactive wake. Same
principle, new axis: **never let the test supply the thing you are trying to prove exists.**

## Deploy-anywhere check

- `packages/component`: gains a type + one `DriverContext` method.
- `packages/runtime-embedded`: two optional options, both defaulting to today's behavior.
- three components: one constant → one function call each.
- `packages/cli`: two optional config inputs + one admin route. Unset → identical to today.
- **No `DurableObjectNamespace` anywhere in `packages/` or `components/`.** Cloudflare-specific code
  lives only in the deployment rig. Engine-side, Cloudflare does not exist — `serve` knows only "POST an
  integer to a URL", which any host can implement.

Fly / Railway / Docker / VPS / single-binary keep plain `setTimeout` and 30s/60s backstops, byte-for-byte
unchanged.

## Open question — deferred to measurement, not decided here

**Cloudflare write latency.** Every commit is a CAS PUT to the R2 manifest; lunora writes to DO SQLite,
a local file in the same isolate. Reads are fast for both (local materialized SQLite), but **single-write
latency on Cloudflare is structurally worse for us, and no design fixes it** — it is the definition of
"object storage is the linearization point". Group commit (shipped) batches concurrent writes into one
CAS, helping throughput but not single-write latency.

The 1.2s/op measured during the R2 conformance run was **WAN from a laptop in Asia to R2** and is not
the real number. The real number — container→R2 from inside Cloudflare — is unmeasured.

**Decision: measure first.** After this slice lands, deploy a real project and measure actual
container→R2 write latency. Only then decide between (a) accept it — portability is the product and we
remain fastest everywhere else (8.6ms p50 vs Convex's 13.4ms, same substrate), or (b) add a DO-SQLite
docstore adapter — fastest on Cloudflare, but that deployment's data can never move, and it is a second
storage path to maintain forever.

Do not decide (b) without the number.

## References

- Seam: `packages/component/src/define-component.ts:33-85`
- Multiplex point: `packages/runtime-embedded/src/runtime.ts:655-697`
- Drivers: `components/scheduler/src/driver.ts:74-91,176-184,200-209`;
  `components/triggers/src/driver.ts:34,250-256,263-275`; `packages/storage/src/reaper.ts:6,41,74`
- Shutdown: `packages/cli/src/serve.ts:623-645` → `runtime.ts:1180-1188`
- Fleet election: `ee/packages/fleet/src/node.ts:1278-1289,761`
- Existing E2Es: `packages/cli/test/scheduler-e2e.test.ts:17,109`; `packages/cli/test/triggers-e2e.test.ts`
- R2 gate: `packages/objectstore-s3/test/r2.conformance.test.ts` (commit `aeb68cc`)
- Cloudflare: [Container class](https://developers.cloudflare.com/containers/container-class/)
  (`schedule()`, `onStart`/`onStop`, the "do not override `alarm()`" warning);
  [Outbound Workers](https://developers.cloudflare.com/changelog/post/2026-03-26-outbound-workers/);
  [DO Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
