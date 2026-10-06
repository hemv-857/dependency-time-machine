import { z } from 'zod';
import { parseRepoInput, normalizeDateInput } from '@/core/repo-url';
import { diffLockfiles } from '@/core/lockfile/diff';
import { clientIp, rateLimit, tooMany } from '@/server/ratelimit';
import { analyzeCommit, resolveTarget } from '@/server/pipeline';
import { ghClient } from '@/server/github';

export const dynamic = 'force-dynamic';

const Body = z.object({
  repo: z.string().min(3),
  a: z.string(),
  b: z.string(),
});

/** Compare mode: two dates side-by-side, plus the dependency delta between them. */
export async function POST(req: Request) {
  const rl = await rateLimit(`compare:${clientIp(req)}`, 30, 3600);
  if (!rl.ok) return tooMany(rl);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) return Response.json({ error: 'invalid_body', detail: parsed.error.flatten() }, { status: 400 });

  let repo;
  try {
    repo = parseRepoInput(parsed.data.repo);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }

  try {
    const gh = ghClient();
    const wa = normalizeDateInput(parsed.data.a);
    const wb = normalizeDateInput(parsed.data.b);
    const [ta, tb] = await Promise.all([
      resolveTarget(gh, repo.fullName, { dateIso: wa.kind === 'date' ? wa.iso : undefined, ref: wa.kind === 'ref' ? wa.ref : undefined }),
      resolveTarget(gh, repo.fullName, { dateIso: wb.kind === 'date' ? wb.iso : undefined, ref: wb.kind === 'ref' ? wb.ref : undefined }),
    ]);
    const [aa, ab] = await Promise.all([analyzeCommit(gh, repo.fullName, ta.sha), analyzeCommit(gh, repo.fullName, tb.sha)]);
    const between = diffLockfiles(aa.lockfile, ab.lockfile);
    return Response.json({
      repo: repo.canonical,
      left: { dateIso: ta.committedDate, sha: ta.sha, projectType: aa.projectType, lockfile: aa.lockfile?.path || null, packages: Object.keys(aa.lockfile?.packages || {}).length },
      right: { dateIso: tb.committedDate, sha: tb.sha, projectType: ab.projectType, lockfile: ab.lockfile?.path || null, packages: Object.keys(ab.lockfile?.packages || {}).length },
      between: {
        counts: between.counts,
        rows: between.changes.map((c) => ({ name: c.name, a: c.from ?? null, b: c.to ?? null, kind: c.kind })),
      },
    });
  } catch (e) {
    const err = e as Error;
    const status = err.name === 'NotFoundError' ? 404 : err.name === 'RateLimitError' ? 429 : 400;
    return Response.json({ error: err.name, message: err.message }, { status });
  }
}
