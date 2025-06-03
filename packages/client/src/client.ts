/**
 * `StackbaseClient` — the reactive client. It manages query subscriptions (deduped by
 * path+args), applies the version-bracketed sync protocol via the shared client reducer, and
 * resolves mutations against their `MutationResponse`. Subscriptions are reactive: when the
 * server pushes a `Transition`, the affected query's listeners fire with the new value.
 */
import { versionsEqual, INITIAL_VERSION, type ServerMessage, type StateModification, type StateVersion } from "@stackbase/sync";
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
  private version: StateVersion = { ...INITIAL_VERSION };
  private resyncing = false;
  private readonly subsByHash = new Map<string, Subscription>();
  private readonly subsById = new Map<number, Subscription>();
  private readonly pendingMutations = new Map<string, { resolve: (v: Value) => void; reject: (e: Error) => void }>();
  private readonly broadcastListeners = new Set<(topic: string, event: Value) => void>();
  private readonly disposeTransport: () => void;
  private readonly disposeClose: () => void;
  private nextQueryId = 1;
  private nextRequestId = 1;

  constructor(transport: ClientTransport) {
    this.transport = transport;
    this.disposeTransport = transport.onMessage((msg) => this.onServerMessage(msg));
    this.disposeClose = transport.onClose(() => this.onTransportClosed());
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

  /** Set (or clear) the session identity for this connection; the server re-runs subscriptions under it. */
  setAuth(token: string | null): void {
    this.transport.send({ type: "SetAuth", token });
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
    this.disposeClose();
    this.transport.close();
    this.onTransportClosed();
  }

  private onServerMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "Transition": {
        // While resyncing, adopt the next transition as the new baseline (its modifications are
        // the full re-subscribed results) regardless of its start version.
        if (this.resyncing) {
          this.applyModifications(msg.modifications);
          this.version = msg.endVersion;
          this.resyncing = false;
          return;
        }
        // Version-bracket guard: a non-contiguous start means a frame was dropped. Do NOT
        // deliver the (post-gap) values — resync from scratch instead, preserving correctness.
        if (!versionsEqual(msg.startVersion, this.version)) {
          this.resync();
          return;
        }
        this.applyModifications(msg.modifications);
        this.version = msg.endVersion;
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

  private applyModifications(modifications: StateModification[]): void {
    for (const mod of modifications) {
      if (mod.type === "QueryUpdated") {
        const sub = this.subsById.get(mod.queryId);
        if (sub) {
          sub.value = jsonToConvex(mod.value);
          for (const listener of sub.listeners) listener(sub.value);
        }
      }
      // QueryRemoved / QueryFailed: keep the last known value; a real UI would surface the error.
    }
  }

  /** A frame was missed: reset and re-subscribe all live queries; adopt the server's next state. */
  private resync(): void {
    this.resyncing = true;
    this.version = { ...INITIAL_VERSION };
    const subs = [...this.subsById.values()];
    if (subs.length === 0) {
      this.resyncing = false;
      return;
    }
    this.transport.send({
      type: "ModifyQuerySet",
      add: subs.map((s) => ({ queryId: s.queryId, udfPath: s.path, args: s.args })),
      remove: [],
    });
  }

  private onTransportClosed(): void {
    // Never leave a mutation promise hanging when the connection drops.
    for (const [, pending] of this.pendingMutations) pending.reject(new Error("connection closed"));
    this.pendingMutations.clear();
  }
}
