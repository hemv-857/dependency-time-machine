import { z } from 'zod';
import { parseRepoInput } from '@/core/repo-url';
import { normalizeDateInput } from '@/core/repo-url';
import { clientIp, rateLimit, tooMany } from '@/server/ratelimit';
import { ensureSnapshot } from '@/server/pipeline';
import { toPublic } from '@/server/public';

export const dynamic = 'force-dynamic';

const Body = z.object({
  repo: z.string().min(3),
  date: z.string().optional(),
  ref: z.string().optional(),
  force: z.boolean().optional(),
});

export async function POST(req: Request) {
  const rl = await rateLimit(`snapshot:${clientIp(req)}`, 30, 3600);
  if (!rl.ok) return tooMany(rl);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: 'invalid_body', detail: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const repo = parseRepoInput(parsed.data.repo);
    const when = normalizeDateInput(parsed.data.date || repo.date);
    const row = await ensureSnapshot({
      owner: repo.owner,
      name: repo.name,
      dateIso: when.kind === 'date' ? when.iso : undefined,
      ref: when.kind === 'ref' ? when.ref : parsed.data.ref || null,
      force: parsed.data.force,
    });
    return Response.json(toPublic(row), { status: 202 });
  } catch (e) {
    const err = e as Error;
    const status = err.name === 'NotFoundError' ? 404 : err.name === 'RateLimitError' ? 429 : 400;
    return Response.json({ error: err.name, message: err.message }, { status });
  }
}
