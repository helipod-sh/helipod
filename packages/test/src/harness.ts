import type { Value } from "@stackbase/values";
import { getFunctionPath, type FunctionReference } from "@stackbase/client";
import { buildRuntime, type CreateTestOptions, type BuiltRuntime } from "./compose";

type Args = Record<string, Value>;

export interface TestStackbase {
  query<T = unknown>(ref: FunctionReference | string, args?: Args): Promise<T>;
  mutation<T = unknown>(ref: FunctionReference | string, args?: Args): Promise<T>;
  action<T = unknown>(ref: FunctionReference | string, args?: Args): Promise<T>;
  /**
   * Runs `fn` with a full db-writer `ctx` (the engine's `MutationCtx`, typed `any` here to avoid
   * leaking internal types) inside one real transaction — for test setup/assertions without
   * having to define an app function. Backed by the `_test:_run` system mutation.
   */
  run<T>(fn: (ctx: any) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function createTestStackbase(opts: CreateTestOptions): Promise<TestStackbase> {
  const built: BuiltRuntime = await buildRuntime(opts);
  const { runtime } = built;

  return {
    async query(ref, args = {}) {
      return (await runtime.run(getFunctionPath(ref), args as never)).value as never;
    },
    async mutation(ref, args = {}) {
      return (await runtime.run(getFunctionPath(ref), args as never)).value as never;
    },
    async action(ref, args = {}) {
      return (await runtime.runAction(getFunctionPath(ref), args as never)).value as never;
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
    async close() {
      await built.cleanup();
    },
  };
}
