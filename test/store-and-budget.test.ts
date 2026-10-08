import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStore, nowIso, type SnapshotRow } from '@/server/store';

/** New store surface: listing, counting, repo+date lookup, and pruning. */

function row(over: Partial<SnapshotRow> = {}): SnapshotRow {
  return {
    id: 'x', owner: 'o', name: 'r', repo: 'o/r', dateIso: '2023-06-01T00:00:00.000Z', ref: null,
    commitSha: 'a'.repeat(40), commitDate: '2023-04-27T00:00:00.000Z', headSha: null,
    status: 'ready', previewMode: 'iframe', projectType: 'node', ecosystem: 'npm',
    toolchain: null, error: null, metadata: null, diff: null, advisories: null, story: null,
    timeline: null, readmeMd: null, installSnippet: null, testLog: null, buildLog: null,
    stages: [], buildMs: null, createdAt: nowIso(), updatedAt: nowIso(),
    ...over,
  };
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

const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();

describe('store listing and lookup', () => {
  it('lists newest first', async () => {
    await withStore(async (s) => {
      await s.createSnapshot(row({ id: 'old', repo: 'o/old', createdAt: daysAgo(5) }));
      await s.createSnapshot(row({ id: 'new', repo: 'o/new', createdAt: daysAgo(1) }));
      const all = await s.list({});
      expect(all.map((r) => r.id)).toEqual(['new', 'old']);
    });
  });

  it('paginates', async () => {
    await withStore(async (s) => {
      for (let i = 0; i < 5; i++) await s.createSnapshot(row({ id: `i${i}`, createdAt: daysAgo(i) }));
      expect((await s.list({ limit: 2 })).map((r) => r.id)).toEqual(['i0', 'i1']);
      expect((await s.list({ limit: 2, offset: 2 })).map((r) => r.id)).toEqual(['i2', 'i3']);
    });
  });

  it('filters by repo, status and a case-insensitive substring', async () => {
    await withStore(async (s) => {
      await s.createSnapshot(row({ id: 'a', repo: 'facebook/react', status: 'ready' }));
      await s.createSnapshot(row({ id: 'b', repo: 'axios/axios', status: 'degraded' }));
      expect((await s.list({ repo: 'axios/axios' })).map((r) => r.id)).toEqual(['b']);
      expect((await s.list({ status: 'ready' })).map((r) => r.id)).toEqual(['a']);
      expect((await s.list({ q: 'AXIOS' })).map((r) => r.id)).toEqual(['b']);
      expect(await s.count({})).toBe(2);
      expect(await s.count({ status: 'ready' })).toBe(1);
      expect(await s.count({ q: 'nothing' })).toBe(0);
    });
  });

  it('finds by repo + date prefix without a GitHub call', async () => {
    await withStore(async (s) => {
      await s.createSnapshot(row({ id: 'a', repo: 'o/r', dateIso: '2023-06-01T00:00:00.000Z' }));
      await s.createSnapshot(row({ id: 'b', repo: 'o/r', dateIso: '2024-01-05T00:00:00.000Z' }));
      await s.createSnapshot(row({ id: 'c', repo: 'other/r', dateIso: '2023-06-01T00:00:00.000Z' }));

      expect((await s.findByRepoDate('o/r', '2023-06-01'))?.id).toBe('a');
      expect((await s.findByRepoDate('o/r', '2024-01'))?.id).toBe('b');
      expect(await s.findByRepoDate('o/r', '2019-01-01')).toBeNull();
      // repo must match exactly — a different repo on the same date is not a hit
      expect(await s.findByRepoDate('o/r', '2023-06-01')).not.toBeNull();
      expect(await s.findByRepoDate('o/r/', '2023-06-01')).toBeNull();
    });
  });
});

describe('snapshot retention', () => {
  it('deletes only old terminal rows', async () => {
    await withStore(async (s) => {
      await s.createSnapshot(row({ id: 'old-ready', status: 'ready', updatedAt: daysAgo(200) }));
      await s.createSnapshot(row({ id: 'new-ready', status: 'ready', updatedAt: daysAgo(2) }));
      // in-flight but old: must survive, a worker may still be writing to it
      await s.createSnapshot(row({ id: 'old-building', status: 'building', updatedAt: daysAgo(200) }));
      await s.createSnapshot(row({ id: 'old-failed', status: 'failed', updatedAt: daysAgo(200) }));

      const n = await s.pruneTerminal(daysAgo(90));
      expect(n).toBe(2);
      expect(await s.getSnapshot('old-ready')).toBeNull();
      expect(await s.getSnapshot('old-failed')).toBeNull();
      expect(await s.getSnapshot('new-ready')).not.toBeNull();
      expect(await s.getSnapshot('old-building')).not.toBeNull();
    });
  });

  it('is driven by TM_SNAPSHOT_RETENTION_DAYS and can be disabled', async () => {
    const prev = process.env.TM_SNAPSHOT_RETENTION_DAYS;
    try {
      await withStore(async (s) => {
        const { pruneOldSnapshots } = await import('@/server/reaper');
        await s.createSnapshot(row({ id: 'a', status: 'ready', updatedAt: daysAgo(100) }));

        process.env.TM_SNAPSHOT_RETENTION_DAYS = '30';
        expect(await pruneOldSnapshots()).toBe(1);

        await s.createSnapshot(row({ id: 'b', status: 'ready', updatedAt: daysAgo(100) }));
        process.env.TM_SNAPSHOT_RETENTION_DAYS = '0';
        expect(await pruneOldSnapshots()).toBe(0);
        expect(await s.getSnapshot('b')).not.toBeNull();
      });
    } finally {
      if (prev === undefined) delete process.env.TM_SNAPSHOT_RETENTION_DAYS;
      else process.env.TM_SNAPSHOT_RETENTION_DAYS = prev;
    }
  });
});

describe('github api budget', () => {
  afterEach(() => {
    delete process.env.TM_GITHUB_BUDGET;
    delete process.env.TM_GITHUB_BUDGET_REFILL;
  });
  /** env must be set before the bucket is (re)created — it reads config lazily */
  const arm = async (cap: number, refill: number) => {
    process.env.TM_GITHUB_BUDGET = String(cap);
    process.env.TM_GITHUB_BUDGET_REFILL = String(refill);
    (await import('@/server/gh-budget')).resetBudget();
  };

  it('spends down and then refuses', async () => {
    await arm(3, 1);
    const { takeToken, budgetStatus } = await import('@/server/gh-budget');

    expect([takeToken(), takeToken(), takeToken()]).toEqual([true, true, true]);
    expect(takeToken()).toBe(false);
    const st = budgetStatus();
    expect(st.ok).toBe(false);
    expect(st.cap).toBe(3);
    expect(st.retryAfterSec).toBeGreaterThan(0);
  });

  it('refills over time and never exceeds capacity', async () => {
    await arm(10, 60); // 1 per second
    const { takeToken, budgetStatus } = await import('@/server/gh-budget');

    for (let i = 0; i < 10; i++) expect(takeToken()).toBe(true);
    expect(takeToken()).toBe(false);

    // 3s later, ~3 tokens are back
    const later = Date.now() + 3000;
    expect(budgetStatus(later).remaining).toBeGreaterThanOrEqual(2);

    // an hour of idling must not bank more than the cap
    expect(budgetStatus(Date.now() + 3600_000).remaining).toBe(10);
  });

  it('is consulted by the GitHub client before spending a real call', async () => {
    await arm(1, 0);
    const { GhClient } = await import('@/server/github');
    // point at a dead local port so no real network call happens
    const prevBase = process.env.TM_GITHUB_API_BASE;
    process.env.TM_GITHUB_API_BASE = 'http://127.0.0.1:1';
    try {
      const gh = new GhClient();
      // first call consumes the single token (and fails on the dead port)
      await gh.repo('o/r').catch(() => {});
      // second must be refused by the budget, before any network use at all
      await expect(gh.repo('o/r')).rejects.toThrow(/GitHub API budget/);
    } finally {
      if (prevBase === undefined) delete process.env.TM_GITHUB_API_BASE;
      else process.env.TM_GITHUB_API_BASE = prevBase;
    }
  });
});