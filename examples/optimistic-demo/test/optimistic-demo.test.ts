import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { loadProject, push, type LoadedProject } from "@stackbase/cli";
import schema from "../convex/schema";
import * as polls from "../convex/polls";
import * as options from "../convex/options";

const loaded: LoadedProject = { schema, modules: { polls, options } };

type OptionRow = { _id: string; label: string; votes: number };

let runtime: EmbeddedRuntime;
beforeEach(async () => {
  const project = loadProject(loaded);
  runtime = await createEmbeddedRuntime({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog: project.catalog,
    modules: project.moduleMap,
  });
});

async function createPoll(question = "Lunch?", opts = ["Pizza", "Sushi"]): Promise<{ pollId: string; options: OptionRow[] }> {
  const created = await runtime.run<string>("polls:create", { question, options: opts });
  const pollId = created.value;
  const listed = await runtime.run<OptionRow[]>("options:list", { pollId });
  return { pollId, options: listed.value };
}

describe("pulse — composite poll creation", () => {
  it("polls.create inserts the poll and one zero-vote option row per label in one transaction", async () => {
    const { pollId, options: opts } = await createPoll("Lunch?", ["Pizza", "Sushi", "Salad"]);
    expect(typeof pollId).toBe("string");
    expect(opts.map((o) => o.label)).toEqual(["Pizza", "Sushi", "Salad"]);
    expect(opts.every((o) => o.votes === 0)).toBe(true);

    const allPolls = await runtime.run<Array<{ question: string; closed: boolean }>>("polls:list", {});
    expect(allPolls.value.map((p) => p.question)).toEqual(["Lunch?"]);
    expect(allPolls.value[0]!.closed).toBe(false);
  });
});

describe("pulse — voting", () => {
  it("vote increments and returns the new count", async () => {
    const { options: opts } = await createPoll();
    const first = await runtime.run<number>("options:vote", { id: opts[0]!._id });
    expect(first.value).toBe(1);
    const second = await runtime.run<number>("options:vote", { id: opts[0]!._id });
    expect(second.value).toBe(2);

    const after = await runtime.run<OptionRow[]>("options:list", { pollId: (await runtime.run<Array<{ _id: string }>>("polls:list", {})).value[0]!._id });
    expect(after.value.find((o) => o.label === "Pizza")!.votes).toBe(2);
  });

  it("vote into a closed poll rejects with code POLL_CLOSED; reopening makes it votable again", async () => {
    const { pollId, options: opts } = await createPoll();
    await runtime.run("polls:setClosed", { id: pollId, closed: true });

    const err = await runtime.run("options:vote", { id: opts[0]!._id }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).toBe("POLL_CLOSED");

    await runtime.run("polls:setClosed", { id: pollId, closed: false });
    const after = await runtime.run<number>("options:vote", { id: opts[0]!._id });
    expect(after.value).toBe(1);
  });
});

describe("codegen — the committed _generated matches the schema", () => {
  it("convex/_generated is up to date (no drift)", () => {
    const { generated } = push(loaded);
    const dir = join(dirname(fileURLToPath(import.meta.url)), "../convex/_generated");
    for (const file of generated.files) {
      expect(readFileSync(join(dir, file.path), "utf8"), `${file.path} is stale — run \`bun run scripts/codegen.ts\``).toBe(
        file.content,
      );
    }
  });
});
