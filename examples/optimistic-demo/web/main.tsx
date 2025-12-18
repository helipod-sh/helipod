import { StrictMode, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { StackbaseClient, anyApi, type OptimisticLocalStore } from "@stackbase/client";
import { StackbaseProvider, useQuery, useMutation } from "@stackbase/client/react";
import { delayTransport } from "./delay-transport";
// Type-only imports — erased at bundle time, so server-side re-exports never reach the browser.
import type { Api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";

const api = anyApi as Api;

const wsProtocol = location.protocol === "https:" ? "wss" : "ws";
export const transport = delayTransport(`${wsProtocol}://${location.host}/api/sync`);

// NO outbox, NO optimisticUpdates registry: this demo is the pure ONLINE optimistic path —
// examples/offline-demo owns durability. A failed mutation here rejects its promise and the
// optimistic layer is dropped in the same reconcile pass (the exact-rollback demo).
const client = new StackbaseClient(transport);

/* ------------------------------------------------------------------------------------------------
 * Optimistic updaters — module-scoped and PURE (replay-safe): ids/time only from the store API,
 * and every updater tolerates an `undefined` baseline (query not subscribed yet → patch nothing).
 * ---------------------------------------------------------------------------------------------- */

type PendingPoll = Doc<"polls"> | (Doc<"polls"> & { pending: true });
type OptionRow = Doc<"options">;

function bumpVotes(store: OptimisticLocalStore, id: Id<"options">, delta: number): void {
  // The option's poll isn't in args, so patch every subscribed options.list — cheap (a demo has
  // a handful of polls) and exactly what getAllQueries exists for.
  for (const q of store.getAllQueries(api.options.list)) {
    if (q.value === undefined) continue;
    store.setQuery(
      api.options.list,
      q.args,
      (q.value as OptionRow[]).map((o) => (o._id === id ? { ...o, votes: o.votes + delta } : o)),
    );
  }
}

function voteOptimistic(store: OptimisticLocalStore, args: { id: Id<"options"> }): void {
  bumpVotes(store, args.id, 1);
}

/** Wrong-guess mode: the updater claims +2 while the server commits +1. On settle the count
 * visibly snaps to truth — the documented echo-snap residual, on purpose: an updater is a guess,
 * the server is always right. */
function voteOptimisticWrong(store: OptimisticLocalStore, args: { id: Id<"options"> }): void {
  bumpVotes(store, args.id, 2);
}

function createPollOptimistic(store: OptimisticLocalStore, args: { question: string; options: string[] }): void {
  const pollsQ = store.getQuery(api.polls.list, {});
  if (pollsQ === undefined) return;
  const row: PendingPoll = {
    _id: store.placeholderId("polls") as Id<"polls">, // rendering-only placeholder — never sent anywhere
    _creationTime: store.now(),
    question: args.question,
    closed: false,
    pending: true,
  };
  store.setQuery(api.polls.list, {}, [...(pollsQ as PendingPoll[]), row]);
  // The pending poll's options can't render yet (options.list is keyed by the REAL poll id, which
  // doesn't exist until commit) — the card shows its question dimmed until the settle. Honest.
}

/* ---------------------------------------- components ------------------------------------------ */

const LATENCY_STOPS = [0, 250, 1000, 3000] as const;

function Controls(props: {
  latency: number;
  onLatency: (ms: number) => void;
  optimistic: boolean;
  onOptimistic: (v: boolean) => void;
  wrongGuess: boolean;
  onWrongGuess: (v: boolean) => void;
}) {
  return (
    <div className="controls">
      <span className="seg">
        {LATENCY_STOPS.map((ms) => (
          <button key={ms} className={props.latency === ms ? "active" : ""} onClick={() => props.onLatency(ms)}>
            {ms === 0 ? "0ms" : ms < 1000 ? `${ms}ms` : `${ms / 1000}s`}
          </button>
        ))}
      </span>
      <span className={`switch${props.optimistic ? " on" : ""}`} onClick={() => props.onOptimistic(!props.optimistic)}>
        optimistic: <b>{props.optimistic ? "ON" : "OFF"}</b>
      </span>
      <span
        className={`switch warn${props.wrongGuess ? " on" : ""}`}
        title="the updater guesses +2; the server commits +1 — watch the settle correct it"
        onClick={() => props.onWrongGuess(!props.wrongGuess)}
      >
        wrong-guess: <b>{props.wrongGuess ? "ON" : "OFF"}</b>
      </span>
    </div>
  );
}

function Poll(props: {
  poll: PendingPoll;
  optimistic: boolean;
  wrongGuess: boolean;
  onToast: (msg: string) => void;
}) {
  const pending = "pending" in props.poll;
  return (
    <section className={pending ? "poll pending" : "poll"}>
      <PollHeader poll={props.poll} pending={pending} onToast={props.onToast} />
      {pending ? (
        <p className="status">creating… (rendered via placeholderId, dimmed until the commit settles)</p>
      ) : (
        <PollOptions pollId={props.poll._id} optimistic={props.optimistic} wrongGuess={props.wrongGuess} onToast={props.onToast} />
      )}
    </section>
  );
}

function PollHeader(props: { poll: PendingPoll; pending: boolean; onToast: (msg: string) => void }) {
  const setClosed = useMutation(api.polls.setClosed);
  return (
    <h2>
      <span className="grow">
        {props.poll.question} {props.poll.closed && <span title="closed — votes will be rejected">🔒</span>}
      </span>
      {!props.pending && (
        <button
          className="subtle"
          onClick={() =>
            void setClosed({ id: props.poll._id, closed: !props.poll.closed }).catch((e: unknown) =>
              props.onToast(`close/reopen failed: ${(e as { code?: string }).code ?? "error"}`),
            )
          }
        >
          {props.poll.closed ? "reopen" : "close"}
        </button>
      )}
    </h2>
  );
}

// A SEPARATE component so useQuery(api.options.list, { pollId }) is only ever mounted with a
// REAL poll id. A pending (placeholderId) poll must not subscribe: useQuery's args default is
// {} when undefined, which would fail options.list's args validator (pollId required).
function PollOptions(props: { pollId: Id<"polls">; optimistic: boolean; wrongGuess: boolean; onToast: (msg: string) => void }) {
  const options = useQuery(api.options.list, { pollId: props.pollId }) as OptionRow[] | undefined;
  const voteRaw = useMutation(api.options.vote);
  const voteRight = voteRaw.withOptimisticUpdate(voteOptimistic);
  const voteWrong = voteRaw.withOptimisticUpdate(voteOptimisticWrong);
  const [inflight, setInflight] = useState<Record<string, number>>({});

  const vote = props.optimistic ? (props.wrongGuess ? voteWrong : voteRight) : voteRaw;
  const total = options?.reduce((s, o) => s + o.votes, 0) ?? 0;

  async function onVote(id: Id<"options">) {
    setInflight((m) => ({ ...m, [id]: (m[id] ?? 0) + 1 }));
    try {
      await vote({ id });
    } catch (e) {
      props.onToast(`vote rejected: ${(e as { code?: string }).code ?? "error"} — rolled back exactly`);
    } finally {
      setInflight((m) => ({ ...m, [id]: Math.max(0, (m[id] ?? 1) - 1) }));
    }
  }

  return (
    <>
      {options === undefined && <p className="status">loading…</p>}
      {options?.map((o) => (
        <div className="opt" key={o._id}>
          <button onClick={() => void onVote(o._id)}>{o.label}</button>
          <div className="bar">
            <div style={{ width: total === 0 ? "0%" : `${(o.votes / total) * 100}%` }} />
          </div>
          <span className="count">{o.votes}</span>
          <span className="inflight">{(inflight[o._id] ?? 0) > 0 ? `+${inflight[o._id]} in flight` : ""}</span>
        </div>
      ))}
    </>
  );
}

function NewPoll() {
  const create = useMutation(api.polls.create).withOptimisticUpdate(createPollOptimistic);
  const [question, setQuestion] = useState("");
  const [labels, setLabels] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    const q = question.trim();
    const opts = labels.split(",").map((s) => s.trim()).filter(Boolean);
    if (!q || opts.length === 0) return;
    void create({ question: q, options: opts }).catch(() => {});
    setQuestion("");
    setLabels("");
  }

  return (
    <form onSubmit={submit}>
      <input type="text" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="New poll question…" />
      <input type="text" value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="Options, comma-separated" />
      <button type="submit">Create</button>
    </form>
  );
}

function App() {
  const polls = useQuery(api.polls.list, {}) as PendingPoll[] | undefined;
  const [latency, setLatency] = useState(transport.getDelay());
  const [optimistic, setOptimistic] = useState(true);
  const [wrongGuess, setWrongGuess] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  function onLatency(ms: number) {
    transport.setDelay(ms);
    setLatency(ms);
  }
  function onToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }

  return (
    <div className="app">
      <header>
        <h1>📊 Pulse</h1>
        <Controls
          latency={latency}
          onLatency={onLatency}
          optimistic={optimistic}
          onOptimistic={setOptimistic}
          wrongGuess={wrongGuess}
          onWrongGuess={setWrongGuess}
        />
      </header>
      <div className="polls">
        {polls === undefined && <p className="status">connecting…</p>}
        {polls?.length === 0 && <p className="status">No polls yet — create one 👇</p>}
        {polls?.map((p) => (
          <Poll key={p._id} poll={p} optimistic={optimistic} wrongGuess={wrongGuess} onToast={onToast} />
        ))}
      </div>
      <NewPoll />
      {toast && <div className="toast">{toast}</div>}
      <footer>
        Crank latency to 3s and vote with optimistic OFF, then ON. Rapid-fire a button (stacking). Close a poll and vote
        (exact rollback). Wrong-guess mode: +2 instantly, settles to +1 — the server is always right.
      </footer>
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <StackbaseProvider client={client}>
        <App />
      </StackbaseProvider>
    </StrictMode>,
  );
}
