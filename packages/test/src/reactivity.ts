import { HelipodClient, loopbackTransport, getFunctionPath, type FunctionReference } from "@helipod/client";
import type { EmbeddedRuntime } from "@helipod/runtime-embedded";
import type { Value } from "@helipod/values";

export interface TestSubscription<T> {
  /** Latest computed value, or `undefined` until the first compute arrives. */
  value(): T | undefined;
  /** Registers a listener fired on every reactive re-run (and the first compute); returns a remover. */
  onChange(cb: (v: T) => void): () => void;
  /** Tears down the underlying query subscription. */
  unsubscribe(): void;
}

/**
 * Lazily-built, harness-shared reactive subscription surface. Exercises the REAL
 * client -> sync protocol -> SubscriptionManager -> engine invalidation path over an in-process
 * loopback connection (`runtime.connect()` + `loopbackTransport`) — the same wiring
 * `examples/chat/test/chat.test.ts` uses. ONE `HelipodClient` is shared across every
 * `t.subscribe(...)` call from a given harness instance; it's built on first use and closed via
 * `close()` (called from `BuiltRuntime.cleanup` before `stopDrivers`).
 */
export interface Reactivity {
  // Defaults to `any` (not `unknown`) so an unannotated `t.subscribe(...)` call still lets test
  // code chain straight off `.value()` (e.g. `sub.value()?.length`) without an explicit type
  // argument — matching the ergonomics of `t.query`/`t.mutation`'s own `T = unknown` defaults
  // would force every caller to annotate just to read a property off the result.
  subscribe<T = any>(ref: FunctionReference | string, args?: Record<string, Value>): TestSubscription<T>;
  close(): Promise<void>;
}

export function createReactivity(runtime: EmbeddedRuntime): Reactivity {
  let client: HelipodClient | null = null;

  function ensureClient(): HelipodClient {
    if (!client) client = new HelipodClient(loopbackTransport(runtime.connect()));
    return client;
  }

  return {
    subscribe<T>(ref: FunctionReference | string, args: Record<string, Value> = {}): TestSubscription<T> {
      const path = getFunctionPath(ref);
      let latest: T | undefined;
      const listeners = new Set<(v: T) => void>();

      const unsubscribeClient = ensureClient().subscribe(path, args, (v) => {
        latest = v as T;
        for (const listener of listeners) listener(latest as T);
      });

      return {
        value: () => latest,
        onChange(cb) {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
        unsubscribe() {
          unsubscribeClient();
        },
      };
    },
    async close() {
      if (client) {
        client.close();
        client = null;
      }
    },
  };
}
