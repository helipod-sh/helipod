/**
 * `StackbaseDurableObject` — the UNIFIED single-shard Durable Object host (Slice 3, decision 1).
 *
 * ONE object owns EVERYTHING for the shard: the OCC writer (its single thread IS the mutex), the
 * DO-SQLite store (`ctx.storage.sql`), the hibernatable WebSockets (`ctx.acceptWebSocket`), the
 * subscription index (the union of every live socket's attachment), and the wake alarm
 * (`ctx.storage.setAlarm`). Because the writer and the subscription index are the SAME object, a
 * mutation's reactive fan-out is an IN-PROCESS call in the same turn — so the engine's shipped G1/G4
 * frontier-ordering guarantees survive BY CONSTRUCTION: there is no RPC hop to reorder across (§2).
 *
 * The DO is a plain class (constructor `(ctx, env)`) rather than `extends DurableObject`, so it is
 * unit-testable under plain Node with a fake `ctx`/`env` — workerd's legacy DO shape supports
 * hibernation WebSocket handlers on any class with the right methods. The codegen'd Worker entry
 * (§4.2) subclasses this and supplies the statically-bundled app via {@link appConfig}.
 *
 * Not built here (deliberate, per spec): the transactor-DO/sync-DO SPLIT (Slice 6 — `notifyWrites`
 * stays a single named in-process method with an `origin`-carrying payload so the split is a later
 * swap, not a rewrite); file-storage byte I/O on a DO (§8.9); the sinceTs/fingerprint OUTBOUND capture
 * that would make rehydrate a `QueryUnchanged` rather than a full re-send (see `webSocketMessage`).
 */
import type { LoadedProject } from "@stackbase/cli/project";
import type { ComponentDefinition } from "@stackbase/component";
import type { BlobStore } from "@stackbase/blobstore";
import { bootDurableObjectRuntime, type DurableObjectBoot } from "./boot";
import { DurableObjectRuntimeHost } from "./host";
import { DoAlarmWakeHost } from "./wake";
import { doSyncSocket } from "./do-socket";
import {
  newAttachment,
  readAttachment,
  wouldExceedCap,
  TooManySubscriptionsError,
  MAX_SUBSCRIPTIONS_PER_SOCKET,
  type StackbaseSocketAttachment,
} from "./attachment";
import type { DurableObjectStateLike, DoWebSocketLike } from "./cf-types";

/** What a concrete DO subclass supplies — the statically-bundled app + its admin key. */
export interface DurableObjectAppConfig {
  loaded: LoadedProject;
  components?: ComponentDefinition[];
  adminKey: string;
  /** File-storage byte backend (`env.R2` → `@stackbase/blobstore-r2`), supplied by the concrete DO
   *  subclass. Injected, never imported — the engine stays blob-store-neutral. Absent → file storage
   *  is inert (`ctx.storage` has no provider; `/api/storage/*` 404s), everything else unchanged. */
  blobStore?: BlobStore;
  /** Stretch pure-backstop driver cadences (Cloudflare: `(d) => Math.max(d, 900_000)`). */
  backstopMs?: (defaultMs: number) => number;
  /** Injected clock (tests). */
  now?: () => number;
}

const SYNC_PATH = "/api/sync";

export abstract class StackbaseDurableObject {
  /** Supplied by the concrete (codegen'd) subclass: the bundled app + admin key from `env`. */
  protected abstract appConfig(env: unknown): DurableObjectAppConfig;

  protected boot!: DurableObjectBoot;
  private bootError: unknown = null;
  /** The RuntimeHost seam instance (Task 2) — HTTP dispatch flows through it. */
  private readonly runtimeHost = new DurableObjectRuntimeHost();
  /** Resolves when boot (+ eager rehydrate-all-on-wake) has finished. Every handler awaits it. */
  private readonly bootDone: Promise<void>;
  /** connectionId → the live DO socket serving it (so a fan-out target can be re-found on rehydrate). */
  private readonly wsByConn = new Map<string, DoWebSocketLike>();
  /** connectionIds with a live handler session right now (rehydrated or freshly connected). */
  private readonly liveSessions = new Set<string>();

  constructor(
    protected readonly ctx: DurableObjectStateLike,
    protected readonly env: unknown,
  ) {
    // Boot inside `blockConcurrencyWhile`: no fetch/message/alarm event interleaves a half-built
    // runtime (§4.3). A throw here would BRICK the DO (§8.4) — catch it, stash it, and surface it as
    // a clear per-request 500 instead of a silently-wedged object.
    this.bootDone = this.ctx.blockConcurrencyWhile(async () => {
      try {
        const cfg = this.appConfig(this.env);
        this.boot = await bootDurableObjectRuntime({
          loaded: cfg.loaded,
          components: cfg.components,
          sql: this.ctx.storage.sql,
          transactionSync: this.ctx.storage.transactionSync.bind(this.ctx.storage),
          adminKey: cfg.adminKey,
          wakeHost: new DoAlarmWakeHost(this.ctx.storage),
          ...(cfg.blobStore ? { blobStore: cfg.blobStore } : {}),
          ...(cfg.backstopMs ? { backstopMs: cfg.backstopMs } : {}),
          ...(cfg.now ? { now: cfg.now } : {}),
        });
        // Wire the RuntimeHost seam over the freshly-booted runtime (Task 2). Port 0 (portless DO),
        // no-op close, working setRoutes — HTTP dispatch flows through `this.runtimeHost.fetch`.
        await this.runtimeHost.serve(this.boot.runtime, {
          port: 0,
          ip: "0.0.0.0",
          admin: { api: this.boot.adminApi, key: this.boot.adminKey },
          routes: this.boot.project.routes,
          // Engine-owned reserved routes matched ahead of the pure dispatcher (see `host.ts`): the
          // always-on `/api/storage/*` byte endpoints (present only when a `blobStore` was injected)
          // and component (OAuth) callbacks (always wired). This is the seam fix that unblocks BOTH
          // file-storage serving and auth OAuth callbacks on the DO.
          storageRoutes: this.boot.storageRoutes,
          componentRoutes: this.boot.componentRoutes,
        });
        this.armAutoResponse();
        // DECISION 3 — eager rehydrate-all-on-wake: reconstruct every hibernated socket's session
        // from its attachment BEFORE serving anything, so a fan-out's read-set intersection never
        // silently misses a hibernated subscriber (§3.4 / §8.7). On a FRESH DO this is a no-op
        // (`getWebSockets()` is empty).
        await this.rehydrateAll();
      } catch (e) {
        this.bootError = e;
        console.error("[runtime-cloudflare] DO boot failed:", e);
      }
    });
  }

  /** Set the runtime-level ping/pong keepalive that answers WITHOUT waking the DO — replacing the
   *  handler's process-shaped `socket.ping` heartbeat (decision 6). Guarded: the global +
   *  `setWebSocketAutoResponse` exist only in workerd. */
  private armAutoResponse(): void {
    const g = globalThis as { WebSocketRequestResponsePair?: new (req: string, res: string) => unknown };
    if (this.ctx.setWebSocketAutoResponse && g.WebSocketRequestResponsePair) {
      this.ctx.setWebSocketAutoResponse(new g.WebSocketRequestResponsePair("ping", "pong"));
    }
  }

  /** Rehydrate every hibernated socket that lacks a live session (idempotent). */
  private async rehydrateAll(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) this.ensureSession(ws);
  }

  /**
   * Ensure the handler has a live session for `ws`, reconstructing it from the durable attachment if
   * absent (post-hibernation). Idempotent: a socket with a live session is left untouched. Reuses the
   * shipped `handler.connect`/`setAuth` + `Subscribe` replay — the DO adds only the orchestration.
   */
  private ensureSession(ws: DoWebSocketLike): StackbaseSocketAttachment | null {
    const att = readAttachment(ws.deserializeAttachment());
    if (!att) {
      // An un-rehydratable socket (garbled/absent attachment) — loud-log and close it; the client's
      // reconnect re-establishes cleanly.
      console.error("[runtime-cloudflare] socket has no readable attachment; closing");
      try {
        ws.close(1011, "unrehydratable");
      } catch {
        /* already closing */
      }
      return null;
    }
    this.wsByConn.set(att.connectionId, ws);
    if (this.liveSessions.has(att.connectionId)) return att;

    this.boot.runtime.handler.connect(att.connectionId, doSyncSocket(ws));
    this.liveSessions.add(att.connectionId);
    // Replay the verified identity, then re-add every sub as ONE `ModifyQuerySet` (the shipped wire
    // shape). Each `QueryRequest` re-derives its read-set on re-run; a persisted `sinceTs`/`resultHash`
    // (present only if the client resume-subscribed before hibernation) rides along so an unchanged
    // query answers `QueryUnchanged`. Capturing the SERVER-minted fingerprint for a fresh subscribe
    // (decision 2's full "for free") needs OUTBOUND frame capture — a deferred optimization; rehydrate
    // is correct without it (a full re-send).
    if (att.identity) {
      void this.boot.runtime.handler.handleMessage(att.connectionId, JSON.stringify({ type: "SetAuth", token: att.identity }));
    }
    const add = Object.values(att.subs).map((s) => ({
      queryId: s.queryId,
      udfPath: s.udfPath,
      args: s.args,
      ...(s.sinceTs !== undefined ? { sinceTs: s.sinceTs } : {}),
      ...(s.resultHash !== undefined ? { resultHash: s.resultHash } : {}),
    }));
    if (add.length > 0) {
      void this.boot.runtime.handler.handleMessage(att.connectionId, JSON.stringify({ type: "ModifyQuerySet", add, remove: [] }));
    }
    return att;
  }

  /* ---------------------------------------------------------------------- */
  /* HTTP (Worker `fetch` → engine dispatch, or WS upgrade)                  */
  /* ---------------------------------------------------------------------- */

  async fetch(request: Request): Promise<Response> {
    await this.bootDone;
    if (this.bootError) {
      return jsonResponse(500, { error: "stackbase: Durable Object failed to boot", detail: String(this.bootError) });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Diagnostic: which datacenter does THIS Durable Object physically run in? A DO is single-homed,
    // and its OUTBOUND request originates from its own colo — so `/cdn-cgi/trace` reveals the DO's
    // real location, independent of client latency. Used to VERIFY `locationHint` placement: route
    // `/api/_whereami?shard=<k>&region=<hint>` and check the returned colo matches the hinted region.
    if (path === "/api/_whereami") {
      let colo = "unknown";
      try {
        const trace = await fetch("https://workers.cloudflare.com/cdn-cgi/trace");
        colo = (await trace.text()).match(/^colo=(.+)$/m)?.[1] ?? "unparsed";
      } catch (e) {
        colo = `trace-failed: ${String(e)}`;
      }
      return jsonResponse(200, { colo, doId: String((this.ctx as { id?: unknown }).id ?? "") });
    }

    // WebSocket upgrade → the reactive sync socket. Handled by the DO directly (WebSocketPair +
    // hibernation), never by `handleHttpRequest`.
    if (path === SYNC_PATH && (request.headers.get("Upgrade") ?? "").toLowerCase() === "websocket") {
      return this.handleWebSocketUpgrade();
    }

    // Everything else → the RuntimeHost seam, which reuses the SHIPPED pure dispatcher
    // (`handleHttpRequest`): `/api/health`, `/api/run` (the transactor path — inline fan-out on
    // commit, decision 5, NOT `waitUntil`-deferred), `/_admin/*` (incl. `/_admin/wake` →
    // `runtime.fireDueTimers()`), and user httpAction routes.
    return this.runtimeHost.fetch(request);
  }

  private handleWebSocketUpgrade(): Response {
    const g = globalThis as { WebSocketPair?: new () => { 0: DoWebSocketLike; 1: DoWebSocketLike } };
    if (!g.WebSocketPair) return new Response("WebSocketPair unavailable", { status: 500 });
    const pair = new g.WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const connectionId = mintConnectionId();
    // `acceptWebSocket` enrolls the server end in the hibernation manager; the attachment stamped now
    // is what survives hibernation and drives rehydrate (§3.2).
    this.ctx.acceptWebSocket(server, [connectionId]);
    server.serializeAttachment(newAttachment(connectionId));
    this.boot.runtime.handler.connect(connectionId, doSyncSocket(server));
    this.liveSessions.add(connectionId);
    this.wsByConn.set(connectionId, server);
    // 101 with the client end handed back — the workerd upgrade contract.
    return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: DoWebSocketLike });
  }

  /* ---------------------------------------------------------------------- */
  /* Hibernation WebSocket handlers                                          */
  /* ---------------------------------------------------------------------- */

  async webSocketMessage(ws: DoWebSocketLike, message: string | ArrayBuffer): Promise<void> {
    await this.bootDone;
    if (this.bootError) {
      try {
        ws.close(1011, "boot failed");
      } catch {
        /* already closing */
      }
      return;
    }
    // Rehydrate this socket's session first if it hibernated (§3.4) — the read-set must exist before
    // any subsequent fan-out intersects against it.
    const att = this.ensureSession(ws);
    if (!att) return; // closed as unrehydratable
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);

    // Mirror ModifyQuerySet/SetAuth into the durable attachment (so a future hibernation can
    // rehydrate), enforce the per-socket subscription cap, and get back the frame to actually forward
    // (a cap-exceeding add is stripped from it so the handler never subscribes past the cap).
    const forward = this.updateAttachmentFromMessage(ws, att, text);

    await this.boot.runtime.handler.handleMessage(att.connectionId, forward);
    // The commit fan-out (if this message was a Mutation) ran INLINE inside `handleMessage` on this
    // same turn — decision 5. No `waitUntil` defer, so a `MutationResponse` never beats its own G4
    // origin-frontier advance.
  }

  async webSocketClose(ws: DoWebSocketLike): Promise<void> {
    await this.bootDone;
    this.teardownSocket(ws);
  }

  async webSocketError(ws: DoWebSocketLike): Promise<void> {
    await this.bootDone;
    this.teardownSocket(ws);
  }

  private teardownSocket(ws: DoWebSocketLike): void {
    const att = readAttachment(ws.deserializeAttachment());
    if (!att) return;
    if (this.liveSessions.has(att.connectionId)) this.boot?.runtime.handler.disconnect(att.connectionId);
    this.liveSessions.delete(att.connectionId);
    this.wsByConn.delete(att.connectionId);
  }

  /** Alarm → fire whatever driver timers are due (scheduler/triggers/reaper wake on a DO). */
  async alarm(): Promise<void> {
    await this.bootDone;
    if (this.bootError) return;
    this.boot.runtime.fireDueTimers();
  }

  /**
   * Reflect a client frame into the durable attachment and enforce the per-socket subscription cap.
   * Handles the shipped wire shapes: `ModifyQuerySet {add, remove}` (subscribe/unsubscribe) and
   * `SetAuth {token}`. Returns the frame to actually FORWARD to the handler — a cap-exceeding add is
   * stripped from it (and answered with a `QueryFailed`) so the handler never subscribes past the cap.
   * Non-subscription frames (Mutation/Action/Connect/…) are returned verbatim.
   */
  private updateAttachmentFromMessage(ws: DoWebSocketLike, att: StackbaseSocketAttachment, text: string): string {
    let msg: {
      type?: string;
      token?: unknown;
      add?: Array<{ queryId?: unknown; udfPath?: unknown; args?: unknown; sinceTs?: unknown; resultHash?: unknown }>;
      remove?: unknown[];
    };
    try {
      msg = JSON.parse(text);
    } catch {
      return text; // let the handler produce its own parse error
    }
    if (msg.type === "ModifyQuerySet") {
      // Apply removes first (they free cap headroom for the adds in the same frame).
      for (const q of msg.remove ?? []) {
        if (typeof q === "number") delete att.subs[String(q)];
      }
      const acceptedAdd: Array<Record<string, unknown>> = [];
      for (const q of msg.add ?? []) {
        if (typeof q.queryId !== "number" || typeof q.udfPath !== "string") {
          acceptedAdd.push(q as Record<string, unknown>);
          continue;
        }
        const subId = String(q.queryId);
        if (wouldExceedCap(att, subId)) {
          // Clean, client-visible rejection (§3.3): answer this query with `QueryFailed`, persist
          // nothing new, and STRIP it from the forwarded frame so the handler never subscribes it.
          ws.send(JSON.stringify({ type: "QueryFailed", queryId: q.queryId, error: new TooManySubscriptionsError(MAX_SUBSCRIPTIONS_PER_SOCKET).message }));
          continue;
        }
        att.subs[subId] = {
          queryId: q.queryId,
          udfPath: q.udfPath,
          args: q.args ?? {},
          ...(typeof q.sinceTs === "number" ? { sinceTs: q.sinceTs } : {}),
          ...(typeof q.resultHash === "string" ? { resultHash: q.resultHash } : {}),
        };
        acceptedAdd.push(q as Record<string, unknown>);
      }
      this.persistAttachment(ws, att);
      // Re-serialize only if we actually stripped something (keep the byte-identical frame otherwise).
      if (acceptedAdd.length !== (msg.add?.length ?? 0)) {
        return JSON.stringify({ ...msg, add: acceptedAdd });
      }
      return text;
    }
    if (msg.type === "SetAuth") {
      att.identity = typeof msg.token === "string" ? msg.token : null;
      this.persistAttachment(ws, att);
    }
    return text;
  }

  /** Persist the attachment, degrading (not crashing) on a `serializeAttachment` throw (§3.3): the
   *  subscription still works THIS turn; it just won't survive the next hibernation, and the client's
   *  normal reconnect-resume re-establishes it. */
  private persistAttachment(ws: DoWebSocketLike, att: StackbaseSocketAttachment): void {
    try {
      ws.serializeAttachment(att);
    } catch (e) {
      console.error("[runtime-cloudflare] serializeAttachment failed (subscription won't survive hibernation):", e);
    }
  }
}

/** A stable per-socket id minted at upgrade (Lunora `shard-do.ts` mints one the same way). */
function mintConnectionId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `conn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
