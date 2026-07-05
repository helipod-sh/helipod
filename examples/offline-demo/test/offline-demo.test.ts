import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@helipod/runtime-embedded";
import { loadProject, push, type LoadedProject } from "@helipod/cli";
import schema from "../helipod/schema";
import * as lists from "../helipod/lists";
import * as items from "../helipod/items";
import { mintId } from "../helipod/_generated/ids";

const loaded: LoadedProject = { schema, modules: { lists, items } };

let runtime: EmbeddedRuntime;
beforeEach(async () => {
  const project = loadProject(loaded);
  runtime = await createEmbeddedRuntime({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog: project.catalog,
    modules: project.moduleMap,
  });
});

describe("packlist — the mintId create-then-reference chain", () => {
  it("a client-minted list id inserts and a second mutation references it", async () => {
    const listId = mintId("lists");
    const created = await runtime.run<string>("lists:create", { _id: listId, name: "Beach trip" });
    expect(created.value).toBe(listId);

    await runtime.run("items:add", { listId, label: "Sunscreen" });
    const got = await runtime.run<Array<{ label: string; listId: string; done: boolean }>>("items:list", { listId });
    expect(got.value.map((i) => i.label)).toEqual(["Sunscreen"]);
    expect(got.value[0]!.listId).toBe(listId);
  });

  it("a caller that omits _id still gets an engine-minted id (nothing about plain inserts changes)", async () => {
    const created = await runtime.run<string>("lists:create", { name: "No minted id" });
    expect(typeof created.value).toBe("string");
    expect(created.value.length).toBeGreaterThan(0);
  });
});

describe("packlist — locked lists reject adds with a coded, terminal error", () => {
  it("items.add into a locked list rejects with code LIST_LOCKED", async () => {
    const created = await runtime.run<string>("lists:create", { name: "Locked" });
    const listId = created.value;
    await runtime.run("lists:lock", { id: listId });

    const err = await runtime.run("items:add", { listId, label: "Too late" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).toBe("LIST_LOCKED");
  });

  it("toggle flips done and unlocked lists accept adds", async () => {
    const created = await runtime.run<string>("lists:create", { name: "Open" });
    const listId = created.value;
    const itemId = (await runtime.run<string>("items:add", { listId, label: "Towel" })).value;

    await runtime.run("items:toggle", { id: itemId, done: true });
    const got = await runtime.run<Array<{ done: boolean }>>("items:list", { listId });
    expect(got.value.map((i) => i.done)).toEqual([true]);
  });
});

describe("codegen — the committed _generated matches the schema", () => {
  it("helipod/_generated is up to date (no drift)", () => {
    const { generated } = push(loaded);
    const dir = join(dirname(fileURLToPath(import.meta.url)), "../helipod/_generated");
    for (const file of generated.files) {
      expect(readFileSync(join(dir, file.path), "utf8"), `${file.path} is stale — run \`bun run scripts/codegen.ts\``).toBe(
        file.content,
      );
    }
  });
});
