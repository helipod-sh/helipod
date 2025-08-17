import type { Value } from "@stackbase/values";
import { getFunctionPath, type FunctionReference } from "@stackbase/client";
import { buildRuntime, type CreateTestOptions, type BuiltRuntime } from "./compose";
import type { TestSubscription } from "./reactivity";
import { finishScheduledFunctions, advanceTimers } from "./scheduler";

type Args = Record<string, Value>;

export interface TestStackbase {
  query<T = unknown>(ref: FunctionReference | string, args?: Args): Promise<T>;
  mutation<T = unknown>(ref: FunctionReference | string, args?: Args): Promise<T>;
  action<T = unknown>(ref: FunctionReference | string, args?: Args): Promise<T>;
  /**
   * Runs `fn` with a full db-writer `ctx` (the engine's `MutationCtx`, typed `any` here to avoid
   * leaking internal types) inside one real transaction — for test setup/assertions without
   * having to define an app function. Backed by the `_test:_run` system mutation. Always
   * privileged (no ambient identity), regardless of which view it's called on.
   */
  run<T>(fn: (ctx: any) => Promise<T>): Promise<T>;
  /**
   * Routes `request` through the app's `http.ts` router, exactly as the real `stackbase dev`/`serve`
   * HTTP handler dispatches to an `httpAction` (see `packages/cli/src/http-handler.ts`). Returns a
   * plain 404 `Response` for an unmatched method+path — it never throws for that case. This view's
   * identity (set via `withIdentity`) is passed through as the httpAction's `ctx` identity, taking
   * precedence over the request's own `Authorization` header if both are present.
   */
  fetch(request: Request): Promise<Response>;
  /**
   * Subscribes to a reactive query over the REAL client -> sync protocol -> SubscriptionManager ->
   * engine path (a loopback `StackbaseClient`, shared across every `subscribe` call on this
   * backend and every view of it — built lazily on first use, closed in `close()`). A committed
   * write re-runs and re-pushes only when its write set intersects this query's recorded read
   * set (surgical, range-based invalidation) — no polling.
   *
   * v1 limitation: always uses the base (no-identity) client, regardless of which view (see
   * `withIdentity`) `subscribe` is called on — there is no per-identity subscription yet.
   */
  subscribe<T = any>(ref: FunctionReference | string, args?: Args): TestSubscription<T>;
  /**
   * Returns a view of the SAME backend whose `query`/`mutation`/`action` calls carry `identity` as
   * the ambient session token (reaching user code only through a context provider's
   * `build({ identity })`, e.g. `components/auth`'s `ctx.auth` — there is no bare `ctx.identity`).
   * `run`/`close` remain shared with the backend, not per-view.
   */
  withIdentity(identity: string): TestStackbase;
  /**
   * Deterministically drives every currently- and eventually-due `ctx.scheduler.runAfter`/`runAt`
   * job (including cascades) to completion by advancing the harness's virtual clock — no real
   * timers/sleeps. A clean no-op if no `@stackbase/scheduler` component was composed (via
   * `opts.components`). Throws if `opts.now` was supplied to `createTestStackbase` (the harness
   * then doesn't own the clock). See `./scheduler.ts`.
   */
  finishScheduledFunctions(): Promise<void>;
  /**
   * Advances the harness's virtual clock by `ms` and drives one scheduler-driver pass (a no-op
   * pass if no scheduler is composed) — the one-shot counterpart to `finishScheduledFunctions`.
   * Throws if `opts.now` was supplied to `createTestStackbase`. See `./scheduler.ts`.
   */
  advanceTimers(ms: number): Promise<void>;
  close(): Promise<void>;
}

export async function createTestStackbase(opts: CreateTestOptions): Promise<TestStackbase> {
  const built: BuiltRuntime = await buildRuntime(opts);
  const { runtime } = built;

  function makeView(identity: string | null): TestStackbase {
    return {
      async query(ref, args = {}) {
        return (await runtime.run(getFunctionPath(ref), args as never, { identity })).value as never;
      },
      async mutation(ref, args = {}) {
        return (await runtime.run(getFunctionPath(ref), args as never, { identity })).value as never;
      },
      async action(ref, args = {}) {
        return (await runtime.runAction(getFunctionPath(ref), args as never, { identity })).value as never;
      },
      async run(fn) {
        built.setRunFn(fn as (ctx: unknown) => Promise<unknown>);
        try {
          await runtime.runSystem("_test:_run", {});
          return built.takeRunResult() as never;
        } finally {
          built.setRunFn(null);
        }
      },
      async fetch(request) {
        return built.dispatchHttp(request, identity);
      },
      subscribe(ref, args = {}) {
        return built.reactivity.subscribe(ref, args);
      },
      withIdentity(id) {
        return makeView(id);
      },
      async finishScheduledFunctions() {
        await finishScheduledFunctions(built);
      },
      async advanceTimers(ms) {
        await advanceTimers(built, ms);
      },
      async close() {
        await built.cleanup();
      },
    };
  }

  return makeView(null);
}
