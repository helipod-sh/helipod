import type { Value } from "@stackbase/values";
import { getFunctionPath, type FunctionReference } from "@stackbase/client";
import { buildRuntime, type CreateTestOptions, type BuiltRuntime } from "./compose";

type Args = Record<string, Value>;

export interface TestStackbase {
  query<T = unknown>(ref: FunctionReference | string, args?: Args): Promise<T>;
  mutation<T = unknown>(ref: FunctionReference | string, args?: Args): Promise<T>;
  action<T = unknown>(ref: FunctionReference | string, args?: Args): Promise<T>;
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
    async close() {
      await built.cleanup();
    },
  };
}
