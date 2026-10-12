import { ImageResponse } from 'next/og';
import { getStore } from '@/server/store';
import { toPublic } from '@/server/public';

/**
 * OpenGraph image for a shareable snapshot permalink.
 *
 * Crawlers fetch this without executing JS, and the permalink page resolves the
 * snapshot client-side — so this must work with no snapshot and no GitHub call.
 * Everything is derived from the URL plus an indexed repo+date lookup, and counts
 * are included only when that snapshot already exists. A cold permalink still
 * gets a real card rather than a 500.
 */
export const runtime = 'nodejs';

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c === "'" ? '&apos;' : '&quot;'
  );
}

export async function GET(_req: Request, { params }: { params: Promise<{ repo: string; date: string }> }) {
  const { repo, date } = await params;
  const [owner, name] = repo.split('/');
  const when = /^\d{4}-\d{2}-\d{2}/.exec(date || '')?.[0] || '';

  let counts: { total: number; major: number; cves: number; fixed: number } | null = null;
  let status = '';
  try {
    const row = when ? await getStore().findByRepoDate(repo, when) : null;
    if (row) {
      const p = toPublic(row);
      counts = {
        total: (p.diff as { counts?: { total?: number } })?.counts?.total ?? 0,
        major: (p.diff as { counts?: { major?: number } })?.counts?.major ?? 0,
        cves: (p.advisories as { then?: unknown[] })?.then?.length ?? 0,
        fixed: (p.advisories as { fixed?: unknown[] })?.fixed?.length ?? 0,
      };
      status = p.status;
    }
  } catch {
    // a card without numbers still beats no card
  }

  const title = escapeXml(`${owner}/${name}`);
  const whenLabel = when ? `as of ${when}` : 'time travel for any repo';

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          // next/og renders via satori, which supports only a CSS subset:
          // no multi-layer gradients, no background-size. Solid fills only.
          backgroundColor: '#0a0f1c',
          padding: 64,
          color: '#e2e8f0',
          fontFamily: 'monospace',
        }}
      >
        <div style={{ display: 'flex', height: 8, backgroundColor: '#34d399', width: 180, borderRadius: 4 }} />
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 14, fontSize: 30, color: '#34d399' }}>
          <div style={{ display: 'flex' }}>⏳</div>
          <div style={{ display: 'flex' }}>Dependency Time Machine</div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', fontSize: 68, fontWeight: 700, color: '#f1f5f9' }}>{title}</div>
          <div style={{ display: 'flex', fontSize: 34, color: '#94a3b8' }}>{whenLabel}</div>
        </div>

        {counts ? (
          <div style={{ display: 'flex', flexDirection: 'row', gap: 20 }}>
            {[
              { k: 'packages moved', v: counts.total },
              { k: 'major bumps', v: counts.major },
              { k: 'CVEs open then', v: counts.cves },
              { k: 'CVEs fixed since', v: counts.fixed },
            ].map((s) => (
              <div
                key={s.k}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  backgroundColor: '#0f1729',
                  border: '1px solid #1c2942',
                  borderRadius: 14,
                  padding: '14px 22px',
                }}
              >
                <div style={{ display: 'flex', fontSize: 40, fontWeight: 700, color: '#34d399' }}>
                  {String(s.v)}
                </div>
                <div style={{ display: 'flex', fontSize: 20, color: '#94a3b8' }}>{s.k}</div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ display: 'flex', fontSize: 26, color: '#64748b' }}>
            Lockfile then-vs-now · CVEs open back then and fixed now
          </div>
        )}

        <div style={{ display: 'flex', fontSize: 22, color: '#475569' }}>
          {status ? `status: ${status}` : 'diff · changelog · security lens'}
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  );
}