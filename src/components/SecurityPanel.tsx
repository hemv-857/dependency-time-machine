'use client';

import { Advisory, SecurityLens } from '@/lib/tm-types';

export default function SecurityPanel({ lens }: { lens: SecurityLens }) {
  if (!lens.available) {
    return (
      <section className="mt-8">
        <h2 className="section-title">Security lens</h2>
        <p className="card p-6 text-sm text-slate-500">
          Advisory lookup (OSV.dev) was unavailable for this snapshot — try again later.
        </p>
      </section>
    );
  }
  return (
    <section className="mt-8">
      <h2 className="section-title">Security lens — then vs now</h2>
      <div className="mb-3 flex flex-wrap gap-2 text-sm">
        <span className="chip bg-rose-500/15 text-rose-300">{lens.then.length} existed then</span>
        <span className="chip bg-mint/15 text-mint">{lens.fixed.length} fixed since</span>
        <span className="chip bg-amber-500/15 text-amber-300">{lens.stillOpen.length} still open</span>
      </div>
      {lens.then.length === 0 ? (
        <p className="card p-6 text-sm text-slate-500">
          ✓ No known advisories affected this snapshot&apos;s dependency versions.
        </p>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-edge bg-black/30 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">advisory</th>
                <th className="px-4 py-2 font-medium">severity</th>
                <th className="px-4 py-2 font-medium">packages</th>
                <th className="px-4 py-2 font-medium">summary</th>
                <th className="px-4 py-2 font-medium">status now</th>
              </tr>
            </thead>
            <tbody>
              {lens.then.map((a) => (
                <AdvisoryRow key={a.id} a={a} fixed={!lens.stillOpen.some((s) => s.id === a.id)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function AdvisoryRow({ a, fixed }: { a: Advisory; fixed: boolean }) {
  return (
    <tr className="border-b border-edge/50">
      <td className="px-4 py-2">
        <a href={a.url} target="_blank" className="link mono text-xs">
          {a.id}
        </a>
        {a.aliases.filter((x) => x.startsWith('CVE-')).map((cve) => (
          <span key={cve} className="mono ml-2 text-[11px] text-slate-500">
            {cve}
          </span>
        ))}
      </td>
      <td className="px-4 py-2">
        <span className={`chip severity-${a.severity}`}>{a.severity}</span>
      </td>
      <td className="mono px-4 py-2 text-xs text-slate-400">{a.packages.join(', ')}</td>
      <td className="px-4 py-2 text-xs text-slate-400">{a.summary || '—'}</td>
      <td className="px-4 py-2">
        {fixed ? (
          <span className="chip bg-mint/15 text-mint">fixed</span>
        ) : (
          <span className="chip bg-amber-500/15 text-amber-300">still open</span>
        )}
      </td>
    </tr>
  );
}
