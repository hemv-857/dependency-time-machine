import { getStore } from '@/server/store';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const row = await getStore().getSnapshot(params.id);
  if (!row) return Response.json({ error: 'not_found' }, { status: 404 });
  const log = row.buildLog || row.testLog || '(no build log — nothing was built)';
  return new Response(log, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
