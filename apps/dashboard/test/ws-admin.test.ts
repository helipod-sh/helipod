import { describe, it, expect } from "vitest";
import { AdminBrowse, type AdminTransport } from "../src/lib/ws-admin";

// A fake transport that records sent messages and lets the test push server messages.
function fakeTransport() {
  const sent: unknown[] = []; let onMsg: ((m: unknown) => void) | null = null;
  const t: AdminTransport = { send: (m) => sent.push(m), onMessage: (cb) => { onMsg = cb; }, close: () => {} };
  return { t, sent, push: (m: unknown) => onMsg?.(m) };
}

describe("AdminBrowse client", () => {
  it("sends SetAdminAuth then subscribes to _admin:browseTable and surfaces page updates", async () => {
    const { t, sent, push } = fakeTransport();
    const pages: unknown[] = [];
    const b = new AdminBrowse(t, "SECRET");
    b.open("notes", (page) => pages.push(page));
    expect(sent[0]).toEqual({ type: "SetAdminAuth", key: "SECRET" });
    const msg1 = sent[1] as { type: string; add: Array<{ queryId: number; udfPath: string }> };
    expect(msg1.type).toBe("ModifyQuerySet");
    expect(msg1.add[0]?.udfPath).toBe("_admin:browseTable");
    // simulate a server Transition with a QueryUpdated for the browse query
    push({ type: "Transition", modifications: [{ type: "QueryUpdated", queryId: msg1.add[0]?.queryId, value: { documents: [{ body: "x" }], nextCursor: null, hasMore: false, scanCapped: false } }] });
    const lastPage = pages.at(-1) as { documents: Array<{ body: string }> };
    expect(lastPage.documents).toEqual([{ body: "x" }]);
  });
});
