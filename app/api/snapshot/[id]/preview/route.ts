import { clientIp, rateLimit, tooMany } from '@/server/ratelimit';
import { ensurePreview } from '@/server/pipeline';

export const dynamic = 'force-dynamic';

/** (Re)start the ephemeral preview sandbox for a ready snapshot. Rebuilds on demand from cache. */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const rl = await rateLimit(`preview:${clientIp(req)}`, 60, 60);
  if (!rl.ok) return tooMany(rl);
  try {
    const sb = await ensurePreview(params.id);
    return Response.json(sb);
  } catch (e) {
    const err = e as Error;
    const status = err.name === 'NotFoundError' ? 404 : 400;
    return Response.json({ error: err.message }, { status });
  }
}
