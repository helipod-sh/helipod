import { describe, it, expect, beforeEach } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@helipod/runtime-embedded";
import { HelipodClient, loopbackTransport, anyApi, type OptimisticLocalStore } from "@helipod/client";
import { loadProject, type LoadedProject } from "@helipod/cli";
import schema from "../helipod/schema";
import * as messages from "../helipod/messages";
import * as audit from "../helipod/audit";

/**
 * The (i)5 measurement (verdict §(i).5 / spec plan constraint): `LayeredQueryStore.recompose`
 * (packages/client/src/layered-store.ts) reruns EVERY surviving optimistic updater on EVERY
 * ingested Transition — unconditionally, regardless of whether that particular Transition's
 * modifications had anything to do with the query a given updater touched (reconcile.ts's
 * `ingestTransition` calls `this.rebuild()` after processing modifications, with no filtering).
 * A typical updater rebuilds its patched query with a fresh array (`[...list, row]`), so the
 * reference-inequality change-detection (`next !== sub.composedValue`) always sees a "change" and
 * re-fires the subscription's listener — i.e. a re-render — even for an ingest that was, from
 * that query's point of view, a complete no-op.
 *
 * This test counts exactly that: how many times a client's `messages:list(conversationId: A)`
 * subscription callback fires — the same callback `useQuery` wires to `setValue`, so this count
 * IS the React re-render count for that hook — contrasting a baseline run (one optimistic send,
 * nothing else pending) against a "hot" run where a SECOND, unrelated optimistic mutation (to a
 * different conversation, B) is pending concurrently in the same session, so B's own commit
 * events are additional ingests that reconcile.ts's `ingestTransition` unconditionally reruns
 * `recompose` for — rebuilding and re-firing A's still-pending, unrelated layer too.
 */

const api = anyApi as {
  messages: { send: { __path: string }; list: { __path: string } };
};

function appendOptimistic(store: OptimisticLocalStore, args: Record<string, unknown>): void {
  const { conversationId, author, body } = args as { conversationId: string; author: string; body: string };
  const list = (store.getQuery(api.messages.list, { conversationId }) as Array<{ _id: string; body: string }> | undefined) ?? [];
  store.setQuery(api.messages.list, { conversationId }, [
    ...list,
    { _id: store.placeholderId("messages"), _creationTime: store.now(), conversationId, author, body },
  ]);
}

let runtime: EmbeddedRuntime;

beforeEach(async () => {
  const loaded: LoadedProject = { schema, modules: { messages, audit } };
  const project = loadProject(loaded);
  runtime = await createEmbeddedRuntime({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog: project.catalog,
    modules: project.moduleMap,
  });
});

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("(i)5 — re-renders during an optimistic mutation's pending window", () => {
  it("baseline: one optimistic send, no concurrent traffic", async () => {
    const client = new HelipodClient(loopbackTransport(runtime.connect("baseline")));
    let renders = 0;
    client.subscribe(api.messages.list, { conversationId: "convA" }, () => renders++);
    await waitFor(() => renders >= 1); // the initial empty-list delivery

    renders = 0;
    await client.mutation(api.messages.send, { conversationId: "convA", author: "a", body: "hi" }, { optimisticUpdate: appendOptimistic as never });
    await waitFor(() => renders >= 1);
    await new Promise((r) => setTimeout(r, 50)); // let the gate-closing Transition land if it hasn't yet

    // Expected: 1 (the synchronous optimistic apply) + 1 (the confirming Transition that gates the
    // layer closed) = 2. Reported as the reference number in the task report.
    console.log(`[i5] baseline renders (no concurrent traffic): ${renders}`);
    expect(renders).toBeGreaterThanOrEqual(1);
    expect(renders).toBeLessThanOrEqual(3);
  });

  it("hot: a SECOND pending optimistic mutation to a DIFFERENT conversation is in flight concurrently", async () => {
    const client = new HelipodClient(loopbackTransport(runtime.connect("hot")));
    let rendersA = 0;
    client.subscribe(api.messages.list, { conversationId: "convA" }, () => rendersA++);
    client.subscribe(api.messages.list, { conversationId: "convB" }, () => {});
    await waitFor(() => rendersA >= 1);

    rendersA = 0;
    // Fire BOTH optimistic sends without awaiting either individually — both entries are pending
    // in the SAME session's MutationLog at once. `LayeredQueryStore.recompose` (packages/client/
    // src/layered-store.ts) reruns EVERY surviving updater on EVERY ingest with no filtering by
    // relevance, so convB's own commit landing (its MutationResponse + confirming Transition) is
    // an "ingest" that reruns convA's still-pending updater too — a fresh array, a re-fire, a
    // React re-render for a subscriber who only cares about convA and whose data didn't change.
    const sendA = client.mutation(
      api.messages.send,
      { conversationId: "convA", author: "a", body: "hi" },
      { optimisticUpdate: appendOptimistic as never },
    );
    const sendB = client.mutation(
      api.messages.send,
      { conversationId: "convB", author: "x", body: "unrelated" },
      { optimisticUpdate: appendOptimistic as never },
    );
    await Promise.all([sendA, sendB]);
    await new Promise((r) => setTimeout(r, 50)); // let both gate-closing Transitions land

    console.log(`[i5] hot renders (a second, unrelated pending mutation concurrently in flight): ${rendersA}`);
    // Baseline (one send, nothing else pending) is 2: the synchronous optimistic apply + the
    // confirming Transition. A second, entirely unrelated pending mutation sharing the session
    // adds at least one more convA re-fire caused purely by convB's OWN ingest events, demonstrating
    // the (i)5 concern is real and reachable through the real client + real embedded runtime, not
    // just a theoretical reading of the source.
    expect(rendersA).toBeGreaterThan(2);
  });
});
