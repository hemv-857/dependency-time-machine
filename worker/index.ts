import 'dotenv/config';
import { singletons } from '@/server/singletons';
import { runSnapshotJob } from '@/server/pipeline';
import { reapStaleSnapshots, startReaper } from '@/server/reaper';
import { sweep, activeCount } from '@/server/sandbox';
import { childLogger } from '@/server/log';

const log = childLogger({ mod: 'worker' });

/**
 * Standalone build worker. With REDIS_URL set this consumes 'tm-builds' via
 * BullMQ (scale horizontally). Without Redis it runs the in-process queue and
 * TTL sweeper — useful for single-box self-hosting.
 */
async function main() {
  const s = singletons();
  log.info({ queueMode: s.queue.mode, redis: !!process.env.REDIS_URL }, 'worker starting');

  startReaper();
  // Recover anything a previous process left mid-flight before accepting new work.
  const recovered = await reapStaleSnapshots();
  if (recovered.swept) log.warn({ swept: recovered.swept }, 'recovered stranded snapshots at boot');

  if (s.queue.mode === 'redis') {
    s.queue.process((id) => runSnapshotJob(id));
  } else {
    // in-process queue is already wired by singletons()
    log.info('no REDIS_URL — processing builds in-process');
  }

  setInterval(() => {
    const n = sweep();
    if (n) log.info({ expired: n, active: activeCount() }, 'TTL sweep');
  }, 30_000).unref();

  const shutdown = async () => {
    log.info('worker shutting down');
    await s.store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  log.info('worker ready');
}

main().catch((e) => {
  log.error({ err: e.message }, 'worker crashed');
  process.exit(1);
});
