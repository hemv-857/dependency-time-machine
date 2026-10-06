import { getStore } from '@/server/store';
import { toPublic } from '@/server/public';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const store = getStore();
  const row = await store.getSnapshot(params.id);
  if (!row) return Response.json({ error: 'not_found' }, { status: 404 });
  return Response.json(toPublic(row), { headers: { 'Cache-Control': 'no-store' } });
}
