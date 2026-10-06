import { childLogger } from './log';

const log = childLogger({ mod: 'queue' });

export interface JobQueue {
  /** enqueue a build job by snapshot id */
  enqueue(snapshotId: string): Promise<void>;
  /** register handler (starts processing); safe to call once */
  process(handler: (snapshotId: string) => Promise<void>): void;
  pending(): number;
  mode: 'memory' | 'redis';
}

export function memoryQueue(concurrency = Number(process.env.TM_CONCURRENCY || 2)): JobQueue {
  const q: string[] = [];
  let active = 0;
  let handler: ((id: string) => Promise<void>) | null = null;

  const pump = () => {
    while (handler && active < concurrency && q.length > 0) {
      const id = q.shift()!;
      active++;
      handler(id)
        .catch((e) => log.error({ snapshotId: id, err: (e as Error).message }, 'job handler crashed'))
        .finally(() => {
          active--;
          pump();
        });
    }
  };

  return {
    mode: 'memory',
    async enqueue(id) {
      q.push(id);
      log.info({ snapshotId: id, depth: q.length }, 'job enqueued');
      pump();
    },
    process(h) {
      handler = h;
      pump();
    },
    pending() {
      return q.length + active;
    },
  };
}

const globalForQueue = globalThis as unknown as { __tmQueue?: JobQueue; __tmWired?: boolean };

export function getQueue(): JobQueue {
  if (globalForQueue.__tmQueue) return globalForQueue.__tmQueue;
  let q: JobQueue;
  if (process.env.REDIS_URL) {
    // Lazy require so dev without redis never loads bullmq.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { redisQueue } = require('./redis-queue') as typeof import('./redis-queue');
    q = redisQueue() as unknown as JobQueue;
  } else {
    q = memoryQueue();
  }
  globalForQueue.__tmQueue = q;

  // Wire build processing once, in whatever process first touches the queue
  // (the Next server in dev/self-host; the standalone worker with Redis).
  if (!globalForQueue.__tmWired) {
    globalForQueue.__tmWired = true;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { runSnapshotJob } = require('./pipeline') as typeof import('./pipeline');
    q.process((id) => runSnapshotJob(id));
  }
  return q;
}
