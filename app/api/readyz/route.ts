import { getStore } from '@/server/store';
import { getQueue } from '@/server/queue';
import { activeCount } from '@/server/sandbox';
import { ghClient } from '@/server/github';

export const dynamic = 'force-dynamic';

export async function GET() {
  const checks: Record<string, unknown> = {};
  let ready = true;
  try {
    const store = getStore();
    await store.init();
    checks.store = store && 'ok';
    const queue = getQueue();
    checks.queue = { mode: queue.mode };
    checks.sandboxes = { active: activeCount() };
    const gh = ghClient();
    checks.github = { rateRemaining: gh.remaining, rateReset: gh.resetAt };

    // Builds degrade to changelog-only rather than failing the request, so a
    // missing daemon must not flip readiness — but operators need to see it.
    const { dockerAvailable } = await import('@/server/builder/docker');
    checks.builds = {
      runner: process.env.TM_RUNNER || 'auto',
      dockerHost: process.env.TM_DOCKER_HOST || 'unix:///var/run/docker.sock',
      dockerReachable: await dockerAvailable(),
      localExecAllowed: (await import('@/server/builder/local')).untrustedExecAllowed(),
    };
  } catch (e) {
    ready = false;
    checks.error = (e as Error).message;
  }
  return Response.json({ ready, checks }, { status: ready ? 200 : 503 });
}
