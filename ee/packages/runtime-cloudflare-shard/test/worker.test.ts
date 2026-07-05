/* Helipod Enterprise. Licensed under the Helipod Commercial License — see ee/LICENSE. */
import { describe, it, expect } from "vitest";
import { createShardWorkerHandler, DEFAULT_SHARD_NAME } from "../src/worker";
import { shardDoName } from "../src/canonical";
import { generateShardWorkerEntrySource } from "../src/worker-entry";

/** A fake DO namespace that records which name each request was routed to. `idFromName` returns the
 *  name verbatim as its "id" so the test can assert routing without a real DO. */
function fakeNamespace() {
  const routed: Array<{ name: string; url: string; opts: unknown }> = [];
  const ns = {
    idFromName(name: string) {
      return name;
    },
    get(id: string, opts?: unknown) {
      return {
        async fetch(req: Request): Promise<Response> {
          routed.push({ name: id, url: req.url, opts });
          return new Response(JSON.stringify({ servedBy: id }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      };
    },
  };
  return { ns, routed };
}

describe("createShardWorkerHandler — forwarding", () => {
  it("forwards a keyed request to the DO named for that shard key", async () => {
    const handler = createShardWorkerHandler("HELIPOD_DO");
    const { ns, routed } = fakeNamespace();
    const res = await handler.fetch(
      new Request("https://w.test/api/sync?shard=roomA", { headers: { Upgrade: "websocket" } }),
      { HELIPOD_DO: ns },
    );
    expect(res.status).toBe(200);
    expect(routed).toHaveLength(1);
    expect(routed[0]!.name).toBe(shardDoName("roomA"));
  });

  it("routes two distinct keys to two distinct DOs (isolation at the router)", async () => {
    const handler = createShardWorkerHandler("HELIPOD_DO");
    const { ns, routed } = fakeNamespace();
    await handler.fetch(new Request("https://w.test/api/sync?shard=roomA"), { HELIPOD_DO: ns });
    await handler.fetch(new Request("https://w.test/api/sync?shard=roomB"), { HELIPOD_DO: ns });
    expect(routed[0]!.name).not.toBe(routed[1]!.name);
  });

  it("routes an unkeyed request to the default DO", async () => {
    const handler = createShardWorkerHandler("HELIPOD_DO");
    const { ns, routed } = fakeNamespace();
    await handler.fetch(new Request("https://w.test/api/health"), { HELIPOD_DO: ns });
    expect(routed[0]!.name).toBe(DEFAULT_SHARD_NAME);
  });

  it("returns the typed fan-out error WITHOUT forwarding (mode 'key' has no enumerable shard set)", async () => {
    const handler = createShardWorkerHandler("HELIPOD_DO");
    const { ns, routed } = fakeNamespace();
    const res = await handler.fetch(new Request("https://w.test/api/run?fanout=1"), { HELIPOD_DO: ns });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("FANOUT_REQUIRES_FIXED_SHARDS");
    expect(routed).toHaveLength(0); // never reached a DO
  });

  it("500s when the DO binding is missing", async () => {
    const handler = createShardWorkerHandler("HELIPOD_DO");
    const res = await handler.fetch(new Request("https://w.test/api/health"), {});
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("HELIPOD_DO");
  });

  it("passes { locationHint } to get(id, opts) for an explicit ?region= request", async () => {
    const handler = createShardWorkerHandler("HELIPOD_DO");
    const { ns, routed } = fakeNamespace();
    const res = await handler.fetch(new Request("https://w.test/api/sync?shard=roomA&region=enam"), { HELIPOD_DO: ns });
    expect(res.status).toBe(200);
    expect(routed).toHaveLength(1);
    expect(routed[0]!.name).toBe(shardDoName("roomA"));
    expect(routed[0]!.opts).toEqual({ locationHint: "enam" });
  });

  it("passes NO options bag when there is no region hint (byte-identical to pre-hint)", async () => {
    const handler = createShardWorkerHandler("HELIPOD_DO");
    const { ns, routed } = fakeNamespace();
    await handler.fetch(new Request("https://w.test/api/sync?shard=roomA"), { HELIPOD_DO: ns });
    expect(routed[0]!.opts).toBeUndefined(); // no second arg at all
  });

  it("rejects an invalid region at the edge (400), never forwarding to a DO", async () => {
    const handler = createShardWorkerHandler("HELIPOD_DO");
    const { ns, routed } = fakeNamespace();
    const res = await handler.fetch(new Request("https://w.test/api/sync?shard=roomA&region=atlantis"), { HELIPOD_DO: ns });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_REGION_HINT");
    expect(routed).toHaveLength(0);
  });
});

describe("generateShardWorkerEntrySource", () => {
  const inputs = {
    moduleImports: [{ key: "messages", absPath: "/app/convex/messages.ts" }],
    schemaAbsPath: "/app/convex/schema.ts",
    configAbsPath: null,
    bindingName: "HELIPOD_DO",
    doClassName: "HelipodDO",
  };

  it("default-exports the MULTI-shard handler and subclasses the FREE DO class", () => {
    const src = generateShardWorkerEntrySource(inputs);
    expect(src).toContain("createShardWorkerHandler(\"HELIPOD_DO\"");
    expect(src).toContain("import { HelipodDurableObject }");
    expect(src).toContain("export class HelipodDO extends HelipodDurableObject");
    // It must NOT reach for the single-shard handler — that is the licensing switch.
    expect(src).not.toContain("createWorkerHandler(");
    // `loaded` is threaded to the router for arg-derivation.
    expect(src).toContain(", loaded }");
  });

  it("emits mode 'hash' with numShards when requested", () => {
    const src = generateShardWorkerEntrySource({ ...inputs, mode: "hash", numShards: 8 });
    expect(src).toContain('mode: "hash"');
    expect(src).toContain("numShards: 8");
  });

  it("threads regionPrefixedKeys into the route options only when opted in", () => {
    expect(generateShardWorkerEntrySource(inputs)).not.toContain("regionPrefixedKeys");
    const on = generateShardWorkerEntrySource({ ...inputs, regionPrefixedKeys: true });
    expect(on).toContain("regionPrefixedKeys: true");
  });

  it("wires an R2 blob store into the shard-DO's appConfig when r2BindingName is set", () => {
    const withR2 = generateShardWorkerEntrySource({ ...inputs, r2BindingName: "STORAGE_BUCKET" });
    expect(withR2).toContain(`import { R2BlobStore } from "@helipod/blobstore-r2";`);
    expect(withR2).toContain(`env["STORAGE_BUCKET"]`);
    expect(withR2).toContain(`new R2BlobStore({ bucket: __bucket })`);
    expect(withR2).not.toMatch(/\bawait\b/); // Worker top level must stay synchronous
  });

  it("omits the R2 import + blobStore when r2BindingName is absent (byte-less deploy)", () => {
    const src = generateShardWorkerEntrySource(inputs);
    expect(src).not.toContain("@helipod/blobstore-r2");
    expect(src).not.toContain("R2BlobStore");
  });

  it("composes R2 wiring with hash-mode + regionPrefixedKeys without interference", () => {
    const src = generateShardWorkerEntrySource({
      ...inputs,
      mode: "hash",
      numShards: 4,
      regionPrefixedKeys: true,
      r2BindingName: "STORAGE_BUCKET",
    });
    expect(src).toContain('mode: "hash"');
    expect(src).toContain("numShards: 4");
    expect(src).toContain("regionPrefixedKeys: true");
    expect(src).toContain(`import { R2BlobStore } from "@helipod/blobstore-r2";`);
    expect(src).toContain(`new R2BlobStore({ bucket: __bucket })`);
  });
});
