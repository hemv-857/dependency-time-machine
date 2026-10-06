import { describe, expect, it } from 'vitest';
import { resolveCommit, GhClientLike } from '@/core/git/resolve';
import { buildTimeline, nearestPointIndex } from '@/core/timeline';
import { buildStory } from '@/core/changelog/story';
import { LockDiff, ReleaseInfo } from '@/core/types';

const repo = {
  full_name: 'demo/demo',
  html_url: 'https://github.com/demo/demo',
  default_branch: 'main',
  created_at: '2020-01-01T00:00:00Z',
  private: false,
};

function makeGh(commits: { sha: string; date: string }[]): GhClientLike {
  return {
    async repo() {
      return repo;
    },
    async commitsUntil(_f, iso) {
      return commits
        .filter((c) => Date.parse(c.date) <= Date.parse(iso))
        .slice(-1)
        .map((c) => ({ sha: c.sha, committedDate: c.date, message: 'm' }));
    },
    async latestCommit() {
      const c = commits[commits.length - 1];
      return { sha: c.sha, committedDate: c.date, message: 'm' };
    },
    async commit(_f, ref) {
      const c = commits.find((x) => x.sha === ref) || commits[0];
      return { sha: c.sha, committedDate: c.date, message: 'm' };
    },
    async releases() {
      return [];
    },
  };
}

describe('resolveCommit (date → commit)', () => {
  const commits = [
    { sha: 'aaa', date: '2023-01-10T00:00:00Z' },
    { sha: 'bbb', date: '2023-06-15T00:00:00Z' },
    { sha: 'ccc', date: '2024-02-01T00:00:00Z' },
  ];

  it('picks the last commit on/before the date', async () => {
    const r = await resolveCommit(makeGh(commits), 'demo/demo', { dateIso: '2023-07-01T00:00:00Z' });
    expect(r.sha).toBe('bbb');
    expect(r.refUsed).toBeNull();
  });

  it('explicit ref wins over date', async () => {
    const r = await resolveCommit(makeGh(commits), 'demo/demo', { ref: 'ccc', dateIso: '2023-01-01T00:00:00Z' });
    expect(r.sha).toBe('ccc');
  });

  it('friendly error when history starts after the date', async () => {
    await expect(resolveCommit(makeGh(commits), 'demo/demo', { dateIso: '2019-01-01T00:00:00Z' })).rejects.toThrow(
      /No commits before/
    );
  });
});

describe('timeline', () => {
  const releases: ReleaseInfo[] = [
    { tag: 'v2.0.0', name: 'Two', date: '2024-02-01T00:00:00Z', body: '', url: 'u' },
    { tag: 'v1.0.0', name: 'One', date: '2023-01-01T00:00:00Z', body: '', url: 'u' },
  ];
  it('sorts ascending and includes repo creation', () => {
    const t = buildTimeline(releases, '2022-06-01T00:00:00Z');
    expect(t.map((p) => p.date.slice(0, 10))).toEqual(['2022-06-01', '2023-01-01', '2024-02-01']);
  });
  it('finds nearest point index', () => {
    const t = buildTimeline(releases);
    expect(nearestPointIndex(t, '2023-06-01T00:00:00Z')).toBe(0);
  });
});

describe('buildStory', () => {
  const diff: LockDiff = {
    changes: [
      { name: 'react', from: '17.0.2', to: '18.2.0', kind: 'major' },
      { name: 'lodash', from: '4.17.15', to: '4.17.21', kind: 'patch' },
    ],
    counts: { major: 1, minor: 0, patch: 1, changed: 0, added: 0, removed: 0, total: 2 },
  };
  const lens = {
    available: true,
    then: [
      { id: 'GHSA-1', aliases: ['CVE-2020-8203'], summary: 'pp', severity: 'HIGH', url: 'u', packages: ['lodash'] },
    ],
    fixed: [{ id: 'GHSA-1', aliases: [], summary: 'pp', severity: 'HIGH', url: 'u', packages: ['lodash'] }],
    stillOpen: [],
  };
  const releases: ReleaseInfo[] = [
    { tag: 'v3.0.0', name: 'The Big One', date: '2023-06-01T00:00:00Z', body: 'Rewrote the whole core in Rust. Blazing fast.', url: 'https://github.com/demo/demo/releases/v3' },
  ];

  it('produces headline with counts and CVE count', () => {
    const s = buildStory({
      repoFullName: 'demo/demo',
      repoUrl: 'https://github.com/demo/demo',
      thenIso: '2023-01-01T00:00:00Z',
      diff,
      lens,
      releases,
      npmDocs: { react: { time: { '18.2.0': '2022-06-14T00:00:00Z' }, repository: { url: 'github.com/facebook/react' } } },
    });
    expect(s.headline).toContain('1 major');
    expect(s.headline).toContain('1 patch');
    expect(s.headline).toContain('1 CVE');
    const majorCard = s.cards.find((c) => c.kind === 'major')!;
    expect(majorCard.title).toBe('react 17.0.2 → 18.2.0');
    expect(majorCard.links.some((l) => l.href.includes('github.com/facebook/react'))).toBe(true);
    expect(s.cards.some((c) => c.kind === 'security')).toBe(true);
    const relCard = s.cards.find((c) => c.kind === 'release')!;
    expect(relCard.body).toContain('Rewrote the whole core');
  });
});
