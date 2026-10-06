import { beforeEach, describe, expect, it } from 'vitest';
import { memoryStore, nowIso, type SnapshotRow } from '@/server/store';

/**
 * A snapshot whose process died mid-job never runs the pipeline's own catch, so
 * it stays queued/analyzing/building forever and the UI spins indefinitely.
 * The reaper is the only thing that recovers it.
 */

function row(over: Partial<SnapshotRow> = {}): SnapshotRow {
  const base: SnapshotRow = {
    id: 'r1', owner: 'o', name: 'r', repo: 'o/r', dateIso: '2024-01-01T00:00:00.000Z',
    ref: null, commitSha: 'a'.repeat(40), commitDate: '2024-01-01T00:00:00.000Z',
    headSha: null, status: 'building', previewMode: 'none', projectType: null,
    ecosystem: null, toolchain: null, error: null, metadata: null, diff: null,
    advisories: null, story: null, timeline: null, readmeMd: null, installSnippet: null,
    testLog: null, buildLog: null, stages: [], buildMs: null,
    createdAt: nowIso(), updatedAt: nowIso(),
  };
  return { ...base, ...over };
}

function ago(min: number): string {
  return new Date(Date.now() - min * 60_000).toISOString();
}

async function withStore<T>(fn: (s: ReturnType<typeof memoryStore>) => Promise<T>): Promise<T> {
  const store = memoryStore();
  const g = globalThis as unknown as { __tmStore?: unknown };
  const prev = g.__tmStore;
  g.__tmStore = store;
  try {
    return await fn(store);
  } finally {
    if (prev === undefined) delete g.__tmStore;
    else g.__tmStore = prev;
  }
}

describe('stale snapshot reaper', () => {
  beforeEach(() => {
    // reset the interval singleton between tests
    delete (globalThis as unknown as { __tmReaper?: NodeJS.Timeout }).__tmReaper;
  });

  it('fails a snapshot stranded in a non-terminal state', async () => {
    await withStore(async (store) => {
      const { reapStaleSnapshots } = await import('@/server/reaper');
      await store.createSnapshot(row({ status: 'building', updatedAt: ago(60) }));

      const res = await reapStaleSnapshots();
      expect(res.swept).toBe(1);

      const after = await store.getSnapshot('r1');
      expect(after?.status).toBe('failed');
      expect(after?.error).toMatch(/Abandoned after 60 min in "building"/);
      expect(after?.error).toMatch(/Re-run/);
    });
  });

  it.each(['queued', 'analyzing', 'building'] as const)('reaps %s', async (status) => {
    await withStore(async (store) => {
      const { reapStaleSnapshots } = await import('@/server/reaper');
      await store.createSnapshot(row({ id: `s-${status}`, status, updatedAt: ago(30) }));
      expect((await reapStaleSnapshots()).swept).toBe(1);
      expect((await store.getSnapshot(`s-${status}`))?.status).toBe('failed');
    });
  });

  it.each(['ready', 'degraded', 'failed'] as const)('leaves terminal %s alone', async (status) => {
    await withStore(async (store) => {
      const { reapStaleSnapshots } = await import('@/server/reaper');
      await store.createSnapshot(row({ id: `t-${status}`, status, updatedAt: ago(600) }));
      expect((await reapStaleSnapshots()).swept).toBe(0);
      expect((await store.getSnapshot(`t-${status}`))?.status).toBe(status);
    });
  });

  it('does not touch a snapshot that is still being worked on', async () => {
    await withStore(async (store) => {
      const { reapStaleSnapshots } = await import('@/server/reaper');
      await store.createSnapshot(row({ id: 'fresh', status: 'analyzing', updatedAt: ago(2) }));
      expect((await reapStaleSnapshots()).swept).toBe(0);
      expect((await store.getSnapshot('fresh'))?.status).toBe('analyzing');
    });
  });

  it('is idempotent — a second sweep finds nothing left', async () => {
    await withStore(async (store) => {
      const { reapStaleSnapshots } = await import('@/server/reaper');
      await store.createSnapshot(row({ updatedAt: ago(90) }));
      expect((await reapStaleSnapshots()).swept).toBe(1);
      expect((await reapStaleSnapshots()).swept).toBe(0);
    });
  });

  it('leaves the row discoverable so the permalink can re-run it', async () => {
    await withStore(async (store) => {
      const { reapStaleSnapshots } = await import('@/server/reaper');
      await store.createSnapshot(row({ id: 'keep', status: 'building', updatedAt: ago(60) }));
      await reapStaleSnapshots();
      // findSnapshot only matches non-terminal rows, so a reaped row is correctly
      // ignored and the pipeline starts fresh rather than handing back a corpse.
      expect(await store.findSnapshot('o/r', 'a'.repeat(40))).toBeNull();
    });
  });

  it('startReaper only installs one timer', async () => {
    const { startReaper } = await import('@/server/reaper');
    startReaper();
    const first = (globalThis as unknown as { __tmReaper?: NodeJS.Timeout }).__tmReaper;
    startReaper();
    startReaper();
    expect((globalThis as unknown as { __tmReaper?: NodeJS.Timeout }).__tmReaper).toBe(first);
    if (first) clearInterval(first);
  });
});