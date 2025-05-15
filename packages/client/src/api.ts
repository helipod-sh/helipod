/**
 * The runtime `api` — a proxy that turns `api.messages.list` into a function reference whose
 * `__path` is `"messages:list"` (module path + function name). Typed as the generated `Api`
 * type, this is what `useQuery(api.messages.list, …)` passes. Nested modules join with `/`
 * (e.g. `api.admin.users.list` → `"admin/users:list"`).
 */
export interface FunctionReference {
  __path: string;
}

export function getFunctionPath(ref: FunctionReference | string): string {
  return typeof ref === "string" ? ref : ref.__path;
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
