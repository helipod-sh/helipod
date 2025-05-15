/**
 * The client-side reducer: applies `ServerMessage`s to local state. It enforces the
 * version-bracket contract — a `Transition` is applied only if its `startVersion` matches the
 * client's current version; otherwise a frame was missed and the client must **resync from
 * scratch**. This is what makes server-side frame drops (backpressure) safe. The real client
 * SDK (M10) builds on this.
 */
import type { JSONValue } from "@stackbase/values";
import { versionsEqual, INITIAL_VERSION, type ServerMessage, type StateVersion } from "./protocol";

export interface MutationOutcome {
  success: boolean;
  value?: JSONValue;
  error?: string;
}

export interface SyncClientState {
  version: StateVersion;
  queries: Map<number, JSONValue>;
  needsResync: boolean;
  mutationResults: Map<string, MutationOutcome>;
  broadcasts: Array<{ topic: string; event: JSONValue }>;
}

export function createClientState(): SyncClientState {
  return {
    version: { ...INITIAL_VERSION },
    queries: new Map(),
    needsResync: false,
    mutationResults: new Map(),
    broadcasts: [],
  };
}

export function applyServerMessage(state: SyncClientState, msg: ServerMessage): void {
  switch (msg.type) {
    case "Transition": {
      if (!versionsEqual(msg.startVersion, state.version)) {
        state.needsResync = true; // missed a frame → resync from scratch
        return;
      }
      for (const mod of msg.modifications) {
        if (mod.type === "QueryUpdated") state.queries.set(mod.queryId, mod.value);
        else if (mod.type === "QueryRemoved") state.queries.delete(mod.queryId);
        // QueryFailed: leave the previous value; a real client would surface the error.
      }
      state.version = msg.endVersion;
      return;
    }
    case "MutationResponse":
      state.mutationResults.set(
        msg.requestId,
        msg.success ? { success: true, value: msg.value } : { success: false, error: msg.error },
      );
      return;
    case "Broadcast":
      state.broadcasts.push({ topic: msg.topic, event: msg.event });
      return;
    default:
      return;
  }
}
