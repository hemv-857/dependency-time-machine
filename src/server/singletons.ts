import { newId, nowIso, Store, SnapshotRow } from './store/index';

export interface Singletons {
  store: Store;
  queue: ReturnType<typeof import('./queue').getQueue>;
  gh: import('./github').GhClient;
}

const globalForS = globalThis as unknown as { __tmSingletons?: Singletons & { processed?: boolean } };

/**
 * Process-wide singletons, hot-reload safe (Next dev re-evaluates modules).
 * The in-process queue is wired here so `npm run dev` works with zero infra;
 * production can point REDIS_URL and run `npm run worker` instead.
 */
export function singletons(): Singletons {
  if (!globalForS.__tmSingletons) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getStore } = require('./store/index') as typeof import('./store/index');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getQueue } = require('./queue') as typeof import('./queue');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { GhClient } = require('./github') as typeof import('./github');

    const store = getStore();
    const queue = getQueue();
    const gh = new GhClient();
    const s = { store, queue, gh, processed: false };
    globalForS.__tmSingletons = s;
  }
  const s = globalForS.__tmSingletons!;
  if (!s.processed) {
    s.processed = true;
    s.store.init().catch((e) => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { childLogger } = require('./log') as typeof import('./log');
      childLogger({ mod: 'singletons' }).error({ err: e.message }, 'store init failed');
    });
  }
  return s;
}

export { newId, nowIso };
export type { SnapshotRow };
