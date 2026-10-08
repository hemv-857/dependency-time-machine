import { NpmDocLite } from '@/core/changelog/story';
import { withRetry } from './retry';

function base(): string {
  return (process.env.TM_NPM_REGISTRY_BASE || 'https://registry.npmjs.org').replace(/\/$/, '');
}

const cache = new Map<string, { at: number; doc: NpmDocLite | null }>();
const TTL = 60 * 60 * 1000;

/**
 * npm registry lookup for changelog links.
 *
 * Uses `/<name>/latest` rather than the packument: the abbreviated packument
 * (`application/vnd.npm.install-v1+json`) is what this originally requested, and
 * it turns out to carry neither `repository` nor `time` — so the repository slug
 * was always null and no release notes could ever be resolved. The full
 * packument would fix `time` but is ~380KB for a mid-size package, and the
 * release date from the package's own GitHub release is a better date anyway.
 * `/latest` is ~2KB.
 */
export async function npmDoc(name: string): Promise<NpmDocLite | null> {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < TTL) return hit.doc;
  let doc: NpmDocLite | null = null;
  try {
    const res = await withRetry(
      () =>
        fetch(`${base()}/${encodeURIComponent(name)}/latest`, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(6_000),
        }),
      // a 404 just means no metadata; retrying that would be pointless
      { attempts: 2, retryable: (e) => !(e as Error)?.message?.includes(' 404') }
    );
    if (res.ok) {
      const j = (await res.json()) as { repository?: unknown; version?: string };
      doc = { repository: j.repository as NpmDocLite['repository'], ownVersion: j.version };
    }
  } catch {
    doc = null;
  }
  cache.set(name, { at: Date.now(), doc });
  return doc;
}
