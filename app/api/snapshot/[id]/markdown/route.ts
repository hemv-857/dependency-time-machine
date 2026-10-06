import { getStore } from '@/server/store';
import { snapshotToMarkdown } from '@/server/markdown';
import { rateLimit, tooMany, clientIp } from '@/server/ratelimit';

export const dynamic = 'force-dynamic';

/** Download a snapshot as a standalone Markdown report. */
export async function GET(req: Request, ctx: { params: { id: string } }) {
  const rl = await rateLimit(`md:${clientIp(req)}`, 60, 60);
  if (!rl.ok) return tooMany(rl);

  const store = getStore();
  const row = await store.getSnapshot(ctx.params.id);
  if (!row) {
    return Response.json(
      { error: 'NotFoundError', message: `No snapshot with id ${ctx.params.id}` },
      { status: 404 }
    );
  }

  // Prefer an explicit public origin: behind a proxy or a platform router the
  // Host header is often an internal address, which would bake an unusable
  // permalink into every exported report.
  const publicUrl = (process.env.TM_PUBLIC_URL || '').replace(/\/$/, '');
  const origin = publicUrl || new URL(req.url).origin;
  const md = snapshotToMarkdown(row, origin);
  const filename = `${row.repo.replace('/', '-')}${row.dateIso ? `-${row.dateIso.slice(0, 10)}` : ''}.md`;

  return new Response(md, {
    status: 200,
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
      'X-Snapshot-Id': row.id,
    },
  });
}