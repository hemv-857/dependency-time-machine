import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'API — Dependency Time Machine' };

function Endpoint({ method, path, children }: { method: string; path: string; children: React.ReactNode }) {
  const color = method === 'POST' ? 'bg-amber-500/15 text-amber-300' : 'bg-mint/15 text-mint';
  return (
    <div className="card p-5">
      <p className="mono">
        <span className={`chip ${color}`}>{method}</span> <span className="text-slate-200">{path}</span>
      </p>
      <div className="mt-3 space-y-2 text-sm text-slate-400">{children}</div>
    </div>
  );
}

export default function DocsPage() {
  return (
    <div className="py-10">
      <h1 className="text-2xl font-bold text-slate-100">API</h1>
      <p className="mt-2 max-w-2xl text-sm text-slate-400">
        Everything the UI does is a public JSON API. Base URL: your deployment root. Rate limits apply per IP
        (30 snapshots/hour, 60 resolves+previews/min, 30 compares/hour) — 429 responses include{' '}
        <code className="mono text-mint">Retry-After</code>. Set <code className="mono text-mint">GITHUB_TOKEN</code>{' '}
        server-side to raise upstream limits.
      </p>

      <div className="mt-6 space-y-4">
        <Endpoint method="POST" path="/api/snapshot">
          <p>Create (or reuse) a snapshot. Body:</p>
          <pre className="log-box">{`{
  "repo": "github.com/expressjs/express",
  "date": "2019-01-01",   // optional, default: 1 year ago. Tag/branch also accepted
  "ref":  "v4.17.1",      // optional, wins over date
  "force": false          // bypass snapshot cache, rebuild
}`}</pre>
          <p>
            Returns <code className="mono text-mint">202</code> with the full snapshot (status{' '}
            <code>queued</code>). Poll or subscribe for progress.
          </p>
        </Endpoint>

        <Endpoint method="GET" path="/api/snapshot/:id">
          <p>
            Full snapshot state: status, stages, lockfile diff, security lens, story, timeline, README, toolchain,
            live preview info. Terminal statuses: <code>ready</code>, <code>degraded</code> (build failed — changelog
            only), <code>failed</code>.
          </p>
        </Endpoint>

        <Endpoint method="GET" path="/api/snapshot/:id/events">
          <p>
            Server-Sent Events progress stream. Events: <code>snapshot</code> (initial state), <code>stage</code>{' '}
            (pipeline progress), <code>done</code> (final full snapshot). Heartbeat every 15s.
          </p>
          <pre className="log-box">{`const es = new EventSource('/api/snapshot/ID/events');
es.addEventListener('done', (e) => console.log(JSON.parse(e.data)));`}</pre>
        </Endpoint>

        <Endpoint method="GET" path="/api/snapshot/:id/log">
          <p>Build/test log as text/plain (streams of the sandbox build).</p>
        </Endpoint>

        <Endpoint method="POST" path="/api/snapshot/:id/preview">
          <p>
            (Re)start the ephemeral preview sandbox for a ready snapshot. Returns{' '}
            <code className="mono text-mint">{`{ sandboxId, url, expiresAt }`}</code>. Instances expire after 10
            minutes; call again to rebuild on demand — cached builds make this fast.
          </p>
        </Endpoint>

        <Endpoint method="GET" path="/api/preview/:sandboxId/*">
          <p>
            Proxy to the sandboxed instance (this is what the iframe loads). Expired sandboxes return{' '}
            <code className="mono text-mint">410</code> with a rebuild hint.
          </p>
        </Endpoint>

        <Endpoint method="GET" path="/api/resolve?repo=…&date=…">
          <p>
            Resolve a repo + date/ref to the exact commit a snapshot would pin:{' '}
            <code className="mono text-mint">{`{ commitSha, commitDate, commitUrl }`}</code>.
          </p>
        </Endpoint>

        <Endpoint method="POST" path="/api/compare">
          <p>Compare mode. Body <code className="mono">{`{ "repo": "…", "a": "2023-01-01", "b": "2024-01-01" }` }</code> —
            returns both sides plus the dependency delta between them.</p>
        </Endpoint>

        <Endpoint method="GET" path="/api/healthz · /api/readyz">
          <p>Liveness and readiness (store, queue mode, GitHub rate budget, active sandboxes).</p>
        </Endpoint>
      </div>

      <h2 className="section-title mt-10">Shareable URLs</h2>
      <div className="card p-5">
        <pre className="log-box">{`/github.com/foo/bar@2024-01-15        → commit closest to that date
/github.com/foo/bar@v3.1.0            → that tag
/github.com/foo/bar                   → 1 year ago
/compare?repo=…&a=…&b=…               → compare mode`}</pre>
      </div>

      <h2 className="section-title mt-10">Self-host</h2>
      <div className="card p-5 text-sm text-slate-400">
        <pre className="log-box">{`# zero-config dev (in-memory store, local runner)
npm install && npm run dev

# full stack: postgres + redis + containerized web
docker compose up --build`}</pre>
        <p className="mt-3">
          See <code className="mono text-mint">README.md</code> for the security model, all env vars, and the Fly.io/K8s notes.
        </p>
      </div>
    </div>
  );
}
