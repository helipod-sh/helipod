/**
 * The DO HOST proven inside a REAL Durable Object (workerd) — the highest fidelity achievable without
 * a Cloudflare account. `FixtureHelipodDO extends HelipodDurableObject` boots the fixture app on
 * real `ctx.storage.sql`; the test drives it through the DO stub's `fetch` (HTTP) and a REAL
 * WebSocket (the reactive sync socket), proving: boot, health, a committing `/api/run` mutation +
 * read-back, and the flagship subscribe → commit → push fan-out — reactivity ACROSS a real DO.
 *
 * This is the real-workerd tier of §6.3. The one thing it does NOT cover (needs a real deploy, which
 * this worktree has no Cloudflare login for): cross-datacenter write LATENCY vs the container→R2
 * number, and real hibernation eviction timing. See ./README for the human-run deploy E2E.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";

interface DoNs {
  idFromName(n: string): unknown;
  get(id: unknown): { fetch(req: Request): Promise<Response & { webSocket?: WebSocket }> };
}
const DO = () => (env as { HELIPOD_DO: DoNs }).HELIPOD_DO;
const stub = (name: string) => DO().get(DO().idFromName(name));

function post(path: string, bodyObj: unknown): Request {
  return new Request(`https://do.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(bodyObj),
  });
}

describe("HelipodDurableObject on REAL workerd", () => {
  it("serves GET /api/health", async () => {
    const res = await stub("health").fetch(new Request("https://do.test/api/health"));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ok");
  });

  it("commits a mutation via POST /api/run and reads it back (real DO-SQLite)", async () => {
    const s = stub("run");
    const run = await s.fetch(post("/api/run", { path: "messages:send", args: { conversationId: "c1", body: "on-workerd" } }));
    expect(run.status).toBe(200);
    expect(typeof (await run.json()).value).toBe("string");
    const read = await s.fetch(post("/api/run", { path: "messages:list", args: { conversationId: "c1" } }));
    const rows = (await read.json()).value as Array<{ body: string }>;
    expect(rows.map((r) => r.body)).toEqual(["on-workerd"]);
  });

  it("fans a commit out to a REAL WebSocket subscription (subscribe → commit → push)", async () => {
    const s = stub("reactive");
    // Open a real WebSocket to the DO's sync endpoint.
    const upgrade = await s.fetch(
      new Request("https://do.test/api/sync", { headers: { Upgrade: "websocket" } }),
    );
    expect(upgrade.status).toBe(101);
    const ws = upgrade.webSocket!;
    ws.accept();

    const received: string[] = [];
    ws.addEventListener("message", (e: MessageEvent) => {
      received.push(typeof e.data === "string" ? e.data : "");
    });

    // Subscribe to messages:list for c9.
    ws.send(JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "messages:list", args: { conversationId: "c9" } }], remove: [] }));
    await waitFor(() => received.some((m) => m.includes("Transition")));

    // A DIFFERENT client commits a write to the subscribed table.
    const before = received.length;
    await s.fetch(post("/api/run", { path: "messages:send", args: { conversationId: "c9", body: "reactive-on-workerd" } }));

    // The socket receives the reactive push it did not make — reactivity across a real DO.
    await waitFor(() => received.length > before && received.join("").includes("reactive-on-workerd"));
    expect(received.join("")).toContain("reactive-on-workerd");
    ws.close();
  });
});

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
