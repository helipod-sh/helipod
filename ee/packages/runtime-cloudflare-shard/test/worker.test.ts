/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
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
    const handler = createShardWorkerHandler("STACKBASE_DO");
    const { ns, routed } = fakeNamespace();
    const res = await handler.fetch(
      new Request("https://w.test/api/sync?shard=roomA", { headers: { Upgrade: "websocket" } }),
      { STACKBASE_DO: ns },
    );
    expect(res.status).toBe(200);
    expect(routed).toHaveLength(1);
    expect(routed[0]!.name).toBe(shardDoName("roomA"));
  });

  it("routes two distinct keys to two distinct DOs (isolation at the router)", async () => {
    const handler = createShardWorkerHandler("STACKBASE_DO");
    const { ns, routed } = fakeNamespace();
    await handler.fetch(new Request("https://w.test/api/sync?shard=roomA"), { STACKBASE_DO: ns });
    await handler.fetch(new Request("https://w.test/api/sync?shard=roomB"), { STACKBASE_DO: ns });
    expect(routed[0]!.name).not.toBe(routed[1]!.name);
  });

  it("routes an unkeyed request to the default DO", async () => {
    const handler = createShardWorkerHandler("STACKBASE_DO");
    const { ns, routed } = fakeNamespace();
    await handler.fetch(new Request("https://w.test/api/health"), { STACKBASE_DO: ns });
    expect(routed[0]!.name).toBe(DEFAULT_SHARD_NAME);
  });

  it("returns the typed cross-shard error WITHOUT forwarding", async () => {
    const handler = createShardWorkerHandler("STACKBASE_DO");
    const { ns, routed } = fakeNamespace();
    const res = await handler.fetch(new Request("https://w.test/api/run?fanout=1"), { STACKBASE_DO: ns });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("CROSS_SHARD_UNSUPPORTED");
    expect(routed).toHaveLength(0); // never reached a DO
  });

  it("500s when the DO binding is missing", async () => {
    const handler = createShardWorkerHandler("STACKBASE_DO");
    const res = await handler.fetch(new Request("https://w.test/api/health"), {});
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("STACKBASE_DO");
  });

  it("passes { locationHint } to get(id, opts) for an explicit ?region= request", async () => {
    const handler = createShardWorkerHandler("STACKBASE_DO");
    const { ns, routed } = fakeNamespace();
    const res = await handler.fetch(new Request("https://w.test/api/sync?shard=roomA&region=enam"), { STACKBASE_DO: ns });
    expect(res.status).toBe(200);
    expect(routed).toHaveLength(1);
    expect(routed[0]!.name).toBe(shardDoName("roomA"));
    expect(routed[0]!.opts).toEqual({ locationHint: "enam" });
  });

  it("passes NO options bag when there is no region hint (byte-identical to pre-hint)", async () => {
    const handler = createShardWorkerHandler("STACKBASE_DO");
    const { ns, routed } = fakeNamespace();
    await handler.fetch(new Request("https://w.test/api/sync?shard=roomA"), { STACKBASE_DO: ns });
    expect(routed[0]!.opts).toBeUndefined(); // no second arg at all
  });

  it("rejects an invalid region at the edge (400), never forwarding to a DO", async () => {
    const handler = createShardWorkerHandler("STACKBASE_DO");
    const { ns, routed } = fakeNamespace();
    const res = await handler.fetch(new Request("https://w.test/api/sync?shard=roomA&region=atlantis"), { STACKBASE_DO: ns });
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
    bindingName: "STACKBASE_DO",
    doClassName: "StackbaseDO",
  };

  it("default-exports the MULTI-shard handler and subclasses the FREE DO class", () => {
    const src = generateShardWorkerEntrySource(inputs);
    expect(src).toContain("createShardWorkerHandler(\"STACKBASE_DO\"");
    expect(src).toContain("import { StackbaseDurableObject }");
    expect(src).toContain("export class StackbaseDO extends StackbaseDurableObject");
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
});
