import { describe, expect, it, beforeEach } from 'vitest';
import { packageReleaseNotes } from '@/server/pkg-notes';
import type { GhClient } from '@/server/github';
import type { ReleaseInfo } from '@/core/types';

/**
 * Real release notes replace the repeated "Major release. Check the release
 * notes…" boilerplate. Matching has to be right or the wrong notes get quoted.
 */
function rel(tag: string, date: string, body: string): ReleaseInfo {
  return { tag, name: tag, date, body, url: `https://github.com/o/r/releases/tag/${tag}` };
}

function fakeGh(releases: ReleaseInfo[], fail = false): GhClient {
  return {
    releases: async () => {
      if (fail) throw new Error('releases unavailable');
      return releases;
    },
  } as unknown as GhClient;
}

const NOTES = [
  '### Breaking',
  '- dropped Node 14',
  '- the `parse` export moved to `parseAsync`',
  '',
  'See the [migration guide](https://example.com) for details.',
].join('\n');

describe('packageReleaseNotes', () => {
  beforeEach(() => {
    // the notes cache is module-level; use distinct repo slugs per test instead
  });

  it('quotes the release that shipped the exact target version', async () => {
    const gh = fakeGh([
      rel('v2.0.0', '2023-05-01', NOTES),
      rel('v1.9.0', '2023-01-01', 'older stuff that is long enough to pass the length gate'),
    ]);
    const n = await packageReleaseNotes(gh, 'exact-match/repo', '1.9.0', '2.0.0');
    expect(n?.tag).toBe('v2.0.0');
    expect(n?.summary).toContain('dropped Node 14');
    expect(n?.url).toContain('/releases/tag/v2.0.0');
  });

  it('strips markdown noise but keeps the substance', async () => {
    const gh = fakeGh([rel('v3.1.0', '2023-06-01', NOTES)]);
    const n = await packageReleaseNotes(gh, 'clean/slugs', '3.0.0', '3.1.0');
    expect(n!.summary).not.toContain('###');
    expect(n!.summary).not.toContain('[');
    expect(n!.summary).toContain('migration guide');
    expect(n!.summary).toContain('•');
  });

  it('handles non-v tags like release-4.2.0', async () => {
    const gh = fakeGh([rel('release-4.2.0', '2023-04-01', NOTES)]);
    const n = await packageReleaseNotes(gh, 'weird/tags', '4.1.0', '4.2.0');
    expect(n?.tag).toBe('release-4.2.0');
  });

  it('falls back to the earliest release inside the range when no tag matches', async () => {
    // no release is tagged 2.2.0, so the exact-match path cannot fire
    const gh = fakeGh([
      rel('v2.3.0', '2023-08-01', NOTES),
      rel('v2.1.0', '2023-06-01', 'the one that actually landed the jump, with enough words to use'),
    ]);
    const n = await packageReleaseNotes(gh, 'fallback/range', '2.0.0', '2.2.0');
    expect(n?.tag).toBe('v2.1.0');
  });

  it('excludes releases past the target version', async () => {
    const gh = fakeGh([
      rel('v9.0.0', '2024-01-01', NOTES),
      rel('v2.1.0', '2023-06-01', 'inside the range and definitely long enough to be used'),
    ]);
    const n = await packageReleaseNotes(gh, 'excludes/future', '2.0.0', '2.2.0');
    expect(n?.tag).toBe('v2.1.0');
  });

  it('returns null rather than quoting something useless', async () => {
    // no releases at all
    expect(await packageReleaseNotes(fakeGh([]), 'empty/repo', '1.0.0', '2.0.0')).toBeNull();
    // a release whose body is just a version string
    const thin = fakeGh([rel('v2.0.0', '2023-01-01', 'v2.0.0')]);
    expect(await packageReleaseNotes(thin, 'thin/body', '1.0.0', '2.0.0')).toBeNull();
    // no release inside the range
    const outside = fakeGh([rel('v0.1.0', '2020-01-01', NOTES)]);
    expect(await packageReleaseNotes(outside, 'outside/range', '5.0.0', '6.0.0')).toBeNull();
  });

  it('degrades quietly when the package repo cannot be read', async () => {
    expect(await packageReleaseNotes(fakeGh([], true), 'broken/repo', '1.0.0', '2.0.0')).toBeNull();
  });

  it('truncates very long notes', async () => {
    const gh = fakeGh([rel('v2.0.0', '2023-05-01', 'x '.repeat(2000))]);
    const n = await packageReleaseNotes(gh, 'long/notes', '1.0.0', '2.0.0');
    expect(n!.summary.length).toBeLessThanOrEqual(400);
  });

  it('caches per repo so one snapshot does not refetch', async () => {
    let calls = 0;
    const gh = {
      releases: async () => {
        calls++;
        return [rel('v2.0.0', '2023-05-01', NOTES)];
      },
    } as unknown as GhClient;
    await packageReleaseNotes(gh, 'cached/repo', '1.0.0', '2.0.0');
    await packageReleaseNotes(gh, 'cached/repo', '1.0.0', '2.0.0');
    expect(calls).toBe(1);
  });
});