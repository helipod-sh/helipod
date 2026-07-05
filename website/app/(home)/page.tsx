import Link from 'next/link';
import './landing.css';

export default function HomePage() {
  return (
    <div className="lp">
      <div className="wrap">
        {/* ---------------- HERO (centered, fixed height) ---------------- */}
        <section className="hero">
          <p className="kicker">
            Open source <b>·</b> self-hosted
          </p>
          <h1>The reactive backend you run yourself.</h1>
          <p className="lede">
            Write your backend as TypeScript queries and mutations. Subscribe once, and helipod{' '}
            <b>pushes fresh results to every client</b> the moment the data changes. No polling, no
            refetching.
          </p>
          <div className="cta-row">
            <Link className="btn btn--primary" href="/docs/get-started/quickstart">
              Read the quickstart →
            </Link>
            <Link className="btn btn--ghost" href="/docs/get-started/what-is-helipod">
              How it works
            </Link>
          </div>
        </section>

        {/* ---------------- BENTO GRID ---------------- */}
        <section className="bento">
          {/* code tile — the reactive read */}
          <article className="cell cell--code s4" aria-hidden="true">
            <div className="code-head">
              <span className="file">helipod/messages.ts</span>
              <span className="chip">reactive</span>
            </div>
            <pre>
              <code>
                <span className="tc">{'// a query is a pure, reactive read'}</span>
                {'\n'}
                <span className="tk">export const</span> <span className="tf">list</span>{' '}
                <span className="tp">=</span> <span className="tf">query</span>
                <span className="tp">({'{'}</span>
                {'\n  '}
                <span className="tf">args</span>
                <span className="tp">:</span> <span className="tp">{'{'}</span>{' '}
                <span className="tf">channelId</span>
                <span className="tp">:</span> <span className="tf">v</span>
                <span className="tp">.</span>
                <span className="tf">id</span>
                <span className="tp">(</span>
                <span className="ts">"channels"</span>
                <span className="tp">)</span> <span className="tp">{'}'}</span>
                <span className="tp">,</span>
                {'\n  '}
                <span className="tf">handler</span>
                <span className="tp">:</span> <span className="tp">(</span>
                <span className="tf">ctx</span>
                <span className="tp">,</span> <span className="tp">{'{'}</span>{' '}
                <span className="tf">channelId</span> <span className="tp">{'}'}</span>
                <span className="tp">)</span> <span className="tp">{'=>'}</span>
                {'\n    '}
                <span className="tf">ctx</span>
                <span className="tp">.</span>
                <span className="tf">db</span>
                <span className="tp">.</span>
                <span className="tk">query</span>
                <span className="tp">(</span>
                <span className="ts">"messages"</span>
                <span className="tp">,</span> <span className="ts">"by_channel"</span>
                <span className="tp">)</span>
                {'\n      '}
                <span className="tp">.</span>
                <span className="tk">eq</span>
                <span className="tp">(</span>
                <span className="ts">"channelId"</span>
                <span className="tp">,</span> <span className="tf">channelId</span>
                <span className="tp">)</span>
                <span className="tp">.</span>
                <span className="tk">collect</span>
                <span className="tp">(),</span>
                {'\n'}
                <span className="tp">{'}'})</span>
                <span className="tp">;</span>
                {'\n\n'}
                <span className="tc">{'// on the client, re-renders when a mutation commits'}</span>
                {'\n'}
                <span className="tk">const</span> <span className="tf">messages</span>{' '}
                <span className="tp">=</span> <span className="tf">useQuery</span>
                <span className="tp">(</span>
                <span className="tf">api</span>
                <span className="tp">.</span>
                <span className="tf">messages</span>
                <span className="tp">.</span>
                <span className="tf">list</span>
                <span className="tp">,</span> <span className="tp">{'{'}</span>{' '}
                <span className="tf">channelId</span> <span className="tp">{'}'}</span>
                <span className="tp">);</span>
              </code>
            </pre>
          </article>

          {/* reactive-loop tile */}
          <article className="cell s2">
            <span className="k">the reactive core</span>
            <h3>Data changes push themselves</h3>
            <p>Every query records what it read; every write is checked against it.</p>
            <div className="loop">
              <div className="loop-step">
                <span className="n">01</span>
                <span className="t">
                  <b>A client subscribes.</b> The engine records its read set.
                </span>
              </div>
              <div className="loop-step">
                <span className="n">02</span>
                <span className="t">
                  <b>A mutation commits</b> in one serializable transaction.
                </span>
              </div>
              <div className="loop-step">
                <span className="n">03</span>
                <span className="t">
                  <b>The result is pushed.</b> Only queries the write touched re-run.
                </span>
              </div>
            </div>
            <Link className="tlink" href="/docs/core-concepts/reactivity">
              Read about reactivity
            </Link>
          </article>

          {/* real stat tile */}
          <article className="cell cell--stat s2">
            <p className="stat">
              8.6<b>ms</b>
            </p>
            <p>
              Median reactive propagation in a same-substrate benchmark. Run it yourself before you
              trust it.
            </p>
            <Link className="tlink" href="/docs/get-started/performance">
              See the numbers
            </Link>
          </article>

          {/* capability tiles */}
          <article className="cell s2">
            <span className="k">components</span>
            <h3>Auth, scheduler, workflows</h3>
            <p>
              Opt-in components: authentication, cron and scheduled jobs, durable multi-step workflows
              with saga compensation, triggers, and notifications.
            </p>
          </article>

          <article className="cell s2">
            <span className="k">storage</span>
            <h3>SQLite or Postgres, plus files</h3>
            <p>
              Zero-config SQLite for local, Postgres when you need it, and built-in blob storage on the
              filesystem or any S3-compatible bucket.
            </p>
          </article>

          <article className="cell s2">
            <span className="k">the client</span>
            <h3>Optimistic and offline</h3>
            <p>
              A typed client with instant optimistic updates and a durable offline outbox that survives
              reloads, with exactly-once delivery on reconnect.
            </p>
          </article>

          <article className="cell s2">
            <span className="k">escape hatches</span>
            <h3>Actions, HTTP, crons</h3>
            <p>
              Actions run outside the transaction for fetch, timers, and randomness. Public HTTP
              endpoints handle webhooks.
            </p>
          </article>

          <article className="cell s2">
            <span className="k">dashboard</span>
            <h3>A live data browser</h3>
            <p>
              Browse and edit tables, watch logs, and run functions from a built-in dashboard that
              updates reactively.
            </p>
          </article>

          {/* deploy tile */}
          <article className="cell s3">
            <span className="k">your infrastructure</span>
            <h3>Runs where you run</h3>
            <p>
              One command in development. In production it is a single self-contained binary, a Docker
              image, or a Cloudflare deployment, backed by your own SQLite file or Postgres. No managed
              cloud in the loop, no vendor lock-in.
            </p>
            <div className="targets">
              <span>single binary</span>
              <span>docker</span>
              <span>cloudflare</span>
              <span>postgres</span>
            </div>
            <Link className="tlink" href="/docs/deploy/self-hosting">
              Self-hosting guide
            </Link>
          </article>

          {/* honest limits tile */}
          <article className="cell cell--limits s3">
            <span className="k">honest limits</span>
            <h3>What it doesn&apos;t do yet</h3>
            <ul>
              <li>
                <b>No search</b>
                <span>Query by index and range. Full-text and vector are reserved seams.</span>
              </li>
              <li>
                <b>Single-node writes</b>
                <span>One writer per shard. Multi-node scale-out is a later tier.</span>
              </li>
              <li>
                <b>No built-in TLS</b>
                <span>Plain HTTP. Front it with nginx, Caddy, or Traefik.</span>
              </li>
              <li>
                <b>In-process functions</b>
                <span>A V8-isolate sandbox for untrusted code is a reserved seam.</span>
              </li>
            </ul>
          </article>

          {/* final CTA tile (full width) */}
          <article className="cell cell--cta s6">
            <span className="kicker">Get started</span>
            <h2>Write your first reactive function in a few minutes.</h2>
            <p>The quickstart takes you from an empty folder to a live, reactive app.</p>
            <Link className="btn btn--primary" href="/docs/get-started/quickstart">
              Start building →
            </Link>
          </article>
        </section>
      </div>

      {/* ---------------- FOOTER — Ft2 Inline ---------------- */}
      <footer className="foot">
        <div className="wrap foot-row">
          <p className="foot-brand">
            helipod <span>the reactive backend you self-host</span>
          </p>
          <nav className="foot-links" aria-label="Footer">
            <Link href="/docs">Docs</Link>
            <Link href="/docs/get-started/quickstart">Quickstart</Link>
            <Link href="/docs/core-concepts/reactivity">Reactivity</Link>
            <Link href="/docs/deploy/self-hosting">Self-hosting</Link>
            <Link href="/docs/reference/faq">FAQ</Link>
          </nav>
          <span className="foot-license">FSL-1.1-Apache-2.0</span>
        </div>
      </footer>
    </div>
  );
}
