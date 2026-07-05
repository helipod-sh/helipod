/**
 * The configuration-constructible `WakeHost` — `serve --wake-url <url>`'s implementation.
 *
 * A `WakeHost` is a JS closure, but the deployment rig can't inject one: what runs is the SHIPPED
 * `helipod serve` inside a built image. So the host is built from configuration instead, exactly
 * like `--object-store`/`--database-url` already are, and the engine's whole knowledge of the host
 * is "POST an integer to a URL" — no host primitive anywhere in `packages/`/`components/`. On
 * Cloudflare the URL is an Outbound-Workers magic hostname (`http://wake.do/arm`): the request never
 * leaves the Workers runtime, and the Worker turns it into a Durable Object alarm. Any other host
 * can implement the same two lines.
 */
import type { WakeHost } from "@helipod/component";

/**
 * POSTs the next wake's ABSOLUTE `atMs` (the body is the bare integer; `null` — nothing pending —
 * is an empty body) to `url`.
 *
 * FIRE-AND-FORGET, by contract: `armWake` returns `void` and is called from a driver's synchronous
 * timer bookkeeping, which must never block on — or fail because of — a network hop. A failed POST
 * is logged, never thrown, and degrades to a missed wake, which self-heals: the durable table state
 * is the truth and the alarm only decides WHEN TO LOOK, so any later request (or the next successful
 * arm) boots the process and dispatches whatever is overdue.
 */
export function httpWakeHost(url: string): WakeHost {
  return {
    armWake(atMs: number | null): void {
      void fetch(url, { method: "POST", body: atMs === null ? "" : String(atMs) })
        .then((res) => {
          if (!res.ok) console.error(`[wake] arm at ${atMs} rejected by ${url}: ${res.status}`);
        })
        .catch((e: unknown) => {
          console.error(`[wake] arm at ${atMs} failed to reach ${url}:`, e);
        });
    },
  };
}
