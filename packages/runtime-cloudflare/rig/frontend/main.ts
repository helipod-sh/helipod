// Live-reactive browser frontend for the DO host. Uses @stackbase/client's framework-agnostic
// WebSocket transport — subscribe() pushes updates over `/api/sync` (the DO's SyncProtocolHandler),
// so a message another tab sends appears here with NO poll. Built with `bun build` on the workspace
// (where @stackbase/client resolves) → public/main.js, served as a static asset. The server-side
// Worker/DO bundle never imports this.
import { StackbaseClient, webSocketTransport } from "@stackbase/client";

const CONV = "demo";
const proto = location.protocol === "https:" ? "wss" : "ws";
const client = new StackbaseClient(webSocketTransport(`${proto}://${location.host}/api/sync`));

const log = document.getElementById("log")!;
const stat = document.getElementById("stat")!;
const connEl = document.getElementById("conn")!;

type Msg = { _id: string; _creationTime: number; conversationId: string; body: string };

function render(rows: Msg[]): void {
  log.innerHTML = "";
  for (const m of rows) {
    const d = document.createElement("div");
    d.className = "msg";
    const b = document.createElement("div");
    b.className = "b";
    b.textContent = m.body;
    const t = document.createElement("div");
    t.className = "t";
    t.textContent = new Date(m._creationTime).toLocaleTimeString();
    d.append(b, t);
    log.append(d);
  }
  log.scrollTop = log.scrollHeight;
  stat.textContent = `${rows.length} msg · live`;
}

// LIVE subscription — the server pushes on every commit that intersects this query's read-set.
// No polling. Open a second tab and watch a message appear here instantly.
client.subscribe("messages:list", { conversationId: CONV }, (value) => {
  render((Array.isArray(value) ? value : []) as Msg[]);
});
connEl.textContent = "● live (WebSocket push)";

document.getElementById("f")!.addEventListener("submit", async (e) => {
  e.preventDefault();
  const i = document.getElementById("i") as HTMLInputElement;
  const body = i.value.trim();
  if (!body) return;
  i.value = "";
  await client.mutation("messages:send", { conversationId: CONV, body });
  // No manual refresh — the subscription re-pushes the new list automatically.
});
