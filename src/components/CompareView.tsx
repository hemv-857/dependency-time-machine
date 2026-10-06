'use client';

import { useCallback, useEffect, useState } from 'react';

interface CompareResult {
  repo: string;
  left: { dateIso: string; sha: string; lockfile: string | null; packages: number };
  right: { dateIso: string; sha: string; lockfile: string | null; packages: number };
  between: {
    counts: Record<string, number>;
    rows: { name: string; a: string | null; b: string | null; kind: string }[];
  };
}

function yearsAgo(n: number): string {
  return new Date(Date.now() - n * 365 * 86400_000).toISOString().slice(0, 10);
}

export default function CompareView({ initialRepo, initialA, initialB }: { initialRepo: string; initialA: string; initialB: string }) {
  const [repo, setRepo] = useState(initialRepo);
  const [a, setA] = useState(initialA || yearsAgo(2));
  const [b, setB] = useState(initialB || yearsAgo(1));
  const [result, setResult] = useState<CompareResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (r: string, da: string, db: string) => {
    if (!r || !da || !db) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: r, a: da, b: db }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message || body.error || `failed (${res.status})`);
      setResult(body);
    } catch (e) {
      setError((e as Error).message);
      setResult(null);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (initialRepo && initialA && initialB) run(initialRepo, initialA, initialB);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="mt-6">
      <form
        className="card flex flex-col gap-3 p-4 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          run(repo, a, b);
        }}
      >
        <label className="flex-1 text-xs text-slate-500">
          repo
          <input className="input mt-1" placeholder="github.com/facebook/react" value={repo} onChange={(e) => setRepo(e.target.value)} spellCheck={false} />
        </label>
        <label className="text-xs text-slate-500">
          date A
          <input type="date" className="input mt-1" value={a} onChange={(e) => setA(e.target.value)} />
        </label>
        <label className="text-xs text-slate-500">
          date B
          <input type="date" className="input mt-1" value={b} onChange={(e) => setB(e.target.value)} />
        </label>
        <button className="btn-primary" disabled={busy}>
          {busy ? 'comparing…' : 'Compare'}
        </button>
      </form>

      {error && <p className="mt-4 text-sm text-rose-400">{error}</p>}

      {result && (
        <div className="mt-6 space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            {[result.left, result.right].map((side, i) => (
              <div key={i} className="card p-4">
                <p className="mono text-mint">{side.dateIso.slice(0, 10)}</p>
                <p className="mono mt-1 text-xs text-slate-500">
                  {side.sha.slice(0, 10)} · {side.lockfile || 'no lockfile'} · {side.packages} packages
                </p>
              </div>
            ))}
          </div>

          <div>
            <div className="mb-3 flex flex-wrap gap-1.5">
              {Object.entries(result.between.counts)
                .filter(([k, v]) => k !== 'total' && v > 0)
                .map(([k, v]) => (
                  <span key={k} className={`chip kind-${k}`}>
                    {v} {k}
                  </span>
                ))}
              {result.between.counts.total === 0 && <span className="text-sm text-slate-500">Identical dependency sets.</span>}
            </div>
            {result.between.rows.length > 0 && (
              <div className="card overflow-hidden">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-edge bg-black/30 text-xs uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="px-4 py-2 font-medium">package</th>
                      <th className="px-4 py-2 font-medium">@ {result.left.dateIso.slice(0, 10)}</th>
                      <th className="px-4 py-2 font-medium">@ {result.right.dateIso.slice(0, 10)}</th>
                      <th className="px-4 py-2 font-medium">delta</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.between.rows.map((r) => (
                      <tr key={r.name} className="border-b border-edge/50">
                        <td className="mono px-4 py-2 text-slate-200">{r.name}</td>
                        <td className="mono px-4 py-2 text-slate-500">{r.a || '—'}</td>
                        <td className="mono px-4 py-2 text-slate-200">{r.b || '—'}</td>
                        <td className="px-4 py-2">
                          <span className={`chip kind-${r.kind}`}>{r.kind}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
