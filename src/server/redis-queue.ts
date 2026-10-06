import IORedis from 'ioredis';
import { Queue, Worker } from 'bullmq';
import { childLogger } from './log';

const log = childLogger({ mod: 'redis-queue' });

let queue: Queue | null = null;
let worker: Worker | null = null;

function connection(): IORedis {
  return new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
}

function getQueue(): Queue {
  if (!queue) queue = new Queue('tm-builds', { connection: connection() });
  return queue;
}

export function redisQueue(): {
  mode: 'redis';
  enqueue(id: string): Promise<void>;
  process(handler: (id: string) => Promise<void>): void;
  pending(): Promise<number>;
} {
  return {
    mode: 'redis',
    async enqueue(id: string) {
      await getQueue().add('build', { snapshotId: id }, { jobId: id, removeOnComplete: 500, removeOnFail: 500 });
    },
    process(handler) {
      if (worker) return;
      worker = new Worker(
        'tm-builds',
        async (job) => handler(job.data.snapshotId),
        { connection: connection(), concurrency: Number(process.env.TM_CONCURRENCY || 2) }
      );
      worker.on('failed', (job, err) => log.error({ jobId: job?.id, err: err.message }, 'build job failed'));
      log.info('bullmq worker started');
    },
    pending: async () => (await getQueue().getJobCounts()).waiting || 0,
  };
}
