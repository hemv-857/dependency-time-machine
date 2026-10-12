import { createHash } from 'node:crypto';
import { getStore } from '@/server/store';
import { toPublic } from '@/server/public';

export const dynamic = 'force-dynamic';

/**
 * Snapshot read with conditional-request support.
 *
 * Permalinks are re-fetched constantly (page loads, polling, crawlers) and each
 * read used to be a fresh server round trip. The snapshot only changes while it
 * is non-terminal, so once it settles the body is immutable for a given id and
 * `updatedAt` — which makes a content ETag both correct and effective.
 *
 * While a snapshot is still running it stays uncacheable, so a client polling for
 * progress never receives a stale "analyzing".
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const store = getStore();
  const row = await store.getSnapshot(id);
  if (!row) return Response.json({ error: 'not_found' }, { status: 404 });

  const terminal = row.status === 'ready' || row.status === 'degraded' || row.status === 'failed';
  const body = toPublic(row);
  const etag = `"${createHash('sha1').update(`${row.id}:${row.updatedAt}`).digest('base64url')}"`;

  if (req.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': cacheControl(terminal) } });
  }
  return Response.json(body, { headers: { ETag: etag, 'Cache-Control': cacheControl(terminal) } });
}

/** Terminal snapshots are immutable, so let clients and CDNs keep them. */
function cacheControl(terminal: boolean): string {
  return terminal ? 'public, max-age=300, stale-while-revalidate=86400' : 'no-store';
}