// A minimal admin sync client for the data browser: authenticates with the admin key and keeps ONE
// live subscription to _admin:browseTable, re-subscribing when table/cursor/filter change.
export interface AdminTransport {
  send(msg: unknown): void;
  onMessage(cb: (msg: unknown) => void): void;
  close(): void;
}
export interface BrowsePage {
  documents: Record<string, unknown>[];
  nextCursor: string | null;
  hasMore: boolean;
  scanCapped: boolean;
}
export interface FilterCond {
  field: string;
  op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte";
  value: unknown;
}

export class AdminBrowse {
  private queryId = 0;
  private onPage: ((p: BrowsePage) => void) | null = null;

  constructor(private readonly t: AdminTransport, adminKey: string) {
    this.t.send({ type: "SetAdminAuth", key: adminKey });
    this.t.onMessage((m) => {
      const msg = m as { type?: string; modifications?: Array<{ type: string; queryId: number; value: unknown }> } | null;
      if (msg?.type !== "Transition") return;
      for (const mod of msg.modifications ?? []) {
        if (mod.type === "QueryUpdated" && mod.queryId === this.queryId) {
          this.onPage?.(mod.value as BrowsePage);
        }
      }
    });
  }

  /** (Re)subscribe to a table page. Replaces any prior subscription. */
  subscribe(
    table: string,
    opts: { cursor?: string | null; filter?: FilterCond[] },
    onPage: (p: BrowsePage) => void,
  ): void {
    const prev = this.queryId;
    this.queryId += 1;
    this.onPage = onPage;
    this.t.send({
      type: "ModifyQuerySet",
      add: [
        {
          queryId: this.queryId,
          udfPath: "_admin:browseTable",
          args: { table, cursor: opts.cursor ?? null, filter: opts.filter ?? [] },
        },
      ],
      remove: prev ? [prev] : [],
    });
  }

  open(table: string, onPage: (p: BrowsePage) => void): void {
    this.subscribe(table, {}, onPage);
  }

  close(): void {
    this.t.close();
  }
}

/** Build a real WebSocket-backed AdminTransport from a ws:// or wss:// URL. */
export function wsTransport(url: string): AdminTransport {
  const ws = new WebSocket(url);
  const pending: unknown[] = [];
  let cb: ((m: unknown) => void) | null = null;
  ws.addEventListener("open", () => {
    for (const m of pending) ws.send(JSON.stringify(m));
    pending.length = 0;
  });
  ws.addEventListener("message", (ev) => {
    try {
      const m = JSON.parse(ev.data as string) as unknown;
      cb?.(m);
    } catch {
      // ignore malformed frames
    }
  });
  return {
    send(msg) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      else pending.push(msg);
    },
    onMessage(handler) {
      cb = handler;
    },
    close() {
      ws.close();
    },
  };
}

/** Derive the admin WebSocket URL from the current page origin (same host as the HTTP admin API). */
export function adminWsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/sync`;
}
