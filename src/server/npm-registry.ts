import { NpmDocLite } from '@/core/changelog/story';
import { withRetry } from './retry';

function base(): string {
  return (process.env.TM_NPM_REGISTRY_BASE || 'https://registry.npmjs.org').replace(/\/$/, '');
}

const cache = new Map<string, { at: number; doc: NpmDocLite | null }>();
const TTL = 60 * 60 * 1000;

/** npm registry doc (publish dates + repo url) for changelog links. Null on any failure. */
export async function npmDoc(name: string): Promise<NpmDocLite | null> {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < TTL) return hit.doc;
  let doc: NpmDocLite | null = null;
  try {
    const res = await withRetry(
      () =>
        fetch(`${base()}/${encodeURIComponent(name)}`, {
          headers: { Accept: 'application/vnd.npm.install-v1+json, application/json' },
          signal: AbortSignal.timeout(6_000),
        }),
      // a 404 just means no metadata; retrying that would be pointless
      { attempts: 2, retryable: (e) => !(e as Error)?.message?.includes(' 404') }
    );
    if (res.ok) {
      const j: any = await res.json();
      doc = { repository: j.repository, time: j.time };
    }
  } catch {
    doc = null;
  }
  cache.set(name, { at: Date.now(), doc });
  return doc;
}
