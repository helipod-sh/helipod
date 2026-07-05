/**
 * The DO's `WakeHost` — the firing seam for `@helipod/scheduler`/`@helipod/triggers` drivers on a
 * host that hibernates between requests. Implements `armWake(atMs)` via `ctx.storage.setAlarm`, the
 * single durable alarm a Durable Object offers (`docs/superpowers/specs/2026-03-20-do-alarm-driver-seam-design.md`).
 *
 * The runtime multiplexes ALL live driver timers down to ONE pending wake (`min(atMs)`) and hands it
 * here, so a DO's single alarm is exactly enough. `armWake` is fire-and-forget by contract (a driver
 * must never block on it), so an async `setAlarm` is issued without awaiting and a failure is logged,
 * not thrown — a lost arm degrades to a missed wake, which self-heals (the next request boots the DO,
 * `start()`→`wake()` re-derives + re-arms from durable table state).
 *
 * The DO's `alarm()` handler (in `durable-object.ts`) fires `runtime.fireDueTimers()`. Unlike the
 * Cloudflare Container class, a plain Durable Object MAY override `alarm()` directly — the "do not
 * override alarm()" landmine is specific to `@cloudflare/containers`, which uses the alarm for
 * container lifecycle. A DO-native host owns its alarm outright.
 */
import type { WakeHost } from "@helipod/component";
import type { DurableObjectStorageLike } from "./cf-types";

export class DoAlarmWakeHost implements WakeHost {
  constructor(private readonly storage: DurableObjectStorageLike) {}

  armWake(atMs: number | null): void {
    try {
      if (atMs === null) {
        void Promise.resolve(this.storage.deleteAlarm()).catch((e) => this.logArmFailure(e));
        return;
      }
      // `setAlarm` replaces any prior alarm — exactly the "one pending wake, earliest wins" the
      // runtime's multiplexer already guarantees before it calls us.
      void Promise.resolve(this.storage.setAlarm(atMs)).catch((e) => this.logArmFailure(e));
    } catch (e) {
      // A synchronous throw from `setAlarm`/`deleteAlarm` (unexpected) must not propagate into a
      // driver's `setTimer` call. Degrade to a missed wake, self-healed by the next request.
      this.logArmFailure(e);
    }
  }

  private logArmFailure(e: unknown): void {
    console.error("[runtime-cloudflare] wake armWake failed (degrades to a missed wake, self-heals):", e);
  }
}
