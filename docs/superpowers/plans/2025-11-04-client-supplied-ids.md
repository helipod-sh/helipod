# Client-Supplied Ids Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A client mints a real `Id<"table">` offline, passes it in later mutations' args, and the engine accepts it at insert — full offline create-then-reference chains through the outbox.

**Architecture:** No id-format change (client mints the same `base32(varint(tableNumber)+16 random bytes+checksum)` shape, 128-bit entropy). The engine's `db.insert` accepts an optional `_id` in the value behind a strict rejection matrix (decode, table match, not-already-in-use), consulting no randomness. Codegen distributes the app-table→number map as a new `_generated/ids.ts` with a typed `mintId`, fed from the same composition the server boots.

**Tech Stack:** TypeScript; vitest under Node; existing packages only (`@stackbase/id-codec` gains a 3-line mint helper; `@stackbase/client` re-exports it).

**Spec:** `docs/superpowers/specs/2025-11-04-client-supplied-ids-design.md` (approved). Where plan and spec differ, the spec governs.

## Global Constraints

- No wire/protocol change; ids travel inside args as strings. No upsert/aliasing semantics ever — collision is a loud typed error.
- The engine consults NO randomness on the `_id` path (determinism); `_creationTime` in an insert value stays rejected exactly as today.
- The stored `_id` is the CANONICAL re-encoding of the decoded bytes (never the caller's raw string verbatim).
- The generated map covers exactly the app's own user tables (component-path and `_`-prefixed names excluded).
- `_generated/ids.ts` is emitted ONLY when `tableNumbers` is provided to codegen (backward compatible: absent input → no file).
- `mintDocumentId`'s home is `@stackbase/id-codec` (browser-pure); `@stackbase/client` re-exports; the dist browser-cleanliness guard (`packages/client/test/dist-browser-clean.test.ts`) must stay green.
- New error classes follow `packages/errors/src` `UserError` subclass conventions; loud, typed.
- The E2E file is named `packages/cli/test/client-ids-e2e.test.ts` (the cli test script's `*-e2e` phase-2 filter).
- Tests run under Node (vitest, no Bun APIs); in-package tests import `src/` relatively; cross-package tests resolve via built dist (`bun run build` first). Full gate = `bun run build && bun run typecheck && bun run test`.
- Branch: `git checkout -b client-ids main` before Task 1.
- Every commit ends with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_015RKShEWjRcmbQVJ8ooUPP6`

## File Map

| File | Role |
|---|---|
| `packages/errors/src/index.ts` (or the file holding UserError subclasses) | `InvalidClientIdError`, `IdAlreadyInUseError` |
| `packages/executor/src/kernel.ts:321-340` | `handleDbInsert` `_id` acceptance + rejection matrix |
| `packages/executor/test/client-id-insert.test.ts` | NEW — the matrix + success paths |
| `packages/id-codec/src/document-id.ts` + `index.ts` | `mintEncodedDocumentId(tableNumber)` |
| `packages/codegen/src/generate.ts` | `CodegenInput.tableNumbers?`, `generateIds()`, `generateAll` wiring |
| `packages/codegen/test/` (new file `generate-ids.test.ts`) | map filtering + emitted content |
| `packages/cli/src/push-pipeline.ts:21-25` | thread `project.tableNumbers` into `generateAll` |
| `packages/client/src/index.ts` + `package.json` | `mintDocumentId` re-export + `@stackbase/id-codec` dep |
| `packages/cli/test/client-ids-e2e.test.ts` | NEW — flagship chain + matrix over the wire |
| `docs/enduser/offline.md`, `docs/enduser/optimistic-updates.md`, `CLAUDE.md` | docs |

Note: T1 (executor) and T2 (codegen) touch disjoint packages and may run as parallel worktree agents if the coordinator prefers; T3 depends on both being merged.

---

### Task 1: Engine — `db.insert` accepts `_id` behind the rejection matrix

**Files:**
- Modify: `packages/errors/src/index.ts` (find the `UserError` subclass block, `:69-99` region)
- Modify: `packages/executor/src/kernel.ts:321-340` (`handleDbInsert`)
- Create: `packages/executor/test/client-id-insert.test.ts`

**Interfaces:**
- Consumes: `decodeDocumentId`, `encodeInternalDocumentId`, `DocumentIdError` from `@stackbase/id-codec` (kernel.ts already imports from it).
- Produces: `InvalidClientIdError` (code `INVALID_CLIENT_ID`), `IdAlreadyInUseError` (code `ID_ALREADY_IN_USE`) from `@stackbase/errors`; the insert-with-`_id` behavior Tasks 4 depends on.

- [ ] **Step 1: Read the two anchor files** — `packages/executor/src/kernel.ts:300-360` (handleDbInsert + handleDbReplace's system-field strip) and `packages/executor/test/write-validation.test.ts` (the harness this task's test file copies: `InlineUdfExecutor` + `SqliteDocStore` + `SimpleIndexCatalog.addTable(name, tableNumber, schemaJson, validated)`).

- [ ] **Step 2: Add the error classes** in `packages/errors/src`, next to the existing `UserError` subclasses, matching their exact style (read two neighbors first — they likely set `code`/`name`):

```ts
export class InvalidClientIdError extends UserError {
  override name = "InvalidClientIdError";
  readonly code = "INVALID_CLIENT_ID";
}
export class IdAlreadyInUseError extends UserError {
  override name = "IdAlreadyInUseError";
  readonly code = "ID_ALREADY_IN_USE";
}
```

(If the neighboring classes carry constructors or a `code` convention differing from this sketch, match the file's actual convention — the requirement is two exported, typed, coded UserError subclasses.)

- [ ] **Step 3: Write the failing tests** — `packages/executor/test/client-id-insert.test.ts`, harness copied from `write-validation.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { MonotonicTimestampOracle, type DocumentValue } from "@stackbase/docstore";
import { SingleWriterTransactor } from "@stackbase/transactor";
import { QueryRuntime } from "@stackbase/query-engine";
import { InlineUdfExecutor, SimpleIndexCatalog, query, mutation } from "../src/index";
import { v } from "@stackbase/values";
import { mintEncodedDocumentId, decodeDocumentId } from "@stackbase/id-codec";

const CONVOS = 10001;
const MSGS = 10002;

const createConvo = mutation<{ _id?: string; name: string }, string>({
  handler: (ctx, a) => ctx.db.insert("convos", a as unknown as DocumentValue),
});
const createTwice = mutation<{ _id: string }, string>({
  handler: async (ctx, a) => {
    await ctx.db.insert("convos", { _id: a._id, name: "first" } as unknown as DocumentValue);
    return ctx.db.insert("convos", { _id: a._id, name: "second" } as unknown as DocumentValue);
  },
});
const getById = query<{ id: string }, unknown>({ handler: (ctx, { id }) => ctx.db.get(id) });

let exec: InlineUdfExecutor;
beforeEach(async () => {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  await store.setupSchema();
  const transactor = new SingleWriterTransactor(store, new MonotonicTimestampOracle());
  const catalog = new SimpleIndexCatalog()
    .addTable("convos", CONVOS, v.object({ name: v.string() }).toJSON(), true)
    .addTable("msgs", MSGS, v.object({ body: v.string() }).toJSON(), true);
  exec = new InlineUdfExecutor({ transactor, queryRuntime: new QueryRuntime(store), catalog });
});

describe("insert with a client-supplied _id", () => {
  it("accepts a minted id: row lands under EXACTLY that id, _creationTime server-stamped", async () => {
    const minted = mintEncodedDocumentId(CONVOS);
    const returned = (await exec.run<string>(createConvo, { _id: minted, name: "a" })).value;
    expect(returned).toBe(minted);
    const doc = (await exec.run<Record<string, unknown>>(getById, { id: minted })).value;
    expect(doc).toMatchObject({ _id: minted, name: "a" });
    expect(typeof doc._creationTime).toBe("number"); // stamped by the server, not the client
  });

  it("rejects a malformed _id (not decodable)", async () => {
    await expect(exec.run(createConvo, { _id: "not-an-id", name: "a" })).rejects.toMatchObject({
      code: "INVALID_CLIENT_ID",
    });
  });

  it("rejects an _id minted for a DIFFERENT table", async () => {
    const wrongTable = mintEncodedDocumentId(MSGS);
    await expect(exec.run(createConvo, { _id: wrongTable, name: "a" })).rejects.toMatchObject({
      code: "INVALID_CLIENT_ID",
    });
  });

  it("rejects an _id that already names a COMMITTED row", async () => {
    const minted = mintEncodedDocumentId(CONVOS);
    await exec.run(createConvo, { _id: minted, name: "a" });
    await expect(exec.run(createConvo, { _id: minted, name: "b" })).rejects.toMatchObject({
      code: "ID_ALREADY_IN_USE",
    });
  });

  it("rejects a duplicate _id WITHIN one transaction (pending-overlay read)", async () => {
    const minted = mintEncodedDocumentId(CONVOS);
    await expect(exec.run(createTwice, { _id: minted })).rejects.toMatchObject({
      code: "ID_ALREADY_IN_USE",
    });
  });

  it("stores the CANONICAL encoding (a re-encoded id, not the caller's raw string)", async () => {
    const minted = mintEncodedDocumentId(CONVOS);
    // lowercase base32 of the same bytes decodes identically but is not canonical
    const alternate = minted.toLowerCase();
    if (alternate !== minted) {
      const returned = (await exec.run<string>(createConvo, { _id: alternate, name: "a" })).value;
      expect(returned).toBe(minted); // canonicalized
    } else {
      // encoding is already caseless in this alphabet — decode/encode roundtrip must be identity
      const rt = decodeDocumentId(minted);
      expect(rt.tableNumber).toBe(CONVOS);
    }
  });

  it("regression: insert WITHOUT _id behaves exactly as today (server mints)", async () => {
    const id = (await exec.run<string>(createConvo, { name: "a" })).value;
    expect(decodeDocumentId(id).tableNumber).toBe(CONVOS);
  });
});
```

(`mintEncodedDocumentId` doesn't exist yet — for THIS task, add it in the same commit; it's 3 lines in id-codec and T1's tests are its first consumer. T3 only re-exports it from the client.)

- [ ] **Step 4: Run to verify failure** — `cd packages/executor && bunx vitest run test/client-id-insert.test.ts` → FAIL (`mintEncodedDocumentId` not exported / schema rejects `_id` as extra field).

- [ ] **Step 5: Implement.** (a) `packages/id-codec/src/document-id.ts` add + export via `index.ts`:

```ts
/** Mint a full encoded document id CLIENT-SIDE (same shape and entropy as the engine's own
 *  minting — 16 random bytes). The engine validates at insert; see client-supplied ids spec. */
export function mintEncodedDocumentId(tableNumber: number): string {
  return encodeInternalDocumentId(newDocumentId(tableNumber));
}
```

(b) `packages/executor/src/kernel.ts` `handleDbInsert` — replace the body between the `requireTable` line and the `doc` construction:

```ts
const { table, value } = JSON.parse(argJson) as { table: string; value: JSONValue };
const { tableNumber, fullName } = requireTable(ctx, table);
const meta = ctx.catalog.getTable(fullName);
const converted = jsonToConvex(value) as DocumentValue;

// Client-supplied _id (spec: client-supplied ids): extracted BEFORE validation, same system-field
// discipline handleDbReplace applies. _creationTime in an insert value stays rejected as today.
const { _id: suppliedId, ...userValue } = converted as DocumentValue & { _id?: unknown };
validateDocumentForWrite(meta, fullName, userValue as DocumentValue);

let id: InternalDocumentId;
if (suppliedId !== undefined) {
  if (typeof suppliedId !== "string") throw new InvalidClientIdError(`_id must be a string`);
  let decoded: InternalDocumentId;
  try {
    decoded = decodeDocumentId(suppliedId);
  } catch (e) {
    throw new InvalidClientIdError(`_id is not a valid document id: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (decoded.tableNumber !== tableNumber) {
    const other = ctx.catalog.getTableByNumber(decoded.tableNumber);
    throw new InvalidClientIdError(
      `_id belongs to table ${other ? `"${other.name}"` : `#${decoded.tableNumber}`}, not "${table}"`,
    );
  }
  if ((await ctx.txn.get(decoded)) !== null) {
    throw new IdAlreadyInUseError(`a document with _id ${suppliedId} already exists in "${table}"`);
  }
  id = decoded; // deterministic: no randomness consulted on this path
} else {
  id = newDocumentId(tableNumber);
}
const docId = encodeInternalDocumentId(id); // canonical re-encoding either way
const doc: DocumentValue = {
  ...(userValue as DocumentValue),
  _id: docId,
  _creationTime: Number(ctx.snapshotTs),
};
```

(the tail of the handler — `enforceShardWrite`, `enforceWrite`, `txn.put(id, doc)`, `maintainIndexes`, return — is unchanged; verify `InternalDocumentId` and the two new error classes are imported. NOTE: the destructure means an insert-without-_id no longer carries a user `_id` into validation — byte-identical to today because today such a value FAILED validation or was overwritten; the regression test pins the without-_id path).

- [ ] **Step 6: Run the new tests + the neighbors** — `bunx vitest run test/client-id-insert.test.ts test/write-validation.test.ts test/executor.test.ts` → PASS; then the whole executor suite `bunx vitest run` → PASS; `bun run typecheck` in both `packages/id-codec` and `packages/executor`.

- [ ] **Step 7: Commit**

```bash
git add packages/errors packages/executor packages/id-codec
git commit -m "feat(executor,id-codec): db.insert accepts a client-supplied _id behind a strict rejection matrix"
```

---

### Task 2: Codegen — the app-table map + `_generated/ids.ts`

**Files:**
- Modify: `packages/codegen/src/generate.ts` (`CodegenInput` :65, `generateAll` :230)
- Create: `packages/codegen/test/generate-ids.test.ts`
- Modify: `packages/cli/src/push-pipeline.ts:21-25`

**Interfaces:**
- Consumes: `ProjectArtifacts.tableNumbers: Record<string, number>` (`packages/cli/src/project.ts:27` — fullNames: component tables carry `componentPath/name`, app tables are bare).
- Produces: `CodegenInput.tableNumbers?: Record<string, number>`; `generateIds(schema: SchemaDefinitionJSON, tableNumbers: Record<string, number>, options?: CodegenOptions): GeneratedFile` emitting `ids.ts`; `generateAll` includes it when `tableNumbers` is present.

- [ ] **Step 1: Read** `packages/codegen/src/generate.ts` fully (it's the whole surface: `GeneratedFile {path, contents}` shape, `DEFAULT_HEADER`, how `generateDataModel` names `Id<>`/`TableNames` types in `dataModel.d.ts`) and one existing test in `packages/codegen/test/` for the assertion style.

- [ ] **Step 2: Failing tests** — `packages/codegen/test/generate-ids.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { generateIds, generateAll } from "../src/generate";

const schema = {
  tables: {
    conversations: { documentType: { type: "object", value: { name: { fieldType: { type: "string" }, optional: false } } } },
    messages: { documentType: { type: "object", value: { body: { fieldType: { type: "string" }, optional: false } } } },
  },
} as never; // match the SchemaDefinitionJSON fixture style used by the file's other tests

const tableNumbers = {
  conversations: 10001,
  messages: 10002,
  "scheduler/jobs": 10003, // component table — must be excluded
  _storage: 20, // system table — must be excluded
};

describe("generateIds", () => {
  it("emits ids.ts with the APP-ONLY table map and a typed mintId", () => {
    const file = generateIds(schema, tableNumbers);
    expect(file.path).toBe("ids.ts");
    expect(file.contents).toContain('"conversations": 10001');
    expect(file.contents).toContain('"messages": 10002');
    expect(file.contents).not.toContain("scheduler/jobs");
    expect(file.contents).not.toContain("_storage");
    expect(file.contents).toContain("export function mintId");
    expect(file.contents).toContain("mintEncodedDocumentId"); // delegates to the id-codec core
  });

  it("generateAll includes ids.ts only when tableNumbers is provided", () => {
    const withIds = generateAll({ schema, manifest: { modules: [] } as never, tableNumbers });
    expect(withIds.files.some((f) => f.path === "ids.ts")).toBe(true);
    const without = generateAll({ schema, manifest: { modules: [] } as never });
    expect(without.files.some((f) => f.path === "ids.ts")).toBe(false);
  });
});
```

(Adjust the `schema`/`manifest` fixture literals to whatever the file's existing tests actually construct — read them first; the assertions above are the contract. If `GeneratedBundle` exposes files differently than `.files`, match it.)

- [ ] **Step 3: Run to verify failure** — `cd packages/codegen && bunx vitest run test/generate-ids.test.ts` → FAIL (`generateIds` not exported).

- [ ] **Step 4: Implement `generateIds`** in `generate.ts` (and add `tableNumbers?: Record<string, number>` to `CodegenInput`, wire into `generateAll`):

```ts
/** `_generated/ids.ts` — the app-table→number map + a typed client-side id mint (client-supplied
 *  ids spec). App tables only: component tables (fullName contains "/") are not insertable by app
 *  code and system tables ("_" prefix) never accept client ids. Emitted only when the composition
 *  provides tableNumbers, so pre-existing codegen consumers are untouched. */
export function generateIds(
  schema: SchemaDefinitionJSON,
  tableNumbers: Record<string, number>,
  options: CodegenOptions = {},
): GeneratedFile {
  const appTables = Object.entries(tableNumbers)
    .filter(([name]) => !name.includes("/") && !name.startsWith("_"))
    .sort(([a], [b]) => (a < b ? -1 : 1));
  const mapLines = appTables.map(([name, num]) => `  ${JSON.stringify(name)}: ${num},`).join("\n");
  const contents = `${options.header ?? DEFAULT_HEADER}
import { mintEncodedDocumentId } from "@stackbase/id-codec";
import type { Id, TableNames } from "./dataModel";

/** Table numbers for THIS deployment's app tables (embedded in document ids). Regenerate via
 *  \`stackbase dev\`/\`stackbase codegen\` against the live deployment lineage — the server
 *  validates every client-minted id at insert, so a stale map fails loudly, never silently. */
export const tableNumbers = {
${mapLines}
} as const;

/** Mint a REAL id client-side (same format and entropy as server minting). Mint at
 *  args-construction time, OUTSIDE optimistic updaters (minting is random; updaters must stay
 *  replay-pure and read the id FROM args). Pass it as \`_id\` to an insert and reference it
 *  freely in later queued mutations — see the offline guide's create-then-reference section. */
export function mintId<T extends TableNames>(table: T): Id<T> {
  const num = tableNumbers[table as keyof typeof tableNumbers];
  if (num === undefined) throw new Error(\`unknown table "\${String(table)}" — regenerate _generated/\`);
  return mintEncodedDocumentId(num) as Id<T>;
}
`;
  return { path: "ids.ts", contents };
}
```

(Verify `Id`/`TableNames` are exported from the generated `dataModel` — `generateDataModel` emits them (`emitDocumentType` references `Id<...>`); if the actual type names/module differ, match what `dataModel.d.ts` really exports. In `generateAll`, append `generateIds(input.schema, input.tableNumbers, options)` to the bundle when `input.tableNumbers` is defined.)

- [ ] **Step 5: Thread through the pipeline** — `packages/cli/src/push-pipeline.ts`:

```ts
const generated = generateAll({
  schema: project.schemaJson,
  manifest: project.manifest,
  tableNumbers: project.tableNumbers,
  components: components.map((c) => ({ name: c.name, contextType: c.contextType, serverExports: c.serverExports })),
});
```

- [ ] **Step 6: Run + typecheck** — codegen tests, then `cd packages/cli && bun run typecheck` and the cli unit tests that cover push/codegen (`bunx vitest run test/push-components-codegen.test.ts test/cli.test.ts` — adjust to the files that exist). Any snapshot-style codegen test that now sees an extra `ids.ts` file: update it honestly (the new file is the feature).

- [ ] **Step 7: Commit**

```bash
git add packages/codegen packages/cli/src
git commit -m "feat(codegen): _generated/ids.ts — app-table numbers + typed client-side mintId"
```

---

### Task 3: Client re-export + browser cleanliness

**Files:**
- Modify: `packages/client/src/index.ts`, `packages/client/package.json`

**Interfaces:**
- Consumes: `mintEncodedDocumentId` from `@stackbase/id-codec` (T1).
- Produces: `mintDocumentId` export from `@stackbase/client` (untyped core, for hosts without codegen).

- [ ] **Step 1:** Add `"@stackbase/id-codec": "workspace:*"` to `packages/client/package.json` dependencies; in `src/index.ts` add:

```ts
/** Untyped core of client-side id minting — prefer the codegen-typed `mintId` from your app's
 *  `_generated/ids`. Exists for hosts without codegen output at hand. */
export { mintEncodedDocumentId as mintDocumentId } from "@stackbase/id-codec";
```

- [ ] **Step 2:** `bun install` (workspace link), then `cd packages/client && bun run build && bunx vitest run` — the FULL client suite including `dist-browser-clean.test.ts` (id-codec is pure JS: `crypto.getRandomValues` is a global, no `node:` imports — the guard must stay green). `bun run typecheck`.

- [ ] **Step 3: Commit**

```bash
git add packages/client bun.lock
git commit -m "feat(client): export mintDocumentId (client-side id minting core)"
```

---

### Task 4: E2E — the offline create-then-reference chain through the real server

**Files:**
- Create: `packages/cli/test/client-ids-e2e.test.ts`

- [ ] **Step 1: Read the harness precedents** — `packages/cli/test/outbox-fs-e2e.test.ts` (the newest, smallest outbox E2E: server boot, fsOutbox over a tmpdir, offline-enqueue-then-drain shape) and its imports. This task's file reuses that structure with a two-table fixture.

- [ ] **Step 2: Write the E2E.** Fixture: `conversations {name: v.string()}` and `messages {conversationId: v.id("conversations"), body: v.string()}`; mutations `createConversation({_id?, name})` → `ctx.db.insert("conversations", args)` (passing `_id` through) and `sendMessage({conversationId, body})` (args validated with `v.id("conversations")`) → insert into messages; query `listAll` returning both tables' rows. Scenarios:

1. **The flagship chain:** client with `fsOutbox({dir: tmpdir})`, transport offline; `const cid = mintDocumentId(<conversations tableNumber from the runtime composition>)`; enqueue `createConversation({_id: cid, name})` then `sendMessage({conversationId: cid, body})`; assert both durable in the journal; connect to the real server; drain; assert: exactly ONE conversation row whose `_id` === the minted string, the message's `conversationId` resolves (`db.get` inside a verifying query returns the conversation), a live subscription observes both rows, `pendingMutations()` empty.
2. **Rejection matrix over the wire:** a minted MESSAGES-table id passed as `_id` to `createConversation` → the mutation rejects and the error surfaces with code `INVALID_CLIENT_ID`; re-using scenario 1's `cid` in a fresh `createConversation` → rejects with `ID_ALREADY_IN_USE`. Both through the standard failure channels (rejected promise online; the codes visible on the error).
3. **Regression:** `createConversation({name})` without `_id` → server-minted id, works as today.
4. **The codegen bridge:** run `generateAll` (imported from `@stackbase/codegen`) over the fixture's schema + the runtime's actual `tableNumbers`; assert the emitted `ids.ts` contains the same `conversations` number the wire scenarios used — binding the map to reality without a compile fixture.

Get the table number from the same `loadProject`/composition object the test's server boot uses (`project.tableNumbers["conversations"]`). Timeout 60_000 on the flagship.

- [ ] **Step 3: Build + run** — `bun run build` at root (cross-package dist), then `cd packages/cli && bunx vitest run test/client-ids-e2e.test.ts` → PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/test/client-ids-e2e.test.ts
git commit -m "test(cli): client-supplied ids E2E — offline create-then-reference chain drains exactly-once"
```

---

### Task 5: Docs + full gate

**Files:**
- Modify: `docs/enduser/offline.md`, `docs/enduser/optimistic-updates.md`, `CLAUDE.md`

- [ ] **Step 1:** `offline.md`: the create-then-reference section becomes PRIMARY — a worked example using `mintId` from `_generated/ids` (the spec's code snippet), the honest staleness caveat (server validates; regenerate against the live lineage), and the composite-intent workaround demoted to a "when you can't regenerate codegen" fallback. Remove/adjust any "create-then-reference isn't possible" claims. The deferred-table row for client-supplied ids (if present) graduates.
- [ ] **Step 2:** `optimistic-updates.md`: the "never pass a placeholderId as a mutation argument" rule gains its resolution — "mint a real id instead (`mintId`)" + the purity rule (mint OUTSIDE updaters; inside an updater, read the id FROM args; placeholders remain rendering-only).
- [ ] **Step 3:** `CLAUDE.md`: extend the durable-offline entry with one clause (client-supplied ids via `_generated/ids` `mintId` — offline create-then-reference chains; engine validates at insert).
- [ ] **Step 4: Full gate** — `bun run build && bun run typecheck && bun run test` → all tasks green.
- [ ] **Step 5: Commit**

```bash
git add docs CLAUDE.md
git commit -m "docs: client-supplied ids — create-then-reference becomes the primary offline pattern"
```

---

## Self-review notes (spec coverage)

- Spec API/format/no-marker → T1+T3 (mint = same shape; no provenance bit). Distribution decision → T2 (+ push thread-through; the "dev threads live numbers" requirement is satisfied BY the push pipeline — dev's regenerate path IS `push()`, which now passes the live composition's numbers). Engine matrix → T1 (all rows + canonical re-encode + same-txn pending check). Purity rule/docs → T5. Testing §1-4 → T1 (unit), T2 (codegen), T4 (E2E incl. bridge assertion), typing compile check → T2's emitted-content test + T4's real `v.id` validation over the wire (a full tsc-compile fixture of `ids.ts` is deliberately not built — the E2E's runtime validation plus the content assertions cover the contract; noted as a conscious simplification vs spec Testing §3's "compiles" phrasing).
- Non-goals respected: no upsert, no `_creationTime` acceptance, no wire change, placeholders untouched.
