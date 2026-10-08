'use client';

import { Fragment, useMemo, useState } from 'react';
import { LockDiff } from '@/lib/tm-types';

const FILTERS = ['all', 'major', 'minor', 'patch', 'added', 'removed', 'security'] as const;
type Filter = (typeof FILTERS)[number];

export default function DiffTable({ diff }: { diff: LockDiff }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const rows = useMemo(() => {
    return diff.changes.filter((c) => {
      if (filter === 'security' && !(c.advisories && c.advisories.length > 0)) return false;
      if (filter !== 'all' && filter !== 'security' && c.kind !== filter) return false;
      if (q && !c.name.toLowerCase().includes(q.toLowerCase())) return false;
      return true;
    });
  }, [diff, filter, q]);

  return (
    <section className="mt-8">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="section-title mb-0">Lockfile then → now</h2>
        <div className="flex flex-wrap items-center gap-1.5">
          <Count n={diff.counts.major} label="major" cls="kind-major" />
          <Count n={diff.counts.minor} label="minor" cls="kind-minor" />
          <Count n={diff.counts.patch} label="patch" cls="kind-patch" />
          <Count n={diff.counts.added} label="added" cls="kind-added" />
          <Count n={diff.counts.removed} label="removed" cls="kind-removed" />
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f}
            className={`chip ${filter === f ? 'bg-mint/20 text-mint' : 'bg-edge/60 text-slate-400 hover:text-slate-200'}`}
            onClick={() => setFilter(f)}
          >
            {f}
          </button>
        ))}
        <input
          className="input ml-auto w-48 py-1 text-xs"
          placeholder="filter packages…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {rows.length === 0 ? (
        <p className="card p-6 text-sm text-slate-500">Nothing matches — {diff.counts.total === 0 ? 'the dependency set is identical.' : 'try another filter.'}</p>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">
              Dependency versions then versus now, with the kind of change and any advisories.
            </caption>
            <thead className="border-b border-edge bg-black/30 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">package</th>
                <th scope="col" className="px-4 py-2 font-medium">then</th>
                <th scope="col" className="px-4 py-2 font-medium">now</th>
                <th scope="col" className="px-4 py-2 font-medium">change</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <Fragment key={c.name}>
                  <tr
                    className="cursor-pointer border-b border-edge/50 hover:bg-edge/20"
                    onClick={() => setOpen(open === c.name ? null : c.name)}
                  >
                    <td className="mono px-4 py-2 text-slate-200">
                      {c.name}
                      {c.advisories && c.advisories.length > 0 && (
                        <span className="ml-2 chip severity-HIGH" title={c.advisories.map((a) => a.id).join(', ')}>
                          🔒 {c.advisories.length}
                        </span>
                      )}
                    </td>
                    <td className="mono px-4 py-2 text-slate-500">{c.from || '—'}</td>
                    <td className="mono px-4 py-2 text-slate-200">{c.to || '—'}</td>
                    <td className="px-4 py-2">
                      <span className={`chip kind-${c.kind}`}>{c.kind}</span>
                    </td>
                  </tr>
                  {open === c.name && (
                    <tr className="border-b border-edge/50 bg-black/20">
                      <td colSpan={4} className="px-4 py-3">
                        {c.advisories && c.advisories.length > 0 && (
                          <div className="mb-2">
                            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">advisories</p>
                            <ul className="mt-1 space-y-1 text-xs">
                              {c.advisories.map((a) => (
                                <li key={a.id}>
                                  <a href={a.url} target="_blank" className="link">{a.id}</a>
                                  <span className={`chip ml-2 severity-${a.severity}`}>{a.severity}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {c.links && c.links.length > 0 && (
                          <p className="flex flex-wrap gap-3 text-xs">
                            {c.links.map((l) => (
                              <a key={l.label + l.href} href={l.href} target="_blank" className="link">
                                {l.label} ↗
                              </a>
                            ))}
                          </p>
                        )}
                        {!c.links?.length && !c.advisories?.length && (
                          <p className="text-xs text-slate-500">No extra details for this bump.</p>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Count({ n, label, cls }: { n: number; label: string; cls: string }) {
  if (!n) return null;
  return (
    <span className={`chip ${cls}`}>
      {n} {label}
    </span>
  );
}
