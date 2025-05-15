/**
 * `StackbaseClient` — the reactive client. It manages query subscriptions (deduped by
 * path+args), applies the version-bracketed sync protocol via the shared client reducer, and
 * resolves mutations against their `MutationResponse`. Subscriptions are reactive: when the
 * server pushes a `Transition`, the affected query's listeners fire with the new value.
 */
import {
  applyServerMessage,
  createClientState,
  type ServerMessage,
  type SyncClientState,
} from "@stackbase/sync";
import { convexToJson, jsonToConvex, type JSONValue, type Value } from "@stackbase/values";
import { getFunctionPath, type FunctionReference } from "./api";
import type { ClientTransport } from "./transport";

export type QueryListener = (value: Value) => void;

interface Subscription {
  queryId: number;
  path: string;
  args: JSONValue;
  hash: string;
  value: Value | undefined;
  listeners: Set<QueryListener>;
}

export class StackbaseClient {
  private readonly transport: ClientTransport;
  private readonly state: SyncClientState = createClientState();
  private readonly subsByHash = new Map<string, Subscription>();
  private readonly subsById = new Map<number, Subscription>();
  private readonly pendingMutations = new Map<string, { resolve: (v: Value) => void; reject: (e: Error) => void }>();
  private readonly broadcastListeners = new Set<(topic: string, event: Value) => void>();
  private readonly disposeTransport: () => void;
  private nextQueryId = 1;
  private nextRequestId = 1;

  constructor(transport: ClientTransport) {
    this.transport = transport;
    this.disposeTransport = transport.onMessage((msg) => this.onServerMessage(msg));
  }

  /** Subscribe to a reactive query. `onUpdate` fires with the latest value (immediately if cached). */
  subscribe(ref: FunctionReference | string, args: Record<string, Value> = {}, onUpdate: QueryListener): () => void {
    const path = getFunctionPath(ref);
    const argsJson = convexToJson(args as Value);
    const hash = `${path}:${JSON.stringify(argsJson)}`;

    let sub = this.subsByHash.get(hash);
    if (!sub) {
      const queryId = this.nextQueryId++;
      sub = { queryId, path, args: argsJson, hash, value: undefined, listeners: new Set() };
      this.subsByHash.set(hash, sub);
      this.subsById.set(queryId, sub);
      this.transport.send({ type: "ModifyQuerySet", add: [{ queryId, udfPath: path, args: argsJson }], remove: [] });
    }
    sub.listeners.add(onUpdate);
    if (sub.value !== undefined) onUpdate(sub.value);

    return () => {
      const s = this.subsByHash.get(hash);
      if (!s) return;
      s.listeners.delete(onUpdate);
      if (s.listeners.size === 0) {
        this.transport.send({ type: "ModifyQuerySet", add: [], remove: [s.queryId] });
        this.subsByHash.delete(hash);
        this.subsById.delete(s.queryId);
      }
    };
  }

  /** One-shot read: subscribe, resolve with the first value, unsubscribe. */
  query(ref: FunctionReference | string, args: Record<string, Value> = {}): Promise<Value> {
    return new Promise((resolve) => {
      const unsubscribe = this.subscribe(ref, args, (value) => {
        resolve(value);
        queueMicrotask(unsubscribe);
      });
    });
  }

  /** Run a mutation; resolves with its return value (or rejects with its error). */
  mutation(ref: FunctionReference | string, args: Record<string, Value> = {}): Promise<Value> {
    const requestId = String(this.nextRequestId++);
    return new Promise<Value>((resolve, reject) => {
      this.pendingMutations.set(requestId, { resolve, reject });
      this.transport.send({ type: "Mutation", requestId, udfPath: getFunctionPath(ref), args: convexToJson(args as Value) });
    });
  }

  /** Publish an ephemeral event (presence/typing) — bypasses the engine. */
  publishEphemeral(topic: string, event: Value): void {
    this.transport.send({ type: "EphemeralPublish", topic, event: convexToJson(event) });
  }

  /** Listen for ephemeral broadcasts (presence/typing) from other clients. */
  onBroadcast(listener: (topic: string, event: Value) => void): () => void {
    this.broadcastListeners.add(listener);
    return () => this.broadcastListeners.delete(listener);
  }

  close(): void {
    this.disposeTransport();
    this.transport.close();
  }

  private onServerMessage(msg: ServerMessage): void {
    applyServerMessage(this.state, msg);
    switch (msg.type) {
      case "Transition": {
        for (const mod of msg.modifications) {
          if (mod.type === "QueryUpdated") {
            const sub = this.subsById.get(mod.queryId);
            if (sub) {
              sub.value = jsonToConvex(mod.value);
              for (const listener of sub.listeners) listener(sub.value);
            }
          }
        }
        return;
      }
      case "MutationResponse": {
        const pending = this.pendingMutations.get(msg.requestId);
        if (pending) {
          this.pendingMutations.delete(msg.requestId);
          if (msg.success) pending.resolve(jsonToConvex(msg.value));
          else pending.reject(new Error(msg.error));
        }
        return;
      }
      case "Broadcast": {
        const event = jsonToConvex(msg.event);
        for (const listener of this.broadcastListeners) listener(msg.topic, event);
        return;
      }
      default:
        return;
    }
  }
}
