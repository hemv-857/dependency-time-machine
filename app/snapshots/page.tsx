import Link from 'next/link';

export const dynamic = 'force-dynamic';
// unfiltered listings are per-request; a filtered one may be cached briefly
export const revalidate = 30;

interface Item {
  id: string;
  repo: string;
  htmlUrl: string | null;
  date: string;
  commitSha: string;
  status: string;
  previewMode: string;
  ecosystem: string | null;
  changes: number;
  advisories: number;
  sharePath: string;
}

const FILTERS = ['ready', 'degraded', 'failed', 'analyzing', 'building', 'queued'];

async function fetchItems(params: { status?: string; q?: string }): Promise<{ items: Item[]; total: number; error?: string }> {
  // server-rendered against our own API so there is one code path; in a
  // standalone build the API lives in this same process
  const base = process.env.TM_INTERNAL_BASE || `http://127.0.0.1:${process.env.PORT || 3000}`;
  const qs = new URLSearchParams({ limit: '50' });
  if (params.status) qs.set('status', params.status);
  if (params.q) qs.set('q', params.q);
  try {
    const res = await fetch(`${base}/api/snapshots?${qs}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    });
    if (!res.ok) return { items: [], total: 0, error: `API returned ${res.status}` };
    const j = (await res.json()) as { items: Item[]; total: number };
    return { items: j.items, total: j.total };
  } catch (e) {
    return { items: [], total: 0, error: (e as Error).message };
  }
}

export default async function BrowsePage({
  searchParams,
}: {
  // Next 15+ delivers searchParams as a Promise.
  searchParams: Promise<{ status?: string; q?: string }>;
}) {
  const sp = await searchParams;
  const status = FILTERS.includes(sp.status || '') ? sp.status : undefined;
  const q = sp.q?.slice(0, 100);
  const { items, total, error } = await fetchItems({ status, q });

  return (
    <div className="py-10">
      <h1 className="text-2xl font-bold text-slate-100">Browse snapshots</h1>
      <p className="mt-2 text-sm text-slate-400">
        {error ? (
          <span className="text-rose-300">Could not load the list: {error}</span>
        ) : (
          <>
            {total} snapshot{total === 1 ? '' : 's'}
            {q ? ` matching “${q}”` : ''}
            {status ? ` with status ${status}` : ''}. Older rows are pruned after 90 days.
          </>
        )}
      </p>

      <form method="get" className="card mt-6 flex flex-wrap items-end gap-3 p-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="q" className="section-title mb-0">
            Repository
          </label>
          <input id="q" name="q" defaultValue={q ?? ''} placeholder="owner/name" className="input w-64" />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="status" className="section-title mb-0">
            Status
          </label>
          <select id="status" name="status" defaultValue={status ?? ''} className="input w-40">
            <option value="">any</option>
            {FILTERS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <button className="btn-primary" type="submit">
          Filter
        </button>
        {(q || status) && (
          <Link className="btn-ghost" href="/snapshots">
            Clear
          </Link>
        )}
      </form>

      {items.length === 0 ? (
        <div className="card mt-6 p-8 text-center text-slate-400">
          {error ? 'The list is unavailable right now.' : 'Nothing here yet.'}{' '}
          <Link className="link" href="/">
            Run a snapshot
          </Link>
          .
        </div>
      ) : (
        <ul className="mt-6 space-y-2">
          {items.map((it) => (
            <li key={it.id} className="card p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <Link href={it.sharePath} className="mono text-slate-100 hover:text-mint">
                    {it.repo}@{it.date}
                  </Link>
                  <p className="mono mt-1 text-xs text-slate-500">
                    {it.commitSha}
                    {it.ecosystem ? ` · ${it.ecosystem}` : ''}
                    {it.previewMode === 'iframe' ? ' · live preview' : ''}
                  </p>
                </div>
                <div className="flex items-center gap-3 text-xs">
                  {it.changes > 0 && <span className="chip kind-minor">{it.changes} changed</span>}
                  {it.advisories > 0 && <span className="chip severity-HIGH">{it.advisories} CVEs</span>}
                  <span className={`chip ${it.status === 'failed' ? 'severity-HIGH' : 'kind-added'}`}>{it.status}</span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}