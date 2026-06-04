# Incremental Push (serve target) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `stackbase deploy` (serve target) ship a delta — only changed modules + hashes of unchanged ones — instead of the whole `convex/` tree, Convex-parity, fully back-compatible with a server that predates it.

**Architecture:** Server-negotiate: the client `GET`s the server's current per-path module hashes, partitions its local files locally, and `POST`s `{ changed, unchanged }`. The server reconstructs the full tree from its retained last-push module set + the changed modules, integrity-checks each unchanged sha, then does the existing atomic swap. Old server / stale-base → transparent full push.

**Tech Stack:** TypeScript (ESM), Bun + Turborepo, `tsup` build, `vitest`, `node:crypto` sha256, `fetch` over the existing `/_admin/deploy` admin route.

## Global Constraints

- **Server-negotiate, no client cache** — the client fetches remote hashes; it never persists its own push cache.
- **The new-module-set is an in-memory `Map` holding code — it MUST NOT be serialized to the wire.** The state update happens in the `serve.ts` `apply` closure; only `{ ok, rev, functions }` (or `{ ok:false, kind, error }`) crosses HTTP.
- **`sha256Hex(code)` = lowercase hex sha256 over the utf8 transpiled `.js` code string** — identical on client and server, never a re-transpile.
- **Legacy `{ files }` push MUST keep working** (old client → new server) and the client MUST full-push when the `GET` 404s (new client → old server).
- **First deploy per server lifetime is a full push, then deltas** — the server tracks modules from the last *push*, not from boot (`currentPushedModules` starts empty each lifetime).
- **Deletions are implicit** — a file in neither `changed` nor `unchanged` is dropped; the union defines the complete tree.
- **`--allow-deploy` gate + `Bearer STACKBASE_ADMIN_KEY` auth** apply to the new `GET /_admin/deploy/modules` exactly as to the POST.
- **Scope: `serve` target only.** `cloudflare`/`docker` untouched. Two test lanes: fast (`*.test.ts`) and serial E2E (`*-e2e.test.ts`). Run `bun run --filter <pkg> build` on any deploy/cli package task (not just test+typecheck).

---

## Canonical Interfaces (defined across Tasks 1–2, referenced everywhere)

```ts
// @stackbase/deploy — src/module-hash.ts (Task 1)
export function sha256Hex(code: string): string;
export interface DeltaPush {
  changed: Array<{ path: string; code: string }>;
  unchanged: Array<{ path: string; sha256: string }>;
}
export function partitionModules(local: import("./types").FileTree, remoteHashes: Record<string, string>): DeltaPush;

// @stackbase/cli — src/deploy-apply.ts (Task 2)
export type DeployPayload =
  | { files: Array<{ path: string; code: string }> }
  | { changed: Array<{ path: string; code: string }>; unchanged: Array<{ path: string; sha256: string }> };
export type ReconstructResult =
  | { ok: true; files: Array<{ path: string; code: string }> }
  | { ok: false; error: string };
export function reconstructFiles(
  payload: DeployPayload,
  currentModules: Map<string, { code: string; sha: string }>,
): ReconstructResult;
// applyDeploy signature changes to (deps, payload: DeployPayload); DeployDeps gains
//   currentModules: Map<string, { code: string; sha: string }>
// DeployResult success variant gains  modules: Map<string, { code: string; sha: string }>
// DeployResult failure `kind` gains  "stale-base"
```

---

### Task 1: `module-hash.ts` — `sha256Hex` + `partitionModules` (pure)

**Files:**
- Create: `packages/deploy/src/module-hash.ts`
- Modify: `packages/deploy/src/index.ts`
- Test: `packages/deploy/test/module-hash.test.ts`

**Interfaces:**
- Consumes: `FileTree` from `./types` (`{ files: Array<{path, code}> }`).
- Produces: `sha256Hex`, `partitionModules`, `DeltaPush` (see Canonical Interfaces).

- [ ] **Step 1: Write the failing test `packages/deploy/test/module-hash.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { sha256Hex, partitionModules } from "../src/module-hash";

describe("sha256Hex", () => {
  it("is deterministic lowercase hex over the utf8 code", () => {
    const a = sha256Hex("export const x = 1");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex("export const x = 1")).toBe(a);
    expect(sha256Hex("export const x = 2")).not.toBe(a);
  });
});

describe("partitionModules", () => {
  it("marks a file unchanged when the server has the same path+sha, changed otherwise", () => {
    const local = { files: [{ path: "a.js", code: "A" }, { path: "b.js", code: "B2" }, { path: "c.js", code: "C" }] };
    const remote = { "a.js": sha256Hex("A"), "b.js": sha256Hex("B1") /* b differs; c is new */ };
    const { changed, unchanged } = partitionModules(local, remote);
    expect(unchanged).toEqual([{ path: "a.js", sha256: sha256Hex("A") }]);
    expect(changed.map((c) => c.path).sort()).toEqual(["b.js", "c.js"]);
  });

  it("omits a server file the local tree no longer has (deletion by omission)", () => {
    const local = { files: [{ path: "a.js", code: "A" }] };
    const remote = { "a.js": sha256Hex("A"), "gone.js": sha256Hex("X") };
    const { changed, unchanged } = partitionModules(local, remote);
    expect(changed).toEqual([]);
    expect(unchanged).toEqual([{ path: "a.js", sha256: sha256Hex("A") }]);
    // "gone.js" is in neither list.
    expect([...changed, ...unchanged].some((e) => e.path === "gone.js")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --filter @stackbase/deploy test module-hash`
Expected: FAIL (`../src/module-hash` not found).

- [ ] **Step 3: Create `packages/deploy/src/module-hash.ts`**

```ts
import { createHash } from "node:crypto";
import type { FileTree } from "./types";

/** Lowercase-hex sha256 over the utf8 code string. Identical on client and server — never a re-transpile. */
export function sha256Hex(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

export interface DeltaPush {
  changed: Array<{ path: string; code: string }>;
  unchanged: Array<{ path: string; sha256: string }>;
}

/** Partition local files against the server's current per-path hashes. A file is `unchanged` iff the
 *  server has the same path with an equal sha256; otherwise `changed` (new or modified). A path the
 *  server has but the local tree lacks appears in neither list (deletion by omission). */
export function partitionModules(local: FileTree, remoteHashes: Record<string, string>): DeltaPush {
  const changed: Array<{ path: string; code: string }> = [];
  const unchanged: Array<{ path: string; sha256: string }> = [];
  for (const f of local.files) {
    const sha = sha256Hex(f.code);
    if (remoteHashes[f.path] === sha) unchanged.push({ path: f.path, sha256: sha });
    else changed.push({ path: f.path, code: f.code });
  }
  return { changed, unchanged };
}
```

- [ ] **Step 4: Export from `packages/deploy/src/index.ts`** — add:

```ts
export { sha256Hex, partitionModules, type DeltaPush } from "./module-hash";
```

- [ ] **Step 5: Run tests + build**

Run: `bun run --filter @stackbase/deploy test module-hash && bun run --filter @stackbase/deploy build`
Expected: tests PASS (3), build exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/deploy && git commit -m "feat(deploy): module-hash — sha256Hex + partitionModules for incremental push"
```

---

### Task 2: `reconstructFiles` + `applyDeploy` delta support (server)

**Files:**
- Modify: `packages/cli/src/deploy-apply.ts`
- Test: `packages/cli/test/reconstruct-files.test.ts`

**Interfaces:**
- Consumes: `sha256Hex` from `@stackbase/deploy` (Task 1).
- Produces: `reconstructFiles`, `DeployPayload`, `ReconstructResult` (Canonical Interfaces); `applyDeploy(deps, payload)` with `DeployDeps.currentModules` and `DeployResult` success `.modules` + failure `kind:"stale-base"`.

- [ ] **Step 1: Write the failing test `packages/cli/test/reconstruct-files.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { sha256Hex } from "@stackbase/deploy";
import { reconstructFiles } from "../src/deploy-apply";

const cur = new Map([
  ["a.js", { code: "A", sha: sha256Hex("A") }],
  ["b.js", { code: "B", sha: sha256Hex("B") }],
]);

describe("reconstructFiles", () => {
  it("passes a legacy {files} payload straight through", () => {
    const r = reconstructFiles({ files: [{ path: "x.js", code: "X" }] }, new Map());
    expect(r).toEqual({ ok: true, files: [{ path: "x.js", code: "X" }] });
  });

  it("rebuilds the full tree from changed + unchanged (resolved from currentModules)", () => {
    const r = reconstructFiles(
      { changed: [{ path: "b.js", code: "B2" }], unchanged: [{ path: "a.js", sha256: sha256Hex("A") }] },
      cur,
    );
    expect(r.ok).toBe(true);
    expect((r as { files: unknown }).files).toEqual([
      { path: "b.js", code: "B2" },
      { path: "a.js", code: "A" },
    ]);
  });

  it("returns stale-base when an unchanged path is unknown to the server", () => {
    const r = reconstructFiles({ changed: [], unchanged: [{ path: "ghost.js", sha256: "deadbeef" }] }, cur);
    expect(r).toEqual({ ok: false, error: expect.stringContaining("stale-base") });
  });

  it("returns stale-base when an unchanged sha disagrees with the server's", () => {
    const r = reconstructFiles({ changed: [], unchanged: [{ path: "a.js", sha256: sha256Hex("DIFFERENT") }] }, cur);
    expect(r).toEqual({ ok: false, error: expect.stringContaining("stale-base") });
  });

  it("drops a current module the delta does not reference (deletion by omission)", () => {
    // Only a.js is referenced; b.js is intentionally absent from both lists → not in the rebuilt tree.
    const r = reconstructFiles({ changed: [], unchanged: [{ path: "a.js", sha256: sha256Hex("A") }] }, cur);
    expect(r.ok).toBe(true);
    expect((r as { files: Array<{ path: string }> }).files.map((f) => f.path)).toEqual(["a.js"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --filter @stackbase/cli test reconstruct-files`
Expected: FAIL (`reconstructFiles` not exported).

- [ ] **Step 3: Edit `packages/cli/src/deploy-apply.ts`**

Add the import at the top (alongside the existing `createHash` import):
```ts
import { sha256Hex } from "@stackbase/deploy";
```

Add the exported types + helper (place above `applyDeploy`):
```ts
export type DeployPayload =
  | { files: Array<{ path: string; code: string }> }
  | { changed: Array<{ path: string; code: string }>; unchanged: Array<{ path: string; sha256: string }> };

export type ReconstructResult =
  | { ok: true; files: Array<{ path: string; code: string }> }
  | { ok: false; error: string };

/** Rebuild the full file tree from a legacy `{files}` OR a delta `{changed, unchanged}` payload.
 *  Each `unchanged` module is resolved from `currentModules` and its sha verified; a missing path or
 *  a sha disagreement is a `stale-base` (the client retries as a full push). The union of changed +
 *  unchanged is the complete tree, so an unreferenced current module is dropped (deletion by omission). */
export function reconstructFiles(
  payload: DeployPayload,
  currentModules: Map<string, { code: string; sha: string }>,
): ReconstructResult {
  if ("changed" in payload) {
    const files = [...(payload.changed ?? [])];
    for (const u of payload.unchanged ?? []) {
      const cur = currentModules.get(u.path);
      if (!cur) return { ok: false, error: `stale-base: server has no module "${u.path}"` };
      if (cur.sha !== u.sha256) return { ok: false, error: `stale-base: module "${u.path}" hash mismatch` };
      files.push({ path: u.path, code: cur.code });
    }
    return { ok: true, files };
  }
  return { ok: true, files: payload.files ?? [] };
}
```

Update `DeployDeps` — add the field:
```ts
  /** The modules from the last successful push this server lifetime — used to resolve `unchanged`
   *  entries in a delta payload. Empty at boot (first deploy is a full push). */
  currentModules: Map<string, { code: string; sha: string }>;
```

Update `DeployResult`:
```ts
export type DeployResult =
  | { ok: true; rev: string; functions: number; modules: Map<string, { code: string; sha: string }> }
  | { ok: false; kind: "load-error" | "schema-incompatible" | "stale-base"; error: string };
```

Change `applyDeploy`'s signature + top, and its success return. Replace the function's opening (the `files` param and the `const rev = ...` line) so it reconstructs first:
```ts
export async function applyDeploy(
  deps: DeployDeps,
  payload: DeployPayload,
): Promise<DeployResult> {
  const rec = reconstructFiles(payload, deps.currentModules);
  if (!rec.ok) return { ok: false, kind: "stale-base", error: rec.error };
  const files = rec.files;
  const rev = createHash("sha256").update(JSON.stringify(files)).digest("hex").slice(0, 12);
  // ...the rest of the existing body is UNCHANGED (it already operates on `files`)...
```

Change the success `return` at the end of `applyDeploy` from:
```ts
  return { ok: true, rev, functions: Object.keys(project.moduleMap).length };
```
to:
```ts
  const modules = new Map(files.map((f) => [f.path, { code: f.code, sha: sha256Hex(f.code) }]));
  return { ok: true, rev, functions: Object.keys(project.moduleMap).length, modules };
```

(The `load-error` and `schema-incompatible` early returns are unchanged.)

- [ ] **Step 4: Run the test + build + typecheck**

Run: `bun run --filter @stackbase/deploy build && bun run --filter @stackbase/cli test reconstruct-files && bun run --filter @stackbase/cli typecheck`
Expected: reconstruct-files 5/5 PASS. Typecheck may flag the two `applyDeploy` call-sites (`serve.ts`, and any test) that still pass `files` and lack `currentModules` — those are fixed in Task 3 and Task 5. If `typecheck` fails ONLY on those call-sites, that is expected at this task boundary; note it and proceed (Task 3 resolves `serve.ts`). If a NON-call-site type error appears, fix it here.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/deploy-apply.ts packages/cli/test/reconstruct-files.test.ts
git commit -m "feat(deploy): applyDeploy reconstructs delta payloads + returns new module set"
```

---

### Task 3: Server wiring — `serve.ts` state, `deploy.modules()`, http-handler GET, host type

**Files:**
- Modify: `packages/runtime-embedded/src/host.ts` (the `ServeOptions.deploy` shape)
- Modify: `packages/cli/src/serve.ts:462` (the `deploy` object)
- Modify: `packages/cli/src/http-handler.ts:303` (POST payload + new GET branch)
- Test: covered by the Task 5 E2E (server wiring is not unit-testable in isolation); typecheck + build are the gates here.

**Interfaces:**
- Consumes: `applyDeploy`/`DeployPayload`/`DeployResult` (Task 2).
- Produces: `deploy.modules(): Record<string, string>`; the `apply` closure that owns `currentPushedModules` and returns only the wire-safe result.

- [ ] **Step 1: Edit `packages/runtime-embedded/src/host.ts`** — replace the `deploy?: { apply: ... }` field in `ServeOptions` with:

```ts
  /** `POST /_admin/deploy` + `GET /_admin/deploy/modules` handlers — present only when deploy is
   *  enabled. `apply` accepts a legacy `{files}` OR a delta `{changed, unchanged}` payload; `modules`
   *  returns the current per-path hashes for the client's delta partition. */
  deploy?: {
    apply: (
      payload:
        | { files: Array<{ path: string; code: string }> }
        | { changed: Array<{ path: string; code: string }>; unchanged: Array<{ path: string; sha256: string }> },
    ) => Promise<Deploy>;
    modules: () => Record<string, string>;
  };
```

(This stays neutral — pure data shapes, no host primitive. `Deploy` is still the type parameter the CLI pins to the wire result.)

- [ ] **Step 2: Edit `packages/cli/src/serve.ts`** — replace the `const deploy = opts.allowDeploy ? { apply: ... } : undefined;` block (lines ~462–480) with a version that owns the module-set state:

```ts
  // The modules from the last successful push this server lifetime — starts empty, so the first
  // deploy after (re)start is a full push and every later one is a true delta. Holds code (for
  // reconstructing `unchanged` entries) — NEVER serialized to the wire.
  let currentPushedModules = new Map<string, { code: string; sha: string }>();
  const deploy = opts.allowDeploy
    ? {
        apply: async (
          payload:
            | { files: Array<{ path: string; code: string }> }
            | { changed: Array<{ path: string; code: string }>; unchanged: Array<{ path: string; sha256: string }> },
        ) => {
          const result = await applyDeploy(
            {
              runtime,
              adminApi,
              setRoutes: (r) => server.setRoutes(r),
              components,
              current: () => {
                const live = adminApi.getSchema();
                return { schemaJson: toDeploySchema(live.schemaJson), tableNumbers: live.tableNumbers };
              },
              deployRoot: join(process.cwd(), ".stackbase-deploy"),
              currentModules: currentPushedModules,
            },
            payload,
          );
          if (!result.ok) return result; // { ok:false, kind, error } — wire-safe (no Map)
          currentPushedModules = result.modules; // update state; strip the Map from the wire result
          return { ok: true as const, rev: result.rev, functions: result.functions };
        },
        modules: (): Record<string, string> =>
          Object.fromEntries([...currentPushedModules].map(([p, v]) => [p, v.sha])),
      }
    : undefined;
```

- [ ] **Step 3: Edit `packages/cli/src/http-handler.ts`** — replace the POST block at line 303 and add the GET branch. Replace:

```ts
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
```

with:

```ts
  if (admin && deploy && req.method === "GET" && req.path === "/_admin/deploy/modules") {
    if (!verifyAdminKey(admin.key, bearer(req.authorization))) return json(401, { ok: false, error: "unauthorized" });
    return json(200, deploy.modules());
  }
  if (admin && deploy && req.method === "POST" && req.path === "/_admin/deploy") {
    if (!verifyAdminKey(admin.key, bearer(req.authorization))) return json(401, { ok: false, error: "unauthorized" });
    let payload:
      | { files: Array<{ path: string; code: string }> }
      | { changed: Array<{ path: string; code: string }>; unchanged: Array<{ path: string; sha256: string }> };
    try {
      payload = JSON.parse(req.body ?? "{}");
    } catch {
      return json(400, { ok: false, kind: "load-error", error: "invalid deploy payload" });
    }
    const result = await deploy.apply(payload);
    const status = result.ok ? 200 : result.kind === "schema-incompatible" || result.kind === "stale-base" ? 409 : 400;
    return json(status, result);
  }
```

- [ ] **Step 4: Build + typecheck the touched packages**

Run: `bun run build && bun run --filter @stackbase/runtime-embedded typecheck && bun run --filter @stackbase/cli typecheck`
Expected: build exit 0; typecheck clean (the Task 2 call-site error in `serve.ts` is now resolved). If a test file elsewhere calls `applyDeploy(deps, files)` with the old shape or a `deploy.apply(files)`-style mock, note it — Task 5 updates the E2E; a pre-existing `deploy-e2e.test.ts` drives the CLI end-to-end (not `apply` directly) so it should be unaffected at the type level.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime-embedded/src/host.ts packages/cli/src/serve.ts packages/cli/src/http-handler.ts
git commit -m "feat(deploy): serve holds currentPushedModules, serves GET /_admin/deploy/modules, POST accepts delta"
```

---

### Task 4: Client — `serveTarget.push` delta flow + fallbacks

**Files:**
- Modify: `packages/deploy/src/targets/serve.ts`
- Test: `packages/deploy/test/serve-target-incremental.test.ts`

**Interfaces:**
- Consumes: `partitionModules` (Task 1); the `GET /_admin/deploy/modules` + delta POST contract (Task 3).
- Produces: a `push` that probes, partitions, delta-posts, and falls back.

- [ ] **Step 1: Write the failing test `packages/deploy/test/serve-target-incremental.test.ts`**

```ts
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { serveTarget } from "../src/targets/serve";
import { sha256Hex } from "../src/module-hash";
import type { DeployContext } from "../src/types";

/** A configurable fake server recording the deploy POST body and controlling the GET + POST responses. */
function fakeServer(opts: {
  modules?: Record<string, string> | 404;
  postSequence: Array<{ status: number; body: unknown }>;
}) {
  const posts: unknown[] = [];
  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
    if (req.method === "GET" && req.url === "/_admin/deploy/modules") {
      if (opts.modules === 404 || opts.modules === undefined) return send(404, {});
      return send(200, opts.modules);
    }
    if (req.method === "POST" && req.url === "/_admin/deploy") {
      let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { posts.push(JSON.parse(b)); const next = opts.postSequence.shift()!; send(next.status, next.body); });
      return;
    }
    send(404, {});
  });
  return { server, posts };
}

function ctxFor(port: number, files: Array<{ path: string; code: string }>): DeployContext {
  return {
    cwd: "/x", convexDir: "/x/convex", env: "production",
    target: { targetName: "serve", provider: "serve", env: "production", settings: { url: `http://127.0.0.1:${port}`, adminKey: "k" } },
    interactive: false, spawn: { run: async () => ({ code: 0, stdout: "", stderr: "" }) }, log: () => {},
    packageApp: async () => ({ files }), codegen: async () => {},
  };
}

describe("serveTarget incremental push", () => {
  let server: Server | undefined;
  afterEach(() => { server?.close(); server = undefined; });

  it("delta-posts only changed modules when the server returns hashes", async () => {
    const files = [{ path: "a.js", code: "A" }, { path: "b.js", code: "B2" }];
    const fk = fakeServer({ modules: { "a.js": sha256Hex("A"), "b.js": sha256Hex("B1") }, postSequence: [{ status: 200, body: { ok: true, rev: "r1", functions: 2 } }] });
    server = fk.server; await new Promise<void>((r) => server!.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const result = await serveTarget.push(ctxFor(port, files));
    expect(result.ok).toBe(true);
    expect(fk.posts[0]).toEqual({ changed: [{ path: "b.js", code: "B2" }], unchanged: [{ path: "a.js", sha256: sha256Hex("A") }] });
  });

  it("full-pushes {files} when the modules endpoint 404s (old server / disabled)", async () => {
    const files = [{ path: "a.js", code: "A" }];
    const fk = fakeServer({ modules: 404, postSequence: [{ status: 200, body: { ok: true, rev: "r1", functions: 1 } }] });
    server = fk.server; await new Promise<void>((r) => server!.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const result = await serveTarget.push(ctxFor(port, files));
    expect(result.ok).toBe(true);
    expect(fk.posts[0]).toEqual({ files: [{ path: "a.js", code: "A" }] });
  });

  it("retries as a full push when the delta POST returns stale-base", async () => {
    const files = [{ path: "a.js", code: "A" }];
    const fk = fakeServer({
      modules: { "a.js": sha256Hex("OLD") },
      postSequence: [
        { status: 409, body: { ok: false, kind: "stale-base", error: "stale-base: ..." } },
        { status: 200, body: { ok: true, rev: "r2", functions: 1 } },
      ],
    });
    server = fk.server; await new Promise<void>((r) => server!.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const result = await serveTarget.push(ctxFor(port, files));
    expect(result.ok).toBe(true);
    expect(fk.posts).toEqual([
      { changed: [{ path: "a.js", code: "A" }], unchanged: [] }, // first: delta (a.js differs from OLD)
      { files: [{ path: "a.js", code: "A" }] }, // retry: full push
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --filter @stackbase/deploy test serve-target-incremental`
Expected: FAIL (current `push` posts `{files}`, never GETs `/modules`).

- [ ] **Step 3: Rewrite `push` in `packages/deploy/src/targets/serve.ts`**

Add the import at the top:
```ts
import { partitionModules } from "../module-hash";
```

Replace the whole `push` method with:
```ts
  async push(ctx): Promise<DeployResult> {
    const { url, adminKey } = creds(ctx);
    const base = url.replace(/\/$/, "");
    const headers = { "content-type": "application/json", authorization: `Bearer ${adminKey}` };
    const { files } = await ctx.packageApp();

    // POST helper — returns a normalized shape the flow below branches on.
    const post = async (body: string): Promise<{ ok: boolean; rev?: string; functions?: number; kind?: string; error?: string }> => {
      let res: Response;
      try {
        res = await fetch(`${base}/_admin/deploy`, { method: "POST", headers, body });
      } catch (e) {
        return { ok: false, error: `could not reach ${base}: ${e instanceof Error ? e.message : String(e)}` };
      }
      if (res.status === 404) return { ok: false, error: "deploy not enabled on target (start serve with --allow-deploy)" };
      const b = (await res.json().catch(() => ({}))) as { ok?: boolean; rev?: string; functions?: number; kind?: string; error?: string };
      return { ok: Boolean(res.ok && b.ok), rev: b.rev, functions: b.functions, kind: b.kind, error: b.error };
    };
    const done = (r: { rev?: string; functions?: number }, extra: string): DeployResult => ({ ok: true, url: base, detail: `rev ${r.rev} (${r.functions} functions${extra})` });

    // 1. Probe the server's current module hashes (capability + delta base).
    let remoteHashes: Record<string, string> | null = null;
    try {
      const res = await fetch(`${base}/_admin/deploy/modules`, { headers });
      if (res.ok) remoteHashes = (await res.json().catch(() => null)) as Record<string, string> | null;
      // A non-ok (404 old server / disabled) leaves remoteHashes null → full push below.
    } catch {
      // network error surfaces on the POST below
    }

    // 2. Delta push when we have a base; otherwise a full push.
    if (remoteHashes) {
      const { changed, unchanged } = partitionModules({ files }, remoteHashes);
      const r = await post(JSON.stringify({ changed, unchanged }));
      if (r.ok) return done(r, `, ${changed.length} changed`);
      if (r.kind === "stale-base") {
        const full = await post(JSON.stringify({ files }));
        return full.ok ? done(full, ", full retry") : { ok: false, error: full.error ?? "deploy failed" };
      }
      return { ok: false, error: r.error ?? "deploy failed" };
    }
    const r = await post(JSON.stringify({ files }));
    return r.ok ? done(r, "") : { ok: false, error: r.error ?? "deploy failed" };
  },
```

(Leave `name`, `preflight`, `package`, and the `creds` helper unchanged.)

- [ ] **Step 4: Run tests + build**

Run: `bun run --filter @stackbase/deploy test serve-target && bun run --filter @stackbase/deploy build`
Expected: the new `serve-target-incremental` 3/3 PASS, the existing `serve-target` tests still PASS (the full-push path is preserved — the old test's server has no `/modules` route, so its GET 404s → full push → same `{ files }` body it already asserts). Build exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/deploy/src/targets/serve.ts packages/deploy/test/serve-target-incremental.test.ts
git commit -m "feat(deploy): serveTarget delta push — probe hashes, partition, full-push fallback + stale-base retry"
```

---

### Task 5: E2E through a real `serve --allow-deploy`

**Files:**
- Create: `packages/cli/test/incremental-push-e2e.test.ts`

**Interfaces:**
- Consumes: everything above; the serve-boot helper pattern from `packages/cli/test/deploy-e2e.test.ts`.

- [ ] **Step 1: Read the existing E2E for the boot helper**

Open `packages/cli/test/deploy-e2e.test.ts` and identify how it (a) starts a real `serve --allow-deploy` yielding `{ url, adminKey }`, (b) builds a convex fixture dir, and (c) drives `deployCommand`. Reuse that exact setup (import the helper if exported; otherwise copy the boot half into the new file). Name the new file `*-e2e.test.ts` so it runs only in the serial lane.

- [ ] **Step 2: Write the E2E `packages/cli/test/incremental-push-e2e.test.ts`**

Cover these cases against ONE booted `serve --allow-deploy` (deploying via `deployCommand` with `--url`/`--dir`, or by driving `serveTarget.push` with a real `DeployContext` — match whichever `deploy-e2e.test.ts` already uses):

```ts
// Pseudocode structure — fill the boot wiring from deploy-e2e.test.ts.
// 1. Deploy v1 (a fixture with functions f1, f2). GET /_admin/deploy/modules first returns {} → this
//    is a full push. Assert it succeeds and f1 is callable.
// 2. Directly GET `${url}/_admin/deploy/modules` with the admin key → now returns hashes for v1's modules.
// 3. Deploy v2 that changes ONLY f2's file. Capture the POST body (spy the fetch, or assert via a
//    wrapper): assert `changed` has exactly the f2 module and `unchanged` contains f1. Assert f2's new
//    behavior is live AND fans out reactively to a WebSocket subscription opened BEFORE the deploy
//    (mirror deploy-e2e.test.ts's reactive assertion).
// 4. Stale-base retry: force a mismatch — after v2, hand the client a stale hash base (e.g. call
//    serveTarget.push against a DeployContext whose packageApp differs from what the modules endpoint
//    reports by manually POSTing a delta with a wrong `unchanged` sha) → server 409 stale-base → the
//    client's transparent full-push retry succeeds. (If simpler: unit-level stale-base is already
//    covered in Task 4; here assert at least that a normal second delta deploy works end to end.)
// 5. Old-server fallback: POST to a server route that 404s `/modules` is already covered by Task 4's
//    unit; at E2E level, assert the full-push path by deploying to the same server with the modules
//    endpoint reachable (the capability path). (Do not spin a second "old" server unless cheap.)
```

Keep the E2E focused on the two highest-value real proofs: **(3)** a one-file delta deploy is live + reactive, and **(1→2)** the modules endpoint reflects the pushed set. Cases 4–5 are already unit-covered (Task 4); include them at E2E only if the boot harness makes them cheap.

- [ ] **Step 3: Run the E2E**

Run: `bun run build && bun run --filter @stackbase/cli test:e2e incremental-push`
Expected: PASS. If the reactive assertion flakes on timing, arm it deterministically the way `deploy-e2e.test.ts` does (await the subscription's next value), never a fixed sleep.

- [ ] **Step 4: Confirm no regression in the existing deploy E2E**

Run: `bun run --filter @stackbase/cli test:e2e deploy-e2e`
Expected: the pre-existing `deploy-e2e.test.ts` still PASSES (the legacy full-push path is intact through the new server).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/test/incremental-push-e2e.test.ts
git commit -m "test(deploy): incremental push E2E — one-file delta deploy is live + reactive through real serve"
```

---

## Self-Review

**1. Spec coverage:**
- GET `/_admin/deploy/modules` (auth + gate) → Task 3. ✓
- POST accepts `{files}` OR `{changed, unchanged}` → Task 3 (parse) + Task 2 (reconstruct). ✓
- `sha256Hex` shared, over transpiled code → Task 1, used by Task 2 (server) + Task 4 (client). ✓
- Boot characteristic (empty at boot, first push full) → Task 3 (`currentPushedModules = new Map()` per lifetime). ✓
- Server reconstruction + integrity + stale-base → Task 2. ✓
- New module set never on the wire (Map stays server-side) → Task 3 (`apply` closure strips it). ✓
- Client probe → partition → delta → 404-full-push → stale-base-retry → Task 4. ✓
- Deletion by omission → Task 1 (partition) + Task 2 (reconstruct) tests. ✓
- Back-compat matrix (4 combos) → Task 4 unit (new/new, new/old) + legacy path preserved (old/new via Task 3 POST parse, old/old untouched). ✓
- E2E through real serve → Task 5. ✓

**2. Placeholder scan:** Task 5 Step 2 is intentionally a structured pseudocode skeleton because the boot wiring must be copied from the actual `deploy-e2e.test.ts` (which the implementer reads in Step 1) rather than guessed — the two real proofs it must assert are stated concretely (one-file delta is live+reactive; modules endpoint reflects the pushed set). No other placeholders.

**3. Type consistency:** `sha256Hex(code: string): string`, `partitionModules(FileTree, Record<string,string>): DeltaPush`, `reconstructFiles(DeployPayload, Map<string,{code,sha}>): ReconstructResult`, `DeployResult` success `.modules: Map<string,{code,sha}>`, failure `kind` incl. `"stale-base"`, and `ServeOptions.deploy.{apply,modules}` are used identically across Tasks 2/3/4. The wire result the CLI pins to `Deploy` is `{ok:true,rev,functions} | {ok:false,kind,error}` (Map excluded) — consistent with the `apply` closure's return in Task 3.
