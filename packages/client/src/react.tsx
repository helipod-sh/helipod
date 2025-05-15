/**
 * React bindings — `useQuery` subscribes a component to a reactive query (re-rendering on
 * every server push), `useMutation` returns a callback that runs a mutation. The headline DX:
 * a component that calls `useQuery(api.messages.list, { conversationId })` updates live when
 * anyone sends a message, with zero manual wiring.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { convexToJson, type Value } from "@stackbase/values";
import { StackbaseClient } from "./client";
import { getFunctionPath, type FunctionReference } from "./api";

const ClientContext = createContext<StackbaseClient | null>(null);

export function StackbaseProvider(props: { client: StackbaseClient; children: ReactNode }) {
  return <ClientContext.Provider value={props.client}>{props.children}</ClientContext.Provider>;
}

export function useStackbaseClient(): StackbaseClient {
  const client = useContext(ClientContext);
  if (!client) throw new Error("useStackbaseClient must be used within <StackbaseProvider>");
  return client;
}

function argsKey(ref: FunctionReference | string, args: Record<string, Value>): string {
  return `${getFunctionPath(ref)}|${JSON.stringify(convexToJson(args as Value))}`;
}

/** Subscribe to a reactive query; returns `undefined` until the first result arrives. */
export function useQuery<T = Value>(ref: FunctionReference | string, args: Record<string, Value> = {}): T | undefined {
  const client = useStackbaseClient();
  const [value, setValue] = useState<Value | undefined>(undefined);
  const key = argsKey(ref, args);

  useEffect(() => {
    setValue(undefined);
    const unsubscribe = client.subscribe(ref, args, (v) => setValue(v));
    return unsubscribe;
    // `key` captures ref+args identity; re-subscribe only when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key]);

  return value as T | undefined;
}

/** Returns a callback that runs a mutation and resolves with its return value. */
export function useMutation<T = Value>(
  ref: FunctionReference | string,
): (args?: Record<string, Value>) => Promise<T> {
  const client = useStackbaseClient();
  const path = getFunctionPath(ref);
  return useCallback((args: Record<string, Value> = {}) => client.mutation(ref, args) as Promise<T>, [client, path]);
}
