/**
 * The single-shard Worker router (`createWorkerHandler`) — Node unit coverage of the deployment-level
 * placement hint (`STACKBASE_DO_LOCATION_HINT`). A real workerd `DurableObjectNamespace` is driven end
 * to end by the workers-tier suite; here a recording fake namespace lets us assert EXACTLY how `get`
 * is called (with vs without the options bag), which is the load-bearing detail for placement and for
 * the byte-identical-when-unset guarantee.
 */
import { describe, it, expect } from "vitest";
import { createWorkerHandler, DEFAULT_SHARD_NAME } from "../src/worker";

/** A fake namespace that records every `get(id, opts?)` call's options bag (or `undefined`). */
function fakeNamespace() {
  const calls: Array<{ name: string; opts: unknown }> = [];
  const ns = {
    idFromName(name: string) {
      return name;
    },
    get(id: string, opts?: unknown) {
      calls.push({ name: id, opts });
      return {
        async fetch(): Promise<Response> {
          return new Response("ok", { status: 200 });
        },
      };
    },
  };
  return { ns, calls };
}

describe("createWorkerHandler — deployment location hint", () => {
  it("passes NO options bag when the hint env is unset (byte-identical to pre-hint)", async () => {
    const handler = createWorkerHandler("STACKBASE_DO");
    const { ns, calls } = fakeNamespace();
    const res = await handler.fetch(new Request("https://w.test/api/health"), { STACKBASE_DO: ns });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe(DEFAULT_SHARD_NAME);
    expect(calls[0]!.opts).toBeUndefined(); // no second arg at all
  });

  it("threads a valid STACKBASE_DO_LOCATION_HINT into get(id, { locationHint })", async () => {
    const handler = createWorkerHandler("STACKBASE_DO");
    const { ns, calls } = fakeNamespace();
    const res = await handler.fetch(new Request("https://w.test/api/health"), {
      STACKBASE_DO: ns,
      STACKBASE_DO_LOCATION_HINT: "enam",
    });
    expect(res.status).toBe(200);
    expect(calls[0]!.opts).toEqual({ locationHint: "enam" });
  });

  it("treats an empty-string hint as unset (no options bag)", async () => {
    const handler = createWorkerHandler("STACKBASE_DO");
    const { ns, calls } = fakeNamespace();
    await handler.fetch(new Request("https://w.test/api/health"), {
      STACKBASE_DO: ns,
      STACKBASE_DO_LOCATION_HINT: "",
    });
    expect(calls[0]!.opts).toBeUndefined();
  });

  it("rejects an INVALID hint with a loud 500 at the edge, never reaching a DO", async () => {
    const handler = createWorkerHandler("STACKBASE_DO");
    const { ns, calls } = fakeNamespace();
    const res = await handler.fetch(new Request("https://w.test/api/health"), {
      STACKBASE_DO: ns,
      STACKBASE_DO_LOCATION_HINT: "atlantis",
    });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("STACKBASE_DO_LOCATION_HINT");
    expect(calls).toHaveLength(0); // never forwarded — a bad hint would mis-place the DO permanently
  });

  it("500s when the DO binding is missing (unchanged)", async () => {
    const handler = createWorkerHandler("STACKBASE_DO");
    const res = await handler.fetch(new Request("https://w.test/api/health"), {});
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("STACKBASE_DO");
  });
});
