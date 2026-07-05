/**
 * T5 — `createOptimisticLocalStore` (the typed `OptimisticLocalStore`, verdict §(b)'s v1 API
 * surface): `placeholderId`/`now()` determinism, dev-mode freeze, `getAllQueries` arg-families,
 * and the type-level compile fixture for the generated-ref union (mirrors `function-types.test.ts`'s
 * structural-stand-in pattern — no shared import from any app's `_generated/api.d.ts`).
 *
 * The underlying `OptimisticStoreView` is built from the REAL `LayeredQueryStore.recompose` (not a
 * hand-rolled fake) so these tests exercise the exact view shape `reconcile.ts`'s `invokeUpdate`
 * threads through in production — only the `entry.update` closure itself is replaced with a probe.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import type { JSONValue, Value } from "@helipod/values";
import { LayeredQueryStore, queryHash, type OptimisticStoreView } from "../src/layered-store";
import { createOptimisticLocalStore, type OptimisticLocalStore, type RefArgs, type RefReturn } from "../src/optimistic-store";
import type { PendingMutation } from "../src/mutation-log";
import type { AnyFunctionReference } from "../src/function-types";

function seedRow(store: LayeredQueryStore, qid: number, path: string, args: Record<string, JSONValue>, value: Value): void {
  const hash = queryHash(path, args);
  const sub = store.create(qid, path, args, hash);
  store.setServerValue(sub, value);
}

/** A `PendingMutation` stand-in for `recompose` — only `update` (truthy, for the skip-check) and
 *  `seed` matter here; the probe callback below replaces the actual invocation. */
function makeEntry(requestId: string, seed: { entropy: string; now: number }): PendingMutation {
  return {
    requestId,
    udfPath: "probe",
    args: null,
    update: () => {},
    seed,
    touched: new Set(),
    status: { type: "unsent" },
  };
}

/** Runs `probe` against a real `OptimisticLocalStore` built over `store`, for entry `seed`. */
function withLocalStore(store: LayeredQueryStore, seed: { entropy: string; now: number }, probe: (local: OptimisticLocalStore) => void): void {
  store.recompose([makeEntry("r", seed)], (entry, view: OptimisticStoreView) => {
    probe(createOptimisticLocalStore(view, entry.seed));
  });
}

describe("createOptimisticLocalStore", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("placeholderId: same entry (same seed) replayed twice mints the IDENTICAL id sequence", () => {
    const store = new LayeredQueryStore();
    const seed = { entropy: "e1", now: 1000 };
    const runs: string[][] = [[], []];
    for (let i = 0; i < 2; i++) {
      withLocalStore(store, seed, (local) => {
        runs[i]!.push(local.placeholderId("messages"), local.placeholderId("messages"));
      });
    }
    expect(runs[0]).toEqual(runs[1]);
  });

  it("placeholderId: two calls within ONE updater run are ordinal-distinct", () => {
    const store = new LayeredQueryStore();
    const seed = { entropy: "e1", now: 1000 };
    withLocalStore(store, seed, (local) => {
      const a = local.placeholderId("messages");
      const b = local.placeholderId("messages");
      expect(a).not.toBe(b);
    });
  });

  it("placeholderId: distinct entries (distinct seed.entropy) never collide", () => {
    const store = new LayeredQueryStore();
    let idA = "", idB = "";
    withLocalStore(store, { entropy: "entry-a", now: 1 }, (local) => (idA = local.placeholderId("messages")));
    withLocalStore(store, { entropy: "entry-b", now: 1 }, (local) => (idB = local.placeholderId("messages")));
    expect(idA).not.toBe(idB);
  });

  it("placeholderId: per-table — different tables never collide even at the same ordinal", () => {
    const store = new LayeredQueryStore();
    withLocalStore(store, { entropy: "e1", now: 1 }, (local) => {
      const msg = local.placeholderId("messages");
      const usr = local.placeholderId("users");
      expect(msg).not.toBe(usr);
    });
  });

  it("now(): fixed at entry creation, stable across replays — NOT Date.now()", () => {
    const store = new LayeredQueryStore();
    const seed = { entropy: "e1", now: 424242 };
    const seen: number[] = [];
    for (let i = 0; i < 2; i++) {
      withLocalStore(store, seed, (local) => seen.push(local.now()));
    }
    expect(seen).toEqual([424242, 424242]);
  });

  it("dev-mode freeze: getQuery's result throws on in-place mutation (NODE_ENV !== production)", () => {
    vi.stubEnv("NODE_ENV", "development");
    const store = new LayeredQueryStore();
    seedRow(store, 1, "messages:list", { conversationId: "c1" }, [{ body: "hi" }] as unknown as Value);
    withLocalStore(store, { entropy: "e1", now: 1 }, (local) => {
      const list = local.getQuery("messages:list", { conversationId: "c1" }) as Array<Record<string, Value>>;
      expect(() => {
        list.push({ body: "mutate!" });
      }).toThrow(TypeError);
    });
  });

  it("dev-mode freeze: does NOT freeze in production (NODE_ENV === production)", () => {
    vi.stubEnv("NODE_ENV", "production");
    const store = new LayeredQueryStore();
    seedRow(store, 1, "messages:list", { conversationId: "c1" }, [{ body: "hi" }] as unknown as Value);
    withLocalStore(store, { entropy: "e1", now: 1 }, (local) => {
      const list = local.getQuery("messages:list", { conversationId: "c1" }) as Array<Record<string, Value>>;
      expect(() => {
        list.push({ body: "mutate ok" });
      }).not.toThrow();
      expect(list.length).toBe(2);
    });
  });

  it("getAllQueries: covers every arg-family under the path (pagination-shaped fan-out)", () => {
    const store = new LayeredQueryStore();
    seedRow(store, 1, "messages:list", { conversationId: "c1" }, ["c1-msg"] as unknown as Value);
    seedRow(store, 2, "messages:list", { conversationId: "c2" }, ["c2-msg"] as unknown as Value);
    seedRow(store, 3, "users:list", {}, ["irrelevant"] as unknown as Value);
    withLocalStore(store, { entropy: "e1", now: 1 }, (local) => {
      const families = local.getAllQueries("messages:list");
      expect(families).toHaveLength(2);
      const byConversation = new Map(families.map((f) => [(f.args as { conversationId: string }).conversationId, f.value]));
      expect(byConversation.get("c1")).toEqual(["c1-msg"]);
      expect(byConversation.get("c2")).toEqual(["c2-msg"]);
    });
  });

  it("setQuery + getQuery round-trip through the typed store", () => {
    const store = new LayeredQueryStore();
    seedRow(store, 1, "messages:list", { conversationId: "c1" }, ["seed"] as unknown as Value);
    withLocalStore(store, { entropy: "e1", now: 1 }, (local) => {
      const list = local.getQuery("messages:list", { conversationId: "c1" }) as string[];
      local.setQuery("messages:list", { conversationId: "c1" }, [...list, "appended"]);
      expect(local.getQuery("messages:list", { conversationId: "c1" })).toEqual(["seed", "appended"]);
    });
  });
});

// ================================================================================================
// Type-level compile fixture (T3's `function-types.test.ts` pattern): `RefArgs`/`RefReturn` and
// `OptimisticLocalStore`'s generics against a structural stand-in for codegen's generated
// `FunctionReference` — proving a generated typed `api` gives typed store reads, while the
// client's own untyped `{ __path }` ref falls back to `Record<string, Value>`/`Value`. Verified by
// `tsc --noEmit` (vitest's esbuild transform strips types, so the `@ts-expect-error` lines only
// fail the build, not this runtime suite — `bun run --filter @helipod/client typecheck`).
// ================================================================================================
describe("OptimisticLocalStore — type-level (generated-ref union)", () => {
  it("compiles AND runs: a generated ref's __args/__returns type getQuery/setQuery/getAllQueries", () => {
    type GeneratedFunctionReference<Type extends string, Vis extends string, Args, Returns> = {
      readonly __type: Type;
      readonly __visibility: Vis;
      readonly __args: Args;
      readonly __returns: Returns;
    };
    type ListMessages = GeneratedFunctionReference<"query", "public", { conversationId: string }, Array<{ body: string }>>;

    // A real runtime ref (has `__path`, like every `anyApi`-backed value) cast to the generated
    // TYPE (which structurally lacks `__path` — the exact T3-flagged incompatibility this bridges).
    const ref = { __path: "messages:list" } as unknown as ListMessages;

    const store = new LayeredQueryStore();
    seedRow(store, 1, "messages:list", { conversationId: "c1" }, [{ body: "hi" }] as unknown as Value);

    withLocalStore(store, { entropy: "e1", now: 1 }, (local) => {
      // Typed args required; typed return inferred — and this actually RUNS against the real store.
      const value: Array<{ body: string }> | undefined = local.getQuery(ref, { conversationId: "c1" });
      expect(value).toEqual([{ body: "hi" }]);

      local.setQuery(ref, { conversationId: "c1" }, [{ body: "hi" }, { body: "written" }]);
      expect(local.getQuery(ref, { conversationId: "c1" })).toEqual([{ body: "hi" }, { body: "written" }]);

      const families: Array<{ args: { conversationId: string }; value: Array<{ body: string }> | undefined }> = local.getAllQueries(ref);
      expect(families).toHaveLength(1);

      // @ts-expect-error — args must be `{ conversationId: string }`, not `{ wrong: number }`
      local.getQuery(ref, { wrong: 1 });
    });
  });

  it("compiles AND runs: the client's own untyped { __path } ref falls back to Record<string, Value>/Value", () => {
    const ref = { __path: "messages:list" } as { __path: string };
    const store = new LayeredQueryStore();
    seedRow(store, 1, "messages:list", { conversationId: "c1" }, ["untyped-ok"] as unknown as Value);

    withLocalStore(store, { entropy: "e1", now: 1 }, (local) => {
      // No args-shape constraint — any Record<string, Value> is accepted, return is Value | undefined.
      const value = local.getQuery(ref, { conversationId: "c1" });
      expect(value).toEqual(["untyped-ok"]);
      const families = local.getAllQueries(ref);
      expect(families).toHaveLength(1);
    });
  });

  it("RefArgs/RefReturn extract the typed pair from a generated-shaped reference", () => {
    type Send = AnyFunctionReference<{ body: string }, { id: string }>;
    type Args = RefArgs<Send>;
    type Returns = RefReturn<Send>;
    const args: Args = { body: "hi" };
    const returns: Returns = { id: "abc" };
    expect(args.body).toBe("hi");
    expect(returns.id).toBe("abc");
  });

  it("RefArgs/RefReturn default to Record<string, Value>/Value for a plain string path", () => {
    type Args = RefArgs<"messages:list">;
    type Returns = RefReturn<"messages:list">;
    const args: Args = { whatever: 1 };
    const returns: Returns = "whatever";
    expect(args).toBeDefined();
    expect(returns).toBe("whatever");
  });
});
