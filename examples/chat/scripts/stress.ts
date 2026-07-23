#!/usr/bin/env bun
/**
 * Load generator for the chat example — drives sustained, overlapping traffic at
 * the running `helipod dev` server so the terminal dashboard's live numbers,
 * concurrency chart, and reactive activity feed actually move.
 *
 * Run it in a SECOND terminal while `bun run dev` is up in the first:
 *
 *   bun run stress                      # sensible defaults, ~30s
 *   bun run stress -- --seconds 60 --rps 40 --concurrency 12
 *   bun run stress -- --url http://127.0.0.1:3210 --read-ratio 0.7
 *
 * Flags:
 *   --url          server base URL                 (default http://127.0.0.1:3210)
 *   --seconds      how long to run                 (default 30)
 *   --rps          target bursts of calls / second (default 20)
 *   --concurrency  calls fired at once per burst   (default 8)  ← drives the concurrency metric
 *   --read-ratio   fraction that are queries       (default 0.6)
 *
 * It writes real messages into a `stress-*` conversation via `messages:send`
 * and reads them back with `messages:list`, so it exercises the same reactive
 * path a real client would.
 */

interface Args {
  url: string;
  seconds: number;
  rps: number;
  concurrency: number;
  readRatio: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { url: "http://127.0.0.1:3210", seconds: 30, rps: 20, concurrency: 8, readRatio: 0.6 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i]!;
    if (a === "--url") out.url = next();
    else if (a === "--seconds") out.seconds = Number(next());
    else if (a === "--rps") out.rps = Number(next());
    else if (a === "--concurrency") out.concurrency = Number(next());
    else if (a === "--read-ratio") out.readRatio = Number(next());
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const conversationId = `stress-${Math.floor(Date.now() / 1000)}`;
const runEndpoint = `${args.url.replace(/\/$/, "")}/api/run`;

async function call(path: string, fnArgs: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch(runEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, args: fnArgs }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function preflight(): Promise<void> {
  try {
    const res = await fetch(`${args.url.replace(/\/$/, "")}/api/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(String(res.status));
  } catch {
    console.error(`✗ no helipod server at ${args.url} — start one with \`bun run dev\` first.`);
    process.exit(1);
  }
}

let sent = 0;
let ok = 0;
let failed = 0;
let seq = 0;

async function burst(): Promise<void> {
  const calls: Array<Promise<boolean>> = [];
  for (let i = 0; i < args.concurrency; i++) {
    if (Math.random() < args.readRatio) {
      calls.push(call("messages:list", { conversationId }));
    } else {
      seq++;
      calls.push(call("messages:send", { conversationId, author: "stress", body: `message ${seq}` }));
    }
  }
  sent += calls.length;
  const results = await Promise.all(calls);
  for (const r of results) r ? ok++ : failed++;
}

async function main(): Promise<void> {
  await preflight();
  console.log(
    `stressing ${args.url} for ${args.seconds}s · ${args.rps} bursts/s × ${args.concurrency} concurrent ` +
      `· ${Math.round(args.readRatio * 100)}% reads · conversation ${conversationId}`,
  );
  console.log("watch the terminal dashboard's `running functions` chart and activity feed…\n");

  const started = Date.now();
  const endAt = started + args.seconds * 1000;
  const period = 1000 / args.rps;
  let ticks = 0;

  while (Date.now() < endAt) {
    const tickStart = Date.now();
    void burst();
    ticks++;
    if (ticks % args.rps === 0) {
      const elapsed = ((Date.now() - started) / 1000).toFixed(0);
      process.stdout.write(`\r  ${elapsed}s · sent ${sent} · ok ${ok} · failed ${failed}   `);
    }
    const drift = Date.now() - tickStart;
    if (drift < period) await new Promise((r) => setTimeout(r, period - drift));
  }

  // Let the final in-flight bursts settle.
  await new Promise((r) => setTimeout(r, 500));
  const secs = (Date.now() - started) / 1000;
  console.log(
    `\n\ndone · ${sent} calls in ${secs.toFixed(1)}s ` +
      `(${Math.round(sent / secs)}/s) · ok ${ok} · failed ${failed} · ${seq} messages written`,
  );
}

void main();
