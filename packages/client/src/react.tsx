/**
 * React bindings — `useQuery` subscribes a component to a reactive query (re-rendering on
 * every server push), `useMutation` returns a callback that runs a mutation. The headline DX:
 * a component that calls `useQuery(api.messages.list, { conversationId })` updates live when
 * anyone sends a message, with zero manual wiring.
 *
 * T5 adds `useMutation(ref).withOptimisticUpdate(fn)` (Convex-verbatim chaining, verdict §(b)) and
 * threads T3's `FunctionArgs`/`FunctionReturnType` generics through all three hooks: passing a
 * codegen-generated ref (`api.messages.send`, typed against the app's `_generated/api.d.ts`) infers
 * typed args/return; the client's own untyped `{ __path }` ref or a raw string path fall back to
 * the pre-existing `Record<string, Value>`/`Value` shape with an explicit `T` override, unchanged.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { convexToJson, type Value } from "@helipod/values";
import { HelipodClient, type PendingMutationEntry } from "./client";
import { getFunctionPath, type AnyFunctionRef, type FunctionReference } from "./api";
import type { AnyFunctionReference, FunctionArgs, FunctionReturnType } from "./function-types";
import type { OptimisticLocalStore } from "./optimistic-store";
import type { OptimisticUpdate } from "./layered-store";

const ClientContext = createContext<HelipodClient | null>(null);

export function HelipodProvider(props: { client: HelipodClient; children: ReactNode }) {
  return <ClientContext.Provider value={props.client}>{props.children}</ClientContext.Provider>;
}

export function useHelipodClient(): HelipodClient {
  const client = useContext(ClientContext);
  if (!client) throw new Error("useHelipodClient must be used within <HelipodProvider>");
  return client;
}

function argsKey(ref: AnyFunctionRef, args: Record<string, Value>): string {
  return `${getFunctionPath(ref)}|${JSON.stringify(convexToJson(args as Value))}`;
}

/** Subscribe to a reactive query; returns `undefined` until the first result arrives. */
export function useQuery<Q extends AnyFunctionReference<any, any>>(ref: Q, args?: FunctionArgs<Q>): FunctionReturnType<Q> | undefined;
export function useQuery<T = Value>(ref: FunctionReference | string, args?: Record<string, Value>): T | undefined;
export function useQuery(ref: AnyFunctionRef, args: Record<string, Value> = {}): unknown {
  const client = useHelipodClient();
  const [value, setValue] = useState<Value | undefined>(undefined);
  const key = argsKey(ref, args);

  useEffect(() => {
    setValue(undefined);
    const unsubscribe = client.subscribe(ref as FunctionReference | string, args, (v) => setValue(v));
    return unsubscribe;
    // `key` captures ref+args identity; re-subscribe only when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key]);

  return value;
}

/** The optimistic-update closure a `withOptimisticUpdate` call receives — the typed public store. */
export type OptimisticUpdateHandler<Args> = (store: OptimisticLocalStore, args: Args) => void;

/**
 * The callable `useMutation` returns: calling it runs the mutation; `.withOptimisticUpdate(fn)`
 * returns a NEW callable with `fn` bound (Convex-verbatim — it does not mutate the receiver, so
 * `useMutation(ref)` itself stays reusable without an optimistic update).
 */
export interface MutationCallback<Args = Record<string, Value>, Returns = Value> {
  (args?: Args): Promise<Returns>;
  withOptimisticUpdate(updater: OptimisticUpdateHandler<Args>): MutationCallback<Args, Returns>;
}

/**
 * Builds one mutation callable. A `WeakMap` cache keyed by the `updater` function reference lives
 * inside this closure (persisted across renders via the `useMemo` below) — calling
 * `.withOptimisticUpdate(sameUpdaterRef)` again on a later render returns the SAME bound callable
 * (identity does not churn) as long as the caller's `updater` reference is itself stable (e.g.
 * module-scoped or `useCallback`-memoized); a fresh inline closure every render churns by
 * necessity — there is no way to detect two closures are "the same update" without a reference.
 */
function createMutationCallback<Args, Returns>(
  client: HelipodClient,
  path: string,
  updater?: OptimisticUpdateHandler<Args>,
): MutationCallback<Args, Returns> {
  const withUpdateCache = new WeakMap<OptimisticUpdateHandler<Args>, MutationCallback<Args, Returns>>();
  const call = ((args?: Args) =>
    client.mutation(
      path,
      (args ?? {}) as Record<string, Value>,
      updater ? { optimisticUpdate: updater as unknown as OptimisticUpdate } : {},
    ) as Promise<Returns>) as MutationCallback<Args, Returns>;
  call.withOptimisticUpdate = (next: OptimisticUpdateHandler<Args>) => {
    let bound = withUpdateCache.get(next);
    if (!bound) {
      bound = createMutationCallback<Args, Returns>(client, path, next);
      withUpdateCache.set(next, bound);
    }
    return bound;
  };
  return call;
}

/** Returns a callable that runs a mutation and resolves with its return value; `.withOptimisticUpdate(fn)` chains an optimistic update (verdict §(b)). */
export function useMutation<Q extends AnyFunctionReference<any, any>>(
  ref: Q,
): MutationCallback<FunctionArgs<Q>, FunctionReturnType<Q>>;
export function useMutation<T = Value>(ref: FunctionReference | string): MutationCallback<Record<string, Value>, T>;
export function useMutation(ref: AnyFunctionRef): MutationCallback<any, any> {
  const client = useHelipodClient();
  const path = getFunctionPath(ref);
  return useMemo(() => createMutationCallback(client, path), [client, path]);
}

/** Returns a callback that runs an action and resolves with its return value. Not reactive — mirrors `useMutation`, not `useQuery`. */
export function useAction<Q extends AnyFunctionReference<any, any>>(ref: Q): (args?: FunctionArgs<Q>) => Promise<FunctionReturnType<Q>>;
export function useAction<T = Value>(ref: FunctionReference | string): (args?: Record<string, Value>) => Promise<T>;
export function useAction(ref: AnyFunctionRef): (args?: Record<string, Value>) => Promise<Value> {
  const client = useHelipodClient();
  const path = getFunctionPath(ref);
  return useCallback((args: Record<string, Value> = {}) => client.action(path, args), [client, path]);
}

/**
 * T5 (R9) — a live snapshot of the durable outbox: `[]` until the first read resolves (and forever,
 * without an `outbox` configured — `HelipodClient.pendingMutations()`'s own no-outbox behavior).
 * Re-reads on every `client.onOutboxChange` notification — every local outbox-mutating op AND, when
 * a `BroadcastChannel` is available, an incoming cross-tab nudge from ANOTHER tab sharing the same
 * durable store (verdict §(d) "Observability": "usePendingMutations() reactive... a BroadcastChannel
 * nudge cross-tab"). See `docs/enduser/offline.md`'s pending-tray recipe for the documented pattern
 * (`packages/client/test/pending-tray-recipe.test.tsx` is its compiling fixture).
 */
export function usePendingMutations(): PendingMutationEntry[] {
  const client = useHelipodClient();
  const [entries, setEntries] = useState<PendingMutationEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void client.pendingMutations().then((next) => {
        if (!cancelled) setEntries(next);
      });
    };
    refresh();
    const unsubscribe = client.onOutboxChange(refresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [client]);

  return entries;
}

// Reactive in-app inbox helper (@helipod/notifications) — see ./notifications.
export { useNotifications, Inbox, useNotificationPreferences, registerForPush, unregisterForPush } from "./notifications";
export type { InboxNotification, UseNotificationsResult, InboxProps, NotificationPreference, UseNotificationPreferencesResult } from "./notifications";
