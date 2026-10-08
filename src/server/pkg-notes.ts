import { ReleaseInfo } from '@/core/types';
import { GhClient } from './github';
import { childLogger } from './log';

const log = childLogger({ mod: 'pkg-notes' });

/**
 * Real release notes for a dependency bump, from that package's own repository.
 *
 * Without this every major card says the same generic sentence, which tells the
 * reader nothing they could not have inferred from the version number alone. The
 * npm registry doc already carries the package's repo slug, so we can ask that
 * repo for the release covering the jump and quote it.
 *
 * ponytail: best-effort, cached per repo, capped release fetches per snapshot.
 */

const cache = new Map<string, { at: number; releases: ReleaseInfo[] }>();
const CACHE_MS = 60 * 60 * 1000;

/** Normalize a tag to a bare version: v4.17.1, release-4.17.1, 4.17.1 → 4.17.1 */
function tagVersion(tag: string): string | null {
  const m = /(?:^|[^\d])(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$/.exec(tag.trim());
  return m ? m[1] : null;
}

function cmp(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = b.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    return (x as any) < (y as any) ? -1 : 1;
  }
  return 0;
}

export interface PackageNotes {
  /** the release that landed the new version, if the repo published one */
  summary: string;
  tag?: string;
  url?: string;
  date?: string;
}

function clean(md: string, max = 400): string {
  return (md || '')
    .replace(/\r/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^#+\s*.*$/gm, '')          // headings carry no information here
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<\/?[^>]+>/g, '')           // html
    .replace(/^\s*[-*+]\s+/gm, '• ')      // bullets
    .replace(/[*_`>]/g, '')
    .replace(/\n{2,}/g, ' — ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Release notes for the jump `from` → `to` of one package.
 * Returns null when the repo has no matching release or no body worth showing.
 */
export async function packageReleaseNotes(
  gh: GhClient,
  repoSlug: string,
  from: string | undefined,
  to: string
): Promise<PackageNotes | null> {
  let releases = cache.get(repoSlug)?.releases;
  if (!releases) {
    try {
      releases = await gh.releases(repoSlug);
      cache.set(repoSlug, { at: Date.now(), releases });
    } catch (e) {
      log.debug({ repoSlug, err: (e as Error).message }, 'release notes unavailable');
      // negative-cache briefly so one bad repo is not re-fetched for every snapshot
      cache.set(repoSlug, { at: Date.now(), releases: [] });
      return null;
    }
  }

  // the release that shipped `to`; fall back to the newest release after `from`
  let chosen: ReleaseInfo | undefined = releases.find((r) => tagVersion(r.tag) === to);
  if (!chosen && from) {
    chosen = releases
      .filter((r) => {
        const v = tagVersion(r.tag);
        return v && cmp(v, from) > 0 && (!to || cmp(v, to) <= 0);
      })
      .sort((a, b) => Date.parse(a.date) - Date.parse(b.date))[0];
  }

  const body = clean(chosen?.body || '');
  // too short to be notes ("v1.2.3" or a bare link) — better to say nothing
  if (!chosen || body.length < 20) return null;
  return { summary: body, tag: chosen.tag, url: chosen.url, date: chosen.date };
}