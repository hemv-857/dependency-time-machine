import { describe, expect, it } from 'vitest';
import { snapshotToMarkdown } from '@/server/markdown';
import { nowIso, type SnapshotRow } from '@/server/store';
import type { LockDiff, SecurityLens, Story } from '@/core/types';

function base(over: Partial<SnapshotRow> = {}): SnapshotRow {
  return {
    id: 's1', owner: 'acme', name: 'widget', repo: 'acme/widget',
    dateIso: '2023-06-01T00:00:00.000Z', ref: null,
    commitSha: 'abcdef1234567890abcdef1234567890abcdef12',
    commitDate: '2023-04-27T00:00:00.000Z', headSha: null,
    status: 'ready', previewMode: 'iframe', projectType: 'node', ecosystem: 'npm',
    toolchain: { node: '20.0.0' }, error: null, metadata: null,
    diff: null, advisories: null, story: null, timeline: null,
    readmeMd: null, installSnippet: null, testLog: null, buildLog: null,
    stages: [], buildMs: 4200, createdAt: nowIso(), updatedAt: nowIso(),
    ...over,
  };
}

const diff: LockDiff = {
  changes: [
    { name: 'minimatch', from: '3.1.2', to: '10.2.5', kind: 'major', advisories: [{ id: 'GHSA-1', severity: 'HIGH', url: 'https://osv.dev/GHSA-1' }] },
    { name: 'left-pad', from: '1.0.0', to: '1.3.0', kind: 'minor' },
    { name: 'gone', from: '1.0.0', kind: 'removed' },
    { name: 'pi|pe', from: '1.0.0', to: '2.0.0', kind: 'patch' },
  ],
  counts: { major: 1, minor: 1, patch: 1, changed: 0, added: 0, removed: 1, total: 4 },
};

const lens: SecurityLens = {
  available: true,
  then: [
    { id: 'GHSA-1', aliases: ['CVE-2020-1'], severity: 'HIGH', url: 'https://osv.dev/GHSA-1', summary: 'ReDoS', packages: ['minimatch'] },
    { id: 'GHSA-2', aliases: [], severity: 'CRITICAL', url: 'https://osv.dev/GHSA-2', packages: ['nanoid'] },
  ],
  fixed: [{ id: 'GHSA-1', aliases: ['CVE-2020-1'], severity: 'HIGH', url: 'https://osv.dev/GHSA-1', summary: 'ReDoS', packages: ['minimatch'] }],
  stillOpen: [{ id: 'GHSA-2', aliases: [], severity: 'CRITICAL', url: 'https://osv.dev/GHSA-2', packages: ['nanoid'] }],
};

const story: Story = {
  headline: 'Since Apr 27, 2023: 1 major — 4 packages touched, 1 CVE fixed since',
  cards: [
    { id: 'c1', kind: 'major', title: '⬆️minimatch 3.1.2 → 10.2.5', body: 'Major release.', links: [{ label: 'npm versions', href: 'https://npmjs.com' }] },
    { id: 'c2', kind: 'security', title: '🔒 1 known vulnerability was open back then — now fixed', body: 'Worst of them: GHSA-1', links: [] },
  ],
};

describe('snapshotToMarkdown', () => {
  it('pins and links the commit', () => {
    const md = snapshotToMarkdown(base());
    expect(md).toContain('# acme/widget @ 2023-06-01');
    expect(md).toContain('`abcdef1234`');
    expect(md).toContain('https://github.com/acme/widget/commit/abcdef1234567890abcdef1234567890abcdef12');
  });

  it('includes the permalink when an origin is supplied', () => {
    expect(snapshotToMarkdown(base(), 'https://tm.dev/')).toContain(
      'https://tm.dev/github.com/acme/widget@2023-06-01'
    );
    // no origin -> no half-built link
    expect(snapshotToMarkdown(base())).not.toContain('Permalink');
  });

  it('renders the dependency table with counts', () => {
    const md = snapshotToMarkdown(base({ diff }));
    expect(md).toContain('**4** packages touched');
    expect(md).toContain('| `minimatch` | 3.1.2 | 10.2.5 | major |');
    expect(md).toContain('[GHSA-1](https://osv.dev/GHSA-1)');
    expect(md).toContain('removed');
  });

  it('escapes pipes so a package name cannot break the table', () => {
    const md = snapshotToMarkdown(base({ diff }));
    expect(md).toContain('`pi\\|pe`');
    expect(md).not.toMatch(/\|\s*`pi\|pe`/);
  });

  it('puts advisory-bearing packages first in the table', () => {
    const md = snapshotToMarkdown(base({ diff }));
    const table = md.slice(md.indexOf('| Package |'), md.indexOf('## Security'));
    expect(table.indexOf('minimatch')).toBeLessThan(table.indexOf('left-pad'));
  });

  it('separates fixed from still-open advisories', () => {
    const md = snapshotToMarkdown(base({ advisories: lens, diff }));
    expect(md).toContain('### Fixed since (1)');
    expect(md).toContain('### Still open (1)');
    expect(md).toContain('**CRITICAL**');
    const fixed = md.slice(md.indexOf('### Fixed since'), md.indexOf('### Still open'));
    expect(fixed).toContain('GHSA-1');
    expect(fixed).not.toContain('GHSA-2');
  });

  it('warns when the snapshot is degraded but still reports the analysis', () => {
    const md = snapshotToMarkdown(base({ status: 'degraded', error: 'build failed', diff, advisories: lens }));
    expect(md).toContain('> [!WARNING]');
    expect(md).toContain('build failed');
    expect(md).toContain('| `minimatch`'); // analysis survives
  });

  it('handles a library with no lockfile', () => {
    const md = snapshotToMarkdown(base({ ecosystem: 'npm', diff: null, previewMode: 'readme' }));
    expect(md).toContain('No lockfile diff available');
    expect(md).toContain('commits no lockfile');
  });

  it('says so when advisory data is unavailable', () => {
    expect(snapshotToMarkdown(base())).toContain('_Advisory data unavailable for this snapshot._');
  });

  it('renders story cards and the release timeline', () => {
    const md = snapshotToMarkdown(base({
      story,
      timeline: [
        { date: '2023-04-27', label: 'v1.4.0', href: 'https://example.com/r' },
        { date: '2024-01-10', label: 'v2.0.0', href: 'https://example.com/r2' },
      ],
    }));
    expect(md).toContain('## Changelog');
    expect(md).toContain('⬆️minimatch 3.1.2 → 10.2.5');
    expect(md).toContain('[npm versions](https://npmjs.com)');
    expect(md).toContain('## Release timeline');
    expect(md).toContain('[v1.4.0](https://example.com/r)');
    expect(md).toContain('[v2.0.0](https://example.com/r2)');
  });

  it('omits the timeline when there is nothing to scrub through', () => {
    expect(snapshotToMarkdown(base({ timeline: [{ date: '2023-04-27', label: 'v1.4.0' }] }))).not.toContain('## Release timeline');
  });

  it('caps very long tables and says how many were dropped', () => {
    const many: LockDiff = {
      changes: Array.from({ length: 260 }, (_, i) => ({ name: `pkg-${i}`, from: '1.0.0', to: '2.0.0', kind: 'major' as const })),
      counts: { major: 260, minor: 0, patch: 0, changed: 0, added: 0, removed: 0, total: 260 },
    };
    const md = snapshotToMarkdown(base({ diff: many }));
    expect(md).toContain('_…and 60 more packages not shown._');
  });

  it('is valid enough to render: no stray blank-line runs, ends with a newline', () => {
    const md = snapshotToMarkdown(base({ diff, advisories: lens, story, installSnippet: 'npm i acme@1' }));
    expect(md).not.toMatch(/\n{3,}/);
    expect(md.endsWith('\n')).toBe(true);
    expect(md).toContain('```sh\nnpm i acme@1\n```');
  });
});