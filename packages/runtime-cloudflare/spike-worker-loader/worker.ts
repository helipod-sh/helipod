/**
 * THROWAWAY SPIKE (Slice 4) — NOT SHIPPABLE, NOT IN THE BUILD. See ./README.md.
 *
 * A real-Cloudflare-deployable proof of the Slice-4 crux: run "user code" in a Worker Loader /
 * Dynamic Worker sandbox with `globalOutbound: null` (no egress), whose ONLY capability is a syscall
 * channel back to a host — modelled on the engine's REAL ABI `call(op, argJson) => Promise<string>`
 * (`packages/executor/src/kernel.ts:205-207`).
 *
 * Structured the way Slice 4's DO host will structure it:
 *   - `SyscallHost` (a WorkerEntrypoint) == the transactor DO's syscall host. In the real slice it
 *     closes over the in-flight KernelContext/txn; here it answers a toy in-memory per-tenant store.
 *     It is scoped to ONE tenant via `ctx.props.tenant` (capability-based: the host decides whose
 *     data a stub reaches — the child never names a tenant).
 *   - the child module string == the guest half of the split executor (user handler + guest db
 *     facade + syscall channel). Here it is hand-written to exercise the same `env.HOST.syscall(...)`
 *     call the real `RpcSyscallChannel` will make.
 *
 * NOTE: types here lean on `@cloudflare/workers-types` (Jul 2026), which DOES type Worker Loader,
 * even though this repo's pinned *runtime* (workerd Dec 2024) cannot execute it. That mismatch is
 * the whole point of the README's fidelity warning.
 */
import { WorkerEntrypoint } from "cloudflare:workers";

// ---------------------------------------------------------------------------
// The host side (== the transactor DO's syscall host in the real slice).
// ---------------------------------------------------------------------------

interface HostProps {
  /** The tenant this stub is scoped to. Set by the trusted parent via ctx.exports(...props). The
   *  child cannot forge it (props are set by whoever can deploy the callee — CF's guarantee). */
  tenant: string;
}

/** A toy per-tenant store so `db.get`/`db.query` return something tenant-specific. The real host
 *  dispatches into `createKernelRouter()` bound to the live transaction (`executor.ts:442`). */
const TENANT_DATA: Record<string, Array<{ _id: string; body: string }>> = {
  "tenant-A": [{ _id: "msg_a1", body: "hello from A" }],
  "tenant-B": [{ _id: "msg_b1", body: "hello from B" }],
};

export class SyscallHost extends WorkerEntrypoint<Env, HostProps> {
  /**
   * The syscall entry point — SAME SHAPE as `SyscallChannel.call` (`kernel.ts:205-207`):
   * op-string-discriminated, JSON-string in, JSON-string out. This is what the child's
   * `RpcSyscallChannel` invokes over Cap'n Web RPC.
   */
  async syscall(op: string, argJson: string): Promise<string> {
    const tenant = this.ctx.props.tenant; // capability scope — NOT taken from the child's args
    const rows = TENANT_DATA[tenant] ?? [];
    switch (op) {
      case "db.get": {
        const { id } = JSON.parse(argJson) as { id: string };
        const doc = rows.find((r) => r._id === id) ?? null;
        return JSON.stringify(doc);
      }
      case "db.query": {
        // Ignores any table/tenant the child might try to name — always scoped to `tenant`.
        return JSON.stringify({ docs: rows });
      }
      default:
        // Mirrors the router's unknown-op behavior (`kernel.ts:217`).
        return JSON.stringify({ error: `FunctionNotFound: unknown syscall op '${op}'` });
    }
  }
}

// ---------------------------------------------------------------------------
// The "user code" that will run INSIDE the sandbox isolate (guest half).
// Written as a module string because Worker Loader takes code as strings.
// It exercises exactly what the real guest channel does: one blocked fetch(),
// one syscall round-trip, and no way to name another tenant.
// ---------------------------------------------------------------------------

const CHILD_MODULE = /* js */ `
export default {
  async fetch(request, env) {
    const report = { fetchThrew: false, syscallResult: null, crossTenantAttempt: null };

    // (a) egress must be dead — globalOutbound:null makes fetch() throw.
    try {
      await fetch("https://example.com/");
      report.fetchThrew = false;                 // reached the network → FAIL
    } catch (_e) {
      report.fetchThrew = true;                  // threw → PASS
    }

    // (b) the syscall channel works — call back to the host stub in env.
    const raw = await env.HOST.syscall("db.get", JSON.stringify({ id: env.ARG_ID }));
    report.syscallResult = JSON.parse(raw);

    // (c) the child cannot reach another tenant: it has ONE stub (env.HOST), already scoped by the
    // host to its own tenant. Even if it passes a bogus tenant in args, the host ignores it.
    const rawCross = await env.HOST.syscall("db.query", JSON.stringify({ tenant: "tenant-B" }));
    report.crossTenantAttempt = JSON.parse(rawCross);

    return new Response(JSON.stringify(report), { headers: { "content-type": "application/json" } });
  },
};
`;

// ---------------------------------------------------------------------------
// The parent Worker — loads the sandbox per tenant and runs the assertions.
// ---------------------------------------------------------------------------

interface Env {
  LOADER: WorkerLoader; // from the worker_loaders binding in wrangler.jsonc
}

async function runTenant(env: Env, ctx: ExecutionContext, tenant: string, argId: string) {
  // The capability the child gets: a SyscallHost stub scoped to THIS tenant via props.
  const hostStub = (ctx as unknown as { exports: { SyscallHost: (opts: { props: HostProps }) => unknown } })
    .exports.SyscallHost({ props: { tenant } });

  // get(id, callback) keeps the isolate warm across requests (§4 pool decision). Keyed per tenant.
  const worker = env.LOADER.get(`spike-${tenant}`, async () => ({
    compatibilityDate: "2026-06-24",
    mainModule: "user.js",
    modules: { "user.js": CHILD_MODULE },
    globalOutbound: null, // ← the egress kill switch
    env: { HOST: hostStub, ARG_ID: argId }, // ← the ONLY capability + the call args
  }));

  const res = await worker.getEntrypoint().fetch(new Request("https://sandbox.internal/"));
  return (await res.json()) as {
    fetchThrew: boolean;
    syscallResult: { _id: string; body: string } | null;
    crossTenantAttempt: { docs: Array<{ _id: string }> };
  };
}

export default {
  async fetch(_request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const a = await runTenant(env, ctx, "tenant-A", "msg_a1");
      const b = await runTenant(env, ctx, "tenant-B", "msg_b1");

      const report = {
        a_egress_blocked: {
          pass: a.fetchThrew && b.fetchThrew,
          detail: a.fetchThrew ? "child fetch() threw as expected" : "FAIL: child reached the network",
        },
        b_syscall_roundtrip: {
          pass: a.syscallResult?._id === "msg_a1" && b.syscallResult?._id === "msg_b1",
          detail: `A got ${a.syscallResult?._id}, B got ${b.syscallResult?._id} via RPC`,
        },
        c_tenant_isolation: {
          // A's cross-tenant db.query (even naming tenant-B) must return ONLY A's rows, because the
          // host scopes by ctx.props, not by the child's argument.
          pass: a.crossTenantAttempt.docs.every((d) => d._id.startsWith("msg_a")),
          detail: `tenant-A's stub saw: ${a.crossTenantAttempt.docs.map((d) => d._id).join(",")}`,
        },
      };
      const allPass = Object.values(report).every((c) => c.pass);
      return new Response(JSON.stringify(report, null, 2), {
        status: allPass ? 200 : 500,
        headers: { "content-type": "application/json" },
      });
    } catch (e) {
      // Most likely on a stale runtime: `env.LOADER` undefined or `ctx.exports` missing.
      return new Response(
        JSON.stringify({ error: "spike threw — likely no Worker Loader on this runtime", detail: String(e) }, null, 2),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  },
};
