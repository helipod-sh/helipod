/**
 * HTTP routing for the dev server — a pure function over the runtime so it's testable without
 * a socket. Routes: the `_dashboard` status page, a health check, `POST /api/run` for direct
 * function invocation, and `/_admin/*` for the admin API (behind an admin key).
 */
import { convexToJson, type JSONValue, type Value } from "@stackbase/values";
import { getHttpStatus, toStackbaseError, NotShardOwnerError } from "@stackbase/errors";
import { matchRoute } from "@stackbase/executor";
import { DEFAULT_SHARD, type ShardId } from "@stackbase/id-codec";
import type { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { handleAdminRequest, verifyAdminKey, type AdminApi } from "@stackbase/admin";
import type { ResolvedRoute } from "./project";
import type { DeployResult } from "./deploy-apply";

export interface HttpRequest {
  method: string;
  path: string;
  body?: string;
  query?: Record<string, string>;
  authorization?: string;
  headers?: Record<string, string>;
}

/**
 * The fleet node handle the HTTP layer consumes (structural mirror of `@stackbase/fleet`'s
 * `FleetHandles` — declared here so core cli has no static dependency on the enterprise package).
 * `role()` decides whether a sync node proxies public httpActions to the writer; `writerUrl()` is
 * that proxy target. Present only when `serve --fleet` is active.
 */
export interface FleetHandles {
  role(): "sync" | "writer";
  writerUrl(): Promise<string>;
  onPromoted(cb: () => void): void;
  /** Frontier-lag reading for /api/health (B2a, D5): the fleet-wide `min(frontier_ts)`, how long it's
   *  been stuck (ms), and which shard is pinning it. Null before the first frontier beat. Optional so
   *  older/stub `FleetHandles` (and pre-B2a fleet builds) satisfy the structural mirror; the health
   *  handler optional-chains it. The real `@stackbase/fleet` node always provides it. */
  frontierStats?(): { frontier: bigint; lagMs: number; pinningShard: string } | null;
  /**
   * Group-commit counters (Fleet B4, T4 health observability): the aggregate `EmbeddedRuntime.
   * groupCommitStats()` reading plus a derived `flushesPerSec` (a rolling delta between successive
   * calls — see `@stackbase/fleet`'s `node.ts`). Structurally all-zero when `STACKBASE_GROUP_COMMIT`
   * is off (the underlying counters are simply never touched on the single-commit path), so the
   * health handler below shows zeroed fields rather than omitting them once fleet mode + this method
   * are both present — `undefined` is reserved for "not wired at all" (an older/stub `FleetHandles`),
   * mirroring `frontierStats?`'s same optional-for-backward-compat shape. The real `@stackbase/fleet`
   * node always provides it.
   */
  groupCommitStats?(): { lastBatchSize: number; maxBatchSize: number; flushCount: number; flushesPerSec: number };
  /**
   * Per-shard ownership (B2b, D1): true when THIS node currently holds `shardId`'s write lease.
   * Backs the `/_fleet/run` single-hop guard below — optional so older/stub `FleetHandles` satisfy
   * the structural mirror; the guard skips (fail open) when absent. The real `@stackbase/fleet` node
   * always provides it (delegates to its `WriteForwarder.isLocalWriter`).
   */
  isLocalWriter?(shardId: string): boolean;
  /**
   * Effectively-once forwarding (Fleet B3, D3): read back `key`'s `fleet_idempotency` row for a
   * replay decision — a hit means this write already committed (possibly on a sibling concurrent
   * attempt) and the caller must NOT re-execute. Optional so older/stub `FleetHandles` satisfy the
   * structural mirror; the `/_fleet/run` handler below skips the whole idempotency path when absent
   * (byte-identical to before this feature existed). The real `@stackbase/fleet` node always
   * provides it (delegates to `LeaseManager.lookupIdempotency`).
   */
  idempotencyLookup?(key: string): Promise<{ commitTs: bigint; hasValue: boolean; value: JSONValue | null; oversized: boolean } | null>;
  /** Best-effort post-run recording of a forwarded mutation's return value — see
   *  `LeaseManager.recordIdempotencyValue`. Optional for the same reason as `idempotencyLookup`. */
  idempotencyRecordValue?(key: string, value: JSONValue): Promise<void>;
  stop(): Promise<void>;
}

/**
 * True iff `e` is a Postgres `unique_violation` (23505) on the `fleet_idempotency` table
 * specifically (Fleet B3, D3 spec-review requirement) — the concurrent-duplicate race's loser: its
 * own commit guard INSERT collided with a sibling attempt that committed first, aborting its ENTIRE
 * commit transaction. This must be narrow: a 23505 from an APP-schema unique index (a genuine
 * uniqueness-constraint mutation failure) is a completely different, real error and must NEVER be
 * silently turned into a replay. Checked on the RAW thrown error — `DocStore.commitWrite`/
 * `ShardWriter.commit`/`InlineUdfExecutor.run` all rethrow a guard's failure unchanged (no
 * wrapping), so the underlying `pg`/PGlite driver error's `code`/`table`/`constraint` fields survive
 * unmodified all the way up to this catch.
 */
function isFleetIdempotencyConflict(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  if ((e as { code?: unknown }).code !== "23505") return false;
  const table = (e as { table?: unknown }).table;
  if (table === "fleet_idempotency") return true;
  const constraint = (e as { constraint?: unknown }).constraint;
  return typeof constraint === "string" && constraint.startsWith("fleet_idempotency");
}

/** The `/_fleet/run` replay response body (Fleet B3, D3) — additive: `replayed: true` alongside
 *  either `value` (a genuinely-recorded result, including a legitimate JSON `null`) or
 *  `valueMissing: true` (the crash-window or oversized-cap case — `hasValue` is false either way). */
function idempotencyReplayBody(hit: {
  commitTs: bigint;
  hasValue: boolean;
  value: JSONValue | null;
}): { replayed: true; commitTs: string; value?: JSONValue; valueMissing?: true } {
  return {
    replayed: true,
    commitTs: String(hit.commitTs),
    ...(hit.hasValue ? { value: hit.value } : { valueMissing: true }),
  };
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface ServerInfo {
  functions: string[];
  tables: string[];
}

function json(status: number, value: unknown): HttpResponse {
  return { status, headers: { "content-type": "application/json" }, body: JSON.stringify(value) };
}
function html(body: string): HttpResponse {
  return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body };
}

function bearer(authorization?: string): string | undefined {
  const m = /^Bearer (.+)$/.exec(authorization ?? "");
  return m ? m[1] : undefined;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

function dashboardHtml(info: ServerInfo): string {
  const li = (items: string[]) => items.map((i) => `<li><code>${escapeHtml(i)}</code></li>`).join("") || "<li><em>none</em></li>";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Stackbase</title>
<style>body{font:14px system-ui;margin:2rem;max-width:48rem}code{background:#f4f4f5;padding:.1rem .3rem;border-radius:4px}</style>
</head><body>
<h1>Stackbase — dev</h1>
<p>The reactive backend is running.</p>
<h2>Tables (${info.tables.length})</h2><ul>${li(info.tables)}</ul>
<h2>Functions (${info.functions.length})</h2><ul>${li(info.functions)}</ul>
</body></html>`;
}

export async function handleHttpRequest(
  runtime: EmbeddedRuntime,
  req: HttpRequest,
  info: ServerInfo,
  admin?: { api: AdminApi; key: string },
  routes?: ResolvedRoute[],
  deploy?: { apply: (files: Array<{ path: string; code: string }>) => Promise<DeployResult> },
  fleet?: FleetHandles,
): Promise<HttpResponse> {
  // Fleet write-forwarding target: a sync node's `WriteForwarder` POSTs mutations/actions here.
  // Enabled only in fleet mode (harmless on the writer — `runtime.run` executes locally there).
  // Admin-key gated (same bearer as `/_admin/*`): it can run any function under an arbitrary
  // identity, so it must never be reachable without the deployment admin key.
  if (fleet && req.method === "POST" && req.path === "/_fleet/run") {
    if (!admin || !verifyAdminKey(admin.key, bearer(req.authorization))) return json(401, { error: "unauthorized" });
    try {
      const p = JSON.parse(req.body ?? "{}") as {
        path?: string;
        args?: JSONValue;
        identity?: string | null;
        kind?: string;
        shardId?: string;
        /** Set by the forwarder (T2, single-hop guard) — signals this is a fleet-internal hop, not
         *  a fresh dispatch, so the receiver checks ownership itself rather than trusting the caller. */
        forwarded?: boolean;
        /** Fleet B3, D3 (effectively-once forwarding): the forwarder's one-per-logical-write UUID,
         *  reused verbatim across its retry-once — see `WriteForwarder.forward`. Absent for a
         *  non-forwarded call (e.g. a fleet-internal system forward from an older node, or any
         *  direct non-fleet caller), which carries no idempotency tracking at all. */
        idempotencyKey?: string;
      };
      if (!p.path) return json(400, { error: "missing function path" });
      const identity = p.identity ?? null;
      const shardId = (p.shardId ?? DEFAULT_SHARD) as ShardId;
      // Single-hop guard (B2b, D1 spec-review edit): a forward that lands on a node which is ALSO
      // not `shardId`'s owner (a point-in-time race during rebalance/failover convergence) must
      // NEVER re-forward — that would let a forward chase a moving target unboundedly. Reject with
      // a typed, RETRYABLE error instead; the ORIGINAL forwarder's refresh+retry-once re-reads the
      // lease and re-routes to the current owner. `isLocalWriter` is optional (older/stub
      // `FleetHandles`) — absent, this check is skipped (fail open): ordinary, non-forwarded traffic
      // is unaffected either way, since the executor's own per-shard router already forwards
      // correctly on a genuine ownership mismatch.
      if (p.forwarded && fleet.isLocalWriter && !fleet.isLocalWriter(shardId)) {
        throw new NotShardOwnerError(
          `fleet: this node is not the owner of shard '${shardId}' — refresh and retry against the current owner`,
        );
      }

      const idempotencyKey = p.idempotencyKey;
      // SELECT-first (Fleet B3, D3): a duplicate delivery of an ALREADY-committed write replays
      // without ever touching the runtime — no re-execution, no double side effects. `idempotencyLookup`
      // is optional (older/stub `FleetHandles`) — absent, this whole path is skipped and behavior is
      // byte-identical to before this feature existed.
      if (idempotencyKey && fleet.idempotencyLookup) {
        const hit = await fleet.idempotencyLookup(idempotencyKey);
        if (hit) return json(200, idempotencyReplayBody(hit));
      }

      // `_system:*`/`_storage:*` (and any other underscore-namespaced) built-in mutations reach here
      // when a privileged doc mutation — the admin dashboard editor's `_system:patchDocument`/
      // `deleteDocument`/`insertDocument`, which already carries its resolved `shardId` (B2a) — is
      // forwarded here because this node doesn't hold that shard (B2b, D1: "the router forwards them
      // like any other when the shard isn't held"). `runtime.run`'s PUBLIC gate rejects any
      // underscore-segment path outright (`FunctionNotFoundError`), so those must instead route
      // through the SAME privileged entrypoint the origin node used — `runSystem`, with the resolved
      // `shardId` threaded through — rather than the public `run`.
      const isInternalForwardPath = p.path.split(":").some((seg) => seg.startsWith("_"));
      // Opaque commit metadata (Fleet B3, D3): threaded through `run`/`runSystem` -> `RunOptions.
      // commitMeta` -> ... -> the fleet commit guard's atomic `fleet_idempotency` INSERT. Actions
      // never reach a top-level commit themselves (their inner `ctx.runMutation` calls are each a
      // fresh `invoke` with their own options), so this is a harmless no-op for `kind === "action"`.
      const commitMeta = idempotencyKey ? { idempotencyKey } : undefined;

      let result: Awaited<ReturnType<typeof runtime.run>>;
      try {
        result =
          p.kind === "action"
            ? await runtime.runAction(p.path, p.args ?? {}, { identity })
            : isInternalForwardPath
              ? await runtime.runSystem(p.path, p.args ?? {}, { shardId, commitMeta })
              : await runtime.run(p.path, p.args ?? {}, { identity, commitMeta });
      } catch (runErr) {
        // The concurrent-duplicate race's loser (Fleet B3, D3 spec-review requirement): this
        // attempt ALSO passed the SELECT-miss above, then its own commit guard's `fleet_idempotency`
        // INSERT collided with a sibling attempt that committed first — aborting this entire commit
        // transaction (nothing landed; see `installCommitGuard`'s doc comment). That is NOT a
        // caller-visible failure: re-SELECT the row the winner just committed and replay it, rather
        // than surfacing a generic 500 for what is, from the caller's perspective, a successful
        // (if duplicated) write.
        if (idempotencyKey && fleet.idempotencyLookup && isFleetIdempotencyConflict(runErr)) {
          const hit = await fleet.idempotencyLookup(idempotencyKey);
          if (hit) return json(200, idempotencyReplayBody(hit));
        }
        throw runErr;
      }

      // Post-run best-effort value recording (Fleet B3, D3): the guard only ever saw `commitTs` (the
      // VALUE isn't known inside the commit transaction), so record it now that `run`/`runAction`/
      // `runSystem` has returned. A failure here (e.g. a transient connection hiccup) must NOT fail
      // an otherwise-successful mutation response — a later replay simply reports `valueMissing:
      // true` for this key, the documented crash-window contract.
      if (idempotencyKey && fleet.idempotencyRecordValue) {
        try {
          await fleet.idempotencyRecordValue(idempotencyKey, convexToJson(result.value as Value));
        } catch {
          // best-effort — see the doc comment above.
        }
      }

      // Stringified: a replica's `WriteForwarder` waits on this via `ReplicaTailer.waitFor` for
      // read-your-own-writes, and bigints don't survive JSON.stringify. `result.oplog` is null for
      // actions (they never commit directly) — fall back to `result.commitTs`, which the executor
      // now surfaces as the MAX commitTs across the action's inner runMutation/runAction invokes
      // (0n if it committed nothing), so fleet RYOW covers actions too.
      // `shardId` (B2a, additive): the shard this run committed on, from the commit's oplog (present
      // for a committed mutation; absent for a read/action that committed nothing — omitted then).
      return json(200, {
        value: convexToJson(result.value as Value),
        commitTs: String(result.oplog?.commitTs ?? result.commitTs ?? 0n),
        ...(result.oplog?.shardId !== undefined ? { shardId: result.oplog.shardId } : {}),
      });
    } catch (e) {
      // Preserve the typed error's identity across the fleet hop: return its REAL http status and the
      // full serialized error (`errorJson`) so the forwarding SYNC node can rehydrate it and surface
      // the correct 4xx/5xx + code/retryable, instead of collapsing every forwarded failure to a 500.
      // `error` (the flat message) is kept for back-compat / human-readable logs.
      const err = toStackbaseError(e);
      return json(getHttpStatus(err), { error: err.message, code: err.code, errorJson: err.toJSON() });
    }
  }
  if (admin && deploy && req.method === "POST" && req.path === "/_admin/deploy") {
    if (!verifyAdminKey(admin.key, bearer(req.authorization))) return json(401, { ok: false, error: "unauthorized" });
    let files: Array<{ path: string; code: string }>;
    try {
      files = (JSON.parse(req.body ?? "{}") as { files?: Array<{ path: string; code: string }> }).files ?? [];
    } catch {
      return json(400, { ok: false, kind: "load-error", error: "invalid deploy payload" });
    }
    const result = await deploy.apply(files);
    return json(result.ok ? 200 : result.kind === "schema-incompatible" ? 409 : 400, result);
  }
  if (admin && req.path.startsWith("/_admin/")) {
    const res = await handleAdminRequest(admin.api, admin.key, {
      method: req.method,
      path: req.path,
      query: req.query ?? {},
      body: req.body,
      authorization: req.authorization,
    });
    return json(res.status, res.body);
  }
  if (req.method === "GET" && (req.path === "/_dashboard" || req.path === "/_dashboard/")) {
    return html(dashboardHtml(info));
  }
  if (req.method === "GET" && req.path === "/api/health") {
    // Fleet frontier-lag observability (B2a, D5): additive `fleet` field when running under --fleet
    // and a frontier reading is available. `frontier` is a stringified bigint (JSON can't carry one).
    const fs = fleet?.frontierStats?.() ?? null;
    // Fleet B4 (T4) group-commit counters: additive `fleet.groupCommit`, nested inside the SAME `fleet`
    // gate as the frontier reading above (so a build/fleet-mode that hasn't reported ANY health data
    // yet stays byte-identical to before this field existed). `gc` is zeroed (not absent) when
    // `STACKBASE_GROUP_COMMIT` is off — `groupCommitStats()` structurally returns zeros in that case
    // (see its doc comment) — and the field is omitted only when `groupCommitStats` itself isn't wired
    // (an older/stub `FleetHandles`), which is what `?.` falls through to `null` for.
    const gc = fleet?.groupCommitStats?.() ?? null;
    return json(200, {
      status: "ok",
      functions: info.functions.length,
      tables: info.tables.length,
      ...(fs
        ? { fleet: { frontier: String(fs.frontier), lagMs: fs.lagMs, pinningShard: fs.pinningShard, ...(gc ? { groupCommit: gc } : {}) } }
        : {}),
    });
  }
  if (req.method === "POST" && req.path === "/api/run") {
    try {
      const parsed = JSON.parse(req.body ?? "{}") as { path?: string; args?: JSONValue };
      if (!parsed.path) return json(400, { error: "missing function path" });
      const result = await runtime.run(parsed.path, parsed.args ?? {});
      return json(200, { value: convexToJson(result.value as Value), committed: result.committed });
    } catch (e) {
      const err = toStackbaseError(e);
      return json(getHttpStatus(err), { error: err.message, code: err.code });
    }
  }
  // User httpAction routes — matched AFTER the built-ins, only for non-reserved paths.
  const match = routes && routes.length > 0 ? matchRoute(routes, req.method, req.path) : undefined;
  if (match) {
    // Fleet sync node: an httpAction runs like an action (it may `ctx.runMutation`), so the WHOLE
    // request is proxied to the writer and executed there — never run locally on a replica. The
    // writer's Response (status/headers/body) is streamed back verbatim.
    if (fleet && fleet.role() === "sync") {
      try {
        const writerUrl = await fleet.writerUrl();
        if (!writerUrl) return json(503, { error: "fleet: no writer available" });
        const qs = req.query && Object.keys(req.query).length ? "?" + new URLSearchParams(req.query).toString() : "";
        const target = `${writerUrl.replace(/\/$/, "")}${req.path}${qs}`;
        const headers = new Headers(req.headers ?? {});
        if (req.authorization && !headers.has("authorization")) headers.set("authorization", req.authorization);
        // `fetch` recomputes these from the URL/body; a stale copied value would mismatch the
        // re-encoded body (or point at this node, not the writer).
        headers.delete("host");
        headers.delete("content-length");
        const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.body !== undefined;
        const resp = await fetch(target, { method: req.method, headers, ...(hasBody ? { body: req.body } : {}) });
        const outHeaders: Record<string, string> = {};
        resp.headers.forEach((v, k) => { outHeaders[k] = v; });
        // Hop-by-hop / body-framing headers: `undici` already decompressed the body (so a copied
        // content-encoding/content-length would mismatch what we actually relay), and
        // transfer-encoding/connection are connection-scoped, never meaningful to forward verbatim.
        delete outHeaders["content-encoding"];
        delete outHeaders["content-length"];
        delete outHeaders["transfer-encoding"];
        delete outHeaders["connection"];
        return { status: resp.status, headers: outHeaders, body: await resp.text() };
      } catch (e) {
        return json(502, { error: `fleet: httpAction proxy to writer failed: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
    try {
      const headers = new Headers(req.headers ?? {});
      if (req.authorization && !headers.has("authorization")) headers.set("authorization", req.authorization);
      const qs = req.query && Object.keys(req.query).length ? "?" + new URLSearchParams(req.query).toString() : "";
      const host = headers.get("host") ?? "localhost";
      const url = `http://${host}${req.path}${qs}`;
      const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.body !== undefined;
      const request = new Request(url, { method: req.method, headers, ...(hasBody ? { body: req.body } : {}) });

      const auth = headers.get("authorization") ?? "";
      const identity = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;

      const response = await runtime.runHttpAction(match.handlerPath, request, { identity });
      if (!(response instanceof Response)) {
        return json(500, { error: "httpAction must return a Response" });
      }
      const outHeaders: Record<string, string> = {};
      response.headers.forEach((v, k) => { outHeaders[k] = v; });
      return { status: response.status, headers: outHeaders, body: await response.text() };
    } catch (e) {
      const err = toStackbaseError(e);
      return json(getHttpStatus(err), { error: err.message, code: err.code });
    }
  }

  return json(404, { error: "not found" });
}
