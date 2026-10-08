import { childLogger } from './log';
import { getStore, isTerminal } from './store';

const log = childLogger({ mod: 'reaper' });

/**
 * How long a snapshot may sit in a non-terminal state before we assume the
 * process running it is gone. Generous: a build can legitimately take
 * TM_BUILD_TIMEOUT_MS (3 min default) plus analysis time.
 */
export const STALE_MS = Number(process.env.TM_STALE_SNAPSHOT_MS || 15 * 60 * 1000);
const SWEEP_MS = Number(process.env.TM_REAPER_INTERVAL_MS || 60_000);

export interface ReapResult {
  swept: number;
  ids: string[];
}

/**
 * Fail snapshots that are stuck in queued/analyzing/building.
 *
 * The pipeline catches its own errors and marks a snapshot failed, but a process
 * that *dies* mid-job — OOM, SIGKILL, deploy restart — never runs that catch, so
 * the row stays non-terminal forever and the UI spins indefinitely. Nothing else
 * recovers it: the in-memory queue has no redelivery, and BullMQ's stalled-job
 * detection only covers the Redis path.
 *
 * Only rows untouched for longer than STALE_MS are touched, so a snapshot that
 * another worker is legitimately still building is left alone.
 */
export async function reapStaleSnapshots(now = Date.now()): Promise<ReapResult> {
  const store = getStore();
  const cutoff = new Date(now - STALE_MS).toISOString();
  const stranded = await store.listStranded(cutoff);
  if (!stranded.length) return { swept: 0, ids: [] };

  const ids: string[] = [];
  for (const row of stranded) {
    // Re-check: the job may have completed between the query and the write.
    const fresh = await store.getSnapshot(row.id);
    if (!fresh || isTerminal(fresh.status)) continue;
    const waitedMin = Math.round((now - Date.parse(fresh.updatedAt)) / 60000);
    await store.updateSnapshot(row.id, {
      status: 'failed',
      error: `Abandoned after ${waitedMin} min in "${fresh.status}" — the process running this snapshot stopped responding. Re-run to try again.`,
    });
    ids.push(row.id);
    log.warn({ snapshotId: row.id, repo: row.repo, status: fresh.status, waitedMin }, 'reaped stranded snapshot');
  }
  if (ids.length) log.info({ swept: ids.length }, 'stale snapshot reaper');
  return { swept: ids.length, ids };
}

/**
 * Delete terminal snapshots older than the retention window.
 *
 * The in-memory caches were bounded, but Postgres was not: without this every
 * snapshot anyone ever requested accumulates forever. Only rows in a terminal
 * status are eligible, so a snapshot a worker is still writing to is never
 * deleted out from under it.
 */
export async function pruneOldSnapshots(now = Date.now()): Promise<number> {
  const store = getStore();
  const days = Number(process.env.TM_SNAPSHOT_RETENTION_DAYS || 90);
  if (days <= 0) return 0; // retention disabled
  const cutoff = new Date(now - days * 86400_000).toISOString();
  const n = await store.pruneTerminal(cutoff);
  if (n > 0) log.info({ pruned: n, olderThanDays: days }, 'pruned old snapshots');
  return n;
}

const globalForReaper = globalThis as unknown as { __tmReaper?: NodeJS.Timeout };

/**
 * Start the periodic sweep. Idempotent, and the timer is unref'd so it never
 * holds the process open. Called from wherever jobs are wired — the Next server
 * when running in-process, or the standalone worker.
 */
export function startReaper(): void {
  if (globalForReaper.__tmReaper) return;
  const t = setInterval(() => {
    reapStaleSnapshots()
      .then(() => pruneOldSnapshots())
      .catch((e) => log.error({ err: (e as Error).message }, 'reaper sweep failed'));
  }, SWEEP_MS);
  t.unref();
  globalForReaper.__tmReaper = t;
  log.info({ staleMs: STALE_MS, everyMs: SWEEP_MS, retentionDays: Number(process.env.TM_SNAPSHOT_RETENTION_DAYS || 90) }, 'stale snapshot reaper started');
}