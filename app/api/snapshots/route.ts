import { getStore } from '@/server/store';
import { toPublic } from '@/server/public';
import { rateLimit, tooMany, clientIp } from '@/server/ratelimit';
import { budgetStatus } from '@/server/gh-budget';

export const dynamic = 'force-dynamic';

/**
 * Browse snapshots.
 *
 * Until now a snapshot was only reachable by exact permalink, which made the
 * store's contents invisible and meant a shared link was the only way back to
 * anything. Paginated, filterable, and rate limited like the other write-ish
 * endpoints.
 */
export async function GET(req: Request) {
  const rl = await rateLimit(`list:${clientIp(req)}`, 60, 60);
  if (!rl.ok) return tooMany(rl);

  const u = new URL(req.url);
  const limit = clamp(Number(u.searchParams.get('limit') ?? 20), 1, 100);
  const offset = Math.max(0, Number(u.searchParams.get('offset') ?? 0) || 0);
  const repo = u.searchParams.get('repo') || undefined;
  const status = u.searchParams.get('status') || undefined;
  const q = u.searchParams.get('q') || undefined;

  const store = getStore();
  const [rows, total] = await Promise.all([
    store.list({ limit, offset, repo, status, q }),
    store.count({ repo, status, q }),
  ]);

  return Response.json(
    {
      total,
      limit,
      offset,
      githubBudget: budgetStatus(),
      items: rows.map((r) => {
        const p = toPublic(r);
        return {
          id: p.id,
          repo: p.repo.fullName,
          htmlUrl: p.repo.htmlUrl,
          date: p.dateIso.slice(0, 10),
          commitDate: p.commitDate,
          commitSha: p.commit.sha.slice(0, 10),
          status: p.status,
          previewMode: p.previewMode,
          ecosystem: p.ecosystem,
          changes: (p.diff as { counts?: { total?: number } })?.counts?.total ?? 0,
          advisories: (p.advisories as { then?: unknown[] })?.then?.length ?? 0,
          sharePath: p.sharePath,
          createdAt: p.createdAt,
        };
      }),
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}