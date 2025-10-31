import type { AnyFunctionReference } from "./function-types";

/**
 * The runtime `api` — a proxy that turns `api.messages.list` into a function reference whose
 * `__path` is `"messages:list"` (module path + function name). Typed as the generated `Api`
 * type, this is what `useQuery(api.messages.list, …)` passes. Nested modules join with `/`
 * (e.g. `api.admin.users.list` → `"admin/users:list"`).
 */
export interface FunctionReference {
  __path: string;
}

/**
 * T5's type reconciliation (verdict §(b), flagged latent by T3's report): this package's own
 * `FunctionReference` (`{ __path }`, above) and codegen's generated `Api` type (`FunctionReference<
 * Type, Vis, Args, Returns>` — `__type`/`__visibility`/`__args`/`__returns`, NO `__path` in its
 * TYPE) are structurally incompatible AT THE TYPE LEVEL ONLY. At runtime they are the exact same
 * object — every app's `_generated/server.ts` does `export const api = anyApi as Api`, and
 * `anyApi`'s `Proxy` answers any string property access, `__path` included. This union is the
 * bridge: every public entry point that accepts a function reference (`client.query`/`mutation`/
 * `subscribe`/`action`, `useQuery`/`useMutation`/`useAction`, `OptimisticLocalStore`) is typed
 * against `AnyFunctionRef` (or overloaded across its two members) so a generated typed `api` value
 * compiles wherever the client's own untyped `anyApi` value already did.
 */
export type AnyFunctionRef = FunctionReference | AnyFunctionReference<any, any> | string;

export function getFunctionPath(ref: AnyFunctionRef): string {
  return typeof ref === "string" ? ref : (ref as unknown as FunctionReference).__path;
}

function makeProxy(segments: string[]): unknown {
  return new Proxy(
    {},
    {
      get(_target, prop): unknown {
        if (typeof prop !== "string") return undefined;
        if (prop === "__path") {
          if (segments.length < 2) return segments.join(":");
          return `${segments.slice(0, -1).join("/")}:${segments[segments.length - 1]}`;
        }
        return makeProxy([...segments, prop]);
      },
    },
  );
}

/** The untyped api proxy; cast to your generated `Api` type at the import site. */
export const anyApi: unknown = makeProxy([]);
