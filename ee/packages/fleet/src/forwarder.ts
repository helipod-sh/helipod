/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * `WriteForwarder` — the non-writer side of the fleet write path. Implements the engine's
 * `WriteRouter` seam: when this node is NOT the writer, every mutation/action entry point calls
 * `forward()`, which POSTs the call to whichever node currently holds the write lease
 * (`/_fleet/run`) and returns its JSON result. On promotion the node flips to `role="writer"` via
 * `promote()` and `isLocalWriter()` starts returning true, so writes execute locally instead.
 *
 * The forwarder learns the writer's URL from the `fleet_lease` discovery row (via `LeaseManager`),
 * never from static config — so a failover to a new writer is picked up by re-reading the lease.
 */
import type { WriteRouter } from "@stackbase/runtime-embedded";
import type { JSONValue } from "@stackbase/values";
import type { LeaseManager } from "./lease";

/** Strip a single trailing slash so `${writerUrl}/_fleet/run` never doubles up (`//_fleet/run`). */
function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export interface WriteForwarderOptions {
  /** Admin bearer token — the `/_fleet/run` endpoint authenticates with the deployment admin key. */
  adminKey: string;
  /** This node's own advertised URL (recorded on the lease when/if it becomes the writer). */
  selfUrl: string;
}

export class WriteForwarder implements WriteRouter {
  private role: "sync" | "writer" = "sync";

  constructor(
    private readonly lease: LeaseManager,
    private readonly opts: WriteForwarderOptions,
  ) {}

  /** Flip to writer: subsequent writes execute locally (isLocalWriter → true). Called on promotion. */
  promote(): void {
    this.role = "writer";
  }

  isLocalWriter(): boolean {
    return this.role === "writer";
  }

  async forward(
    kind: "mutation" | "action",
    path: string,
    args: JSONValue,
    identity: string | null,
  ): Promise<JSONValue> {
    const body = { path, args, identity, kind };
    const first = await this.writerUrl();
    try {
      return await this.post(first, body);
    } catch (firstErr) {
      // The writer may have changed (failover) OR the connection blipped — re-read the lease and
      // retry exactly once against the (possibly new) writer URL. The second attempt's error, if
      // any, propagates with the writer's own error message.
      let second: string;
      try {
        second = await this.writerUrl();
      } catch {
        throw firstErr;
      }
      return await this.post(second, body);
    }
  }

  /** Discover the current writer URL from the lease discovery row. */
  private async writerUrl(): Promise<string> {
    const state = await this.lease.read();
    if (!state) throw new Error("fleet: no writer lease found — cannot forward write");
    return state.writerUrl;
  }

  private async post(
    writerUrl: string,
    body: { path: string; args: JSONValue; identity: string | null; kind: "mutation" | "action" },
  ): Promise<JSONValue> {
    const res = await fetch(`${trimTrailingSlash(writerUrl)}/_fleet/run`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.adminKey}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: { value?: JSONValue; error?: string };
    try {
      parsed = text ? (JSON.parse(text) as { value?: JSONValue; error?: string }) : {};
    } catch {
      parsed = {};
    }
    if (!res.ok) throw new Error(parsed.error ?? `fleet: writer /_fleet/run returned HTTP ${res.status}`);
    if (parsed.error !== undefined) throw new Error(parsed.error);
    return parsed.value ?? null;
  }
}
