import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsOutbox } from "../src/outbox-fs";
import { makeEntry } from "./outbox-contract";

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "sb-outbox-fs-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("fsOutbox — journal durability", () => {
  it("append resolves only after the line is durably in journal.jsonl (read-after-await)", async () => {
    const dir = freshDir();
    const s = fsOutbox({ dir });
    await s.append(makeEntry());
    const raw = readFileSync(join(dir, "journal.jsonl"), "utf8");
    expect(raw).toContain('"op":"append"');
    expect(raw).toContain('"udfPath":"messages:send"');
    await s.close?.();
  });

  it("same-microtask appends batch into ONE flush (write-behind)", async () => {
    const dir = freshDir();
    const s = fsOutbox({ dir }) as ReturnType<typeof fsOutbox> & { stats: { flushes: number } };
    await Promise.all([s.append(makeEntry({ seq: 0, order: 0 })), s.append(makeEntry({ seq: 1, order: 1 })), s.append(makeEntry({ seq: 2, order: 2 }))]);
    expect(s.stats.flushes).toBe(1);
    expect((await s.loadAll()).entries).toHaveLength(3);
    await s.close?.();
  });

  it("restart-rehydrate: a fresh instance on the same dir hydrates the same entries in order", async () => {
    const dir = freshDir();
    const a = fsOutbox({ dir });
    await a.append(makeEntry({ seq: 0, order: 1 }));
    await a.append(makeEntry({ clientId: "c2", seq: 0, order: 0 }));
    await a.updateStatus("c1", 0, "parked");
    await a.close?.();
    const b = fsOutbox({ dir });
    const { entries } = await b.loadAll();
    expect(entries.map((e) => [e.clientId, e.status])).toEqual([["c2", "unsent"], ["c1", "parked"]]);
    await b.close?.();
  });
});

describe("fsOutbox — close() race (regression)", () => {
  it("an append racing close() in the same synchronous frame never resolves unwritten", async () => {
    const dir = freshDir();
    const s = fsOutbox({ dir });
    const outcome = s.append(makeEntry({ seq: 0, order: 0 })).then(
      () => ({ ok: true as const }),
      (err: unknown) => ({ ok: false as const, err }),
    );
    await s.close?.();
    const result = await outcome;
    const raw = existsSync(join(dir, "journal.jsonl")) ? readFileSync(join(dir, "journal.jsonl"), "utf8") : "";
    const written = raw.includes('"seq":0');
    if (result.ok) {
      expect(written).toBe(true); // resolved => MUST be durably on disk (the load-bearing direction)
    } else {
      // rejected => outcome UNKNOWN by contract (close's final compaction may have snapshotted the
      // already-applied state) — the journal just has to be hydrate-consistent, never half-written
      expect((result.err as { code?: string }).code).toBe("OUTBOX_CLOSED");
      const b = fsOutbox({ dir });
      const { entries } = await b.loadAll();
      expect(entries.every((e) => e.udfPath === "messages:send")).toBe(true);
      await b.close?.();
    }
  });

  it("append() after close() rejects with OUTBOX_CLOSED", async () => {
    const dir = freshDir();
    const s = fsOutbox({ dir });
    await s.append(makeEntry({ seq: 0, order: 0 }));
    await s.close?.();
    await expect(s.append(makeEntry({ seq: 1, order: 1 }))).rejects.toMatchObject({ code: "OUTBOX_CLOSED" });
  });
});

describe("fsOutbox — corruption", () => {
  it("a torn TAIL line is physically truncated and only that entry is lost", async () => {
    const dir = freshDir();
    const a = fsOutbox({ dir });
    await a.append(makeEntry({ seq: 0, order: 0 }));
    await a.close?.();
    const before = readFileSync(join(dir, "journal.jsonl"), "utf8");
    appendFileSync(join(dir, "journal.jsonl"), '{"op":"append","entry":{"clientId":"c1","se'); // torn: no newline, invalid JSON
    const b = fsOutbox({ dir });
    const { entries } = await b.loadAll();
    expect(entries.map((e) => e.seq)).toEqual([0]);
    await b.close?.();
    const raw = readFileSync(join(dir, "journal.jsonl"), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    // torn fragment physically removed: the journal is back to exactly its pre-corruption bytes
    // (a plain substring check on the torn text doesn't work here — the torn garbage is itself a
    // byte-prefix of the legitimate entry's own JSON, e.g. `"seq`/`"seed` keys the surviving valid
    // entry legitimately contains).
    expect(raw).toBe(before);
  });

  it("a valid-but-unterminated last line is truncated rather than glued onto the next session's append (regression)", async () => {
    const dir = freshDir();
    // Session A: append seq 0 and close cleanly.
    const a = fsOutbox({ dir });
    await a.append(makeEntry({ seq: 0, order: 0 }));
    await a.close?.();
    // Hand-strip the trailing "\n" — this simulates a crash exactly at the newline write
    // boundary: the flush's single write() call landed everything except the final byte, so
    // seq 0's append() promise (in that hypothetical crashed session) never actually resolved,
    // even though what's left on disk happens to parse as valid JSON.
    const p = join(dir, "journal.jsonl");
    const stripped = readFileSync(p, "utf8").replace(/\n$/, "");
    writeFileSync(p, stripped);
    expect(stripped.endsWith("\n")).toBe(false);

    // Session B: opens (must truncate the unterminated line, NOT accept it), appends seq 1,
    // closes cleanly.
    const b = fsOutbox({ dir });
    await b.append(makeEntry({ seq: 1, order: 1 }));
    await b.close?.();

    // Session C: hydrate. Must see exactly [1] — never a glued double-line, never seq 0 back.
    const c = fsOutbox({ dir });
    const { entries } = await c.loadAll();
    expect(entries.map((e) => e.seq)).toEqual([1]);
    expect(existsSync(join(dir, "journal.quarantine"))).toBe(false);
    await c.close?.();
  });

  it("a corrupt MIDDLE line is quarantined and skipped; later ops for other entries still apply", async () => {
    const dir = freshDir();
    const a = fsOutbox({ dir });
    await a.append(makeEntry({ seq: 0, order: 0 }));
    await a.append(makeEntry({ seq: 1, order: 1 }));
    await a.close?.();
    // corrupt the FIRST line in place (middle of the file once we append one more valid op)
    const p = join(dir, "journal.jsonl");
    const lines = readFileSync(p, "utf8").split("\n");
    lines[0] = "corrupt-not-json";
    writeFileSync(p, lines.join("\n"));
    const b = fsOutbox({ dir });
    const { entries } = await b.loadAll();
    expect(entries.map((e) => e.seq)).toEqual([1]);
    expect(readFileSync(join(dir, "journal.quarantine"), "utf8")).toContain("corrupt-not-json");
    await b.close?.();
  });
});

describe("fsOutbox — compaction", () => {
  it("compacts past the op threshold: state identical, journal shrinks, tmp not left behind", async () => {
    const dir = freshDir();
    const s = fsOutbox({ dir, fsync: false });
    await s.append(makeEntry({ seq: 0, order: 0 }));
    for (let i = 0; i < 5000; i++) await s.updateStatus("c1", 0, i % 2 ? "inflight" : "unsent");
    const { entries } = await s.loadAll();
    expect(entries).toHaveLength(1);
    await s.close?.();
    const opCount = readFileSync(join(dir, "journal.jsonl"), "utf8").trim().split("\n").length;
    expect(opCount).toBeLessThan(100); // compacted: state is 1 entry (+ metas), not 5001 ops
    expect(existsSync(join(dir, "journal.tmp"))).toBe(false);
    const b = fsOutbox({ dir });
    expect((await b.loadAll()).entries).toHaveLength(1);
    await b.close?.();
  }, 30_000);
});

describe("fsOutbox — one writer per dir (lock + probe-and-fallback)", () => {
  it("a same-process double-open falls back to memory and fires onFallback once", async () => {
    const dir = freshDir();
    const a = fsOutbox({ dir });
    await a.append(makeEntry());
    const reasons: unknown[] = [];
    const b = fsOutbox({ dir, onFallback: (r) => reasons.push(r) });
    await b.append(makeEntry({ clientId: "other", seq: 0, order: 5 }));
    expect(reasons).toHaveLength(1);
    expect((reasons[0] as { code?: string }).code).toBe("OUTBOX_LOCK_HELD");
    // b is memory-backed: its entry is NOT in the journal
    expect(readFileSync(join(dir, "journal.jsonl"), "utf8")).not.toContain('"other"');
    // but b still works as a queue (degraded, not broken)
    expect((await b.loadAll()).entries.map((e) => e.clientId)).toEqual(["other"]);
    await a.close?.();
    await b.close?.();
  });

  it("close() releases the lock: reopen on the same dir succeeds and hydrates", async () => {
    const dir = freshDir();
    const a = fsOutbox({ dir });
    await a.append(makeEntry());
    await a.close?.();
    expect(existsSync(join(dir, "lock"))).toBe(false);
    const reasons: unknown[] = [];
    const b = fsOutbox({ dir, onFallback: (r) => reasons.push(r) });
    expect((await b.loadAll()).entries).toHaveLength(1);
    expect(reasons).toHaveLength(0);
    await b.close?.();
  });

  it("a DEAD-pid stale lock is stolen and the adapter opens normally", async () => {
    const dir = freshDir();
    writeFileSync(join(dir, "lock"), JSON.stringify({ pid: 999999999, createdAt: 1 }));
    const reasons: unknown[] = [];
    const s = fsOutbox({ dir, onFallback: (r) => reasons.push(r) });
    await s.append(makeEntry());
    expect(reasons).toHaveLength(0);
    expect(readFileSync(join(dir, "journal.jsonl"), "utf8")).toContain('"op":"append"');
    await s.close?.();
  });

  it("an OWN-pid lock left by a previous boot (pid recycled, dir not registered) is stolen", async () => {
    const dir = freshDir();
    writeFileSync(join(dir, "lock"), JSON.stringify({ pid: process.pid, createdAt: 1 }));
    const reasons: unknown[] = [];
    const s = fsOutbox({ dir, onFallback: (r) => reasons.push(r) });
    await s.append(makeEntry());
    expect(reasons).toHaveLength(0);
    await s.close?.();
  });

  it("a GARBAGE lockfile is stolen, not fatal", async () => {
    const dir = freshDir();
    writeFileSync(join(dir, "lock"), "not json at all");
    const s = fsOutbox({ dir });
    await s.append(makeEntry());
    expect((await s.loadAll()).entries).toHaveLength(1);
    await s.close?.();
  });

  it("an unopenable journal (dir where the journal file should be) degrades to memory, fires onFallback once, and releases the lock (regression: probe used to hydrate lazily, after already resolving to the fs store)", async () => {
    const dir = freshDir();
    // A directory sitting at the journal's own path makes it unopenable (EISDIR on open-for-append)
    // without tripping the readFile-catch's "fresh dir, no journal yet" path.
    mkdirSync(join(dir, "journal.jsonl"));
    const reasons: unknown[] = [];
    const s = fsOutbox({ dir, onFallback: (r) => reasons.push(r) });

    // Degrades to a working memory-backed queue rather than fail-stopping.
    await s.append(makeEntry());
    expect((await s.loadAll()).entries.map((e) => e.udfPath)).toEqual(["messages:send"]);
    expect(reasons).toHaveLength(1);

    // The lock must NOT be left wedged behind the fallback: unblock the journal path and a fresh
    // fsOutbox() on the same dir must open as a REAL fs store, not fall back itself.
    rmdirSync(join(dir, "journal.jsonl"));
    const reasons2: unknown[] = [];
    const b = fsOutbox({ dir, onFallback: (r) => reasons2.push(r) });
    await b.append(makeEntry({ clientId: "c2", seq: 0, order: 0 }));
    expect(reasons2).toHaveLength(0);
    const raw = readFileSync(join(dir, "journal.jsonl"), "utf8");
    expect(raw).toContain('"c2"');
    await b.close?.();
  });
});
