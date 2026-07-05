// packages/admin/src/router.ts
import type { JSONValue } from "@helipod/values";
import { verifyAdminKey } from "./auth";
import type { AdminApi } from "./admin-api";

export interface AdminRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body?: string;
  authorization?: string;
}
export interface AdminResponse {
  status: number;
  body: JSONValue;
}

function bearer(authorization?: string): string | undefined {
  if (!authorization) return undefined;
  const m = /^Bearer (.+)$/.exec(authorization);
  return m ? m[1] : undefined;
}

export async function handleAdminRequest(api: AdminApi, adminKey: string, req: AdminRequest): Promise<AdminResponse> {
  if (!verifyAdminKey(adminKey, bearer(req.authorization))) {
    return { status: 401, body: { error: "unauthorized" } };
  }
  const parts = req.path.split("/").filter(Boolean); // ["_admin", ...]
  const seg = parts.slice(1); // drop "_admin"

  try {
    if (req.method === "GET" && seg.length === 1 && seg[0] === "tables") {
      return { status: 200, body: (await api.listTables()) as unknown as JSONValue };
    }
    if (req.method === "GET" && seg.length === 3 && seg[0] === "tables" && seg[2] === "data") {
      const cursor = req.query.cursor ?? null;
      const pageSize = req.query.pageSize ? Number(req.query.pageSize) : undefined;
      const data = await api.getTableData(decodeURIComponent(seg[1]!), { cursor, pageSize });
      return { status: 200, body: data as unknown as JSONValue };
    }
    if (req.method === "GET" && seg.length === 1 && seg[0] === "functions") {
      return { status: 200, body: api.listFunctions() as unknown as JSONValue };
    }
    if (req.method === "POST" && seg.length === 1 && seg[0] === "run") {
      const { path, args } = JSON.parse(req.body ?? "{}") as { path?: string; args?: JSONValue };
      if (!path) return { status: 400, body: { error: "missing path" } };
      return { status: 200, body: (await api.runFunction(path, args ?? {})) as unknown as JSONValue };
    }
    if (req.method === "GET" && seg.length === 1 && seg[0] === "logs") {
      const since = req.query.since ? Number(req.query.since) : undefined;
      return { status: 200, body: api.queryLogs({ since }) as unknown as JSONValue };
    }
    if (req.method === "PATCH" && seg.length === 4 && seg[0] === "tables" && seg[2] === "docs") {
      const fields = JSON.parse(req.body ?? "{}") as Record<string, JSONValue>;
      return { status: 200, body: await api.patchDocument(seg[3]!, fields) };
    }
    if (req.method === "DELETE" && seg.length === 4 && seg[0] === "tables" && seg[2] === "docs") {
      await api.deleteDocument(seg[3]!);
      return { status: 200, body: { ok: true } };
    }
    if (req.method === "POST" && seg.length === 3 && seg[0] === "tables" && seg[2] === "docs") {
      const fields = JSON.parse(req.body ?? "{}") as Record<string, JSONValue>;
      return { status: 200, body: await api.createDocument(decodeURIComponent(seg[1]!), fields) };
    }
    // Data migration (Slice 5) — export/import the app's full materialized state. Works on both the
    // container `serve` path and the Cloudflare DO host (both route `/_admin/*` through here). The DO's
    // store is writable only from inside the DO, and this runs inside it.
    if (req.method === "GET" && seg.length === 1 && seg[0] === "export") {
      return { status: 200, body: (await api.exportDump()) as unknown as JSONValue };
    }
    if (req.method === "POST" && seg.length === 1 && seg[0] === "import") {
      return { status: 200, body: (await api.importDump(req.body ?? "")) as unknown as JSONValue };
    }
    return { status: 404, body: { error: "not found" } };
  } catch (e) {
    return { status: 400, body: { error: e instanceof Error ? e.message : String(e) } };
  }
}
