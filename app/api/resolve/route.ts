import { parseRepoInput, normalizeDateInput } from '@/core/repo-url';
import { clientIp, rateLimit, tooMany } from '@/server/ratelimit';
import { resolveTarget } from '@/server/pipeline';
import { ghClient } from '@/server/github';

export const dynamic = 'force-dynamic';

/** Resolve a repo+date/ref to the exact commit a snapshot would pin. */
export async function GET(req: Request) {
  const rl = await rateLimit(`resolve:${clientIp(req)}`, 60, 60);
  if (!rl.ok) return tooMany(rl);

  const url = new URL(req.url);
  const repoInput = url.searchParams.get('repo') || '';
  let repo;
  try {
    repo = parseRepoInput(repoInput);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
  const when = normalizeDateInput(url.searchParams.get('date') || undefined);
  try {
    const target = await resolveTarget(ghClient(), repo.fullName, {
      dateIso: when.kind === 'date' ? when.iso : undefined,
      ref: when.kind === 'ref' ? when.ref : url.searchParams.get('ref'),
    });
    return Response.json({
      repo: repo.canonical,
      commitSha: target.sha,
      commitDate: target.committedDate,
      commitUrl: `https://github.com/${repo.fullName}/commit/${target.sha}`,
    });
  } catch (e) {
    const err = e as Error;
    const status = err.name === 'NotFoundError' ? 404 : err.name === 'RateLimitError' ? 429 : 400;
    return Response.json({ error: err.name, message: err.message }, { status });
  }
}
