import { createWriteStream } from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { GhCommit, GhRepo, NotFoundError, RateLimitError } from '@/core/git/resolve';
import { ReleaseInfo } from '@/core/types';
import { TtlCache } from './ttl-cache';

function base(): string {
  return (process.env.TM_GITHUB_API_BASE || 'https://api.github.com').replace(/\/$/, '');
}

const JSON_TTL_MS = 10 * 60 * 1000;

/**
 * Thin GitHub REST client with in-memory JSON caching, rate-limit awareness and
 * a configurable API base (for self-hosting and hermetic tests).
 */
export class GhClient {
  private cache = new TtlCache<unknown>(JSON_TTL_MS, 2000);
  remaining: number | null = null;
  resetAt: string | null = null;

  private async req(path: string, opts: { raw?: boolean; ttlMs?: number } = {}): Promise<Response> {
    const url = path.startsWith('http') ? path : `${base()}${path}`;
    const headers: Record<string, string> = {
      Accept: opts.raw ? 'application/vnd.github+json' : 'application/vnd.github+json',
      'User-Agent': 'dependency-time-machine/0.1',
    };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(30_000) });
    const rem = res.headers.get('x-ratelimit-remaining');
    if (rem !== null) this.remaining = Number(rem);
    const rst = res.headers.get('x-ratelimit-reset');
    if (rst) this.resetAt = new Date(Number(rst) * 1000).toISOString();
    if (res.status === 403 || res.status === 429) {
      const isRate = res.headers.get('x-ratelimit-remaining') === '0';
      if (isRate) {
        throw new RateLimitError(
          'GitHub API rate limit exceeded. Set GITHUB_TOKEN to raise the limit.',
          this.resetAt || new Date(Date.now() + 3600_000).toISOString()
        );
      }
    }
    if (res.status === 404) throw new NotFoundError(`GitHub returned 404 for ${path}`);
    if (!res.ok) throw new Error(`GitHub API ${res.status} for ${path}`);
    return res;
  }

  private async json<T>(path: string, ttlMs = JSON_TTL_MS): Promise<T> {
    const hit = this.cache.get(path);
    if (hit) return hit as T;
    const res = await this.req(path);
    const data = (await res.json()) as T;
    this.cache.set(path, data, ttlMs);
    return data;
  }

  async repo(fullName: string): Promise<GhRepo> {
    const r = await this.json<any>(`/repos/${fullName}`, 5 * 60_000);
    return {
      full_name: r.full_name,
      html_url: r.html_url,
      default_branch: r.default_branch || 'main',
      created_at: r.created_at,
      private: !!r.private,
      description: r.description,
      pushed_at: r.pushed_at,
    };
  }

  async commitsUntil(fullName: string, iso: string): Promise<GhCommit[]> {
    const path = `/repos/${fullName}/commits?until=${encodeURIComponent(iso)}&per_page=1`;
    const r = await this.json<any[]>(path, 60_000);
    return r.map(mapCommit);
  }

  async latestCommit(fullName: string): Promise<GhCommit> {
    const r = await this.json<any[]>(`/repos/${fullName}/commits?per_page=1`, 2 * 60_000);
    if (!r.length) throw new NotFoundError(`${fullName} has no commits`);
    return mapCommit(r[0]);
  }

  async commit(fullName: string, ref: string): Promise<GhCommit> {
    const r = await this.json<any>(`/repos/${fullName}/commits/${encodeURIComponent(ref)}`, 10 * 60_000);
    return mapCommit(r);
  }

  async releases(fullName: string): Promise<ReleaseInfo[]> {
    const r = await this.json<any[]>(`/repos/${fullName}/releases?per_page=100`, 10 * 60_000);
    return (Array.isArray(r) ? r : []).slice(0, 100).map((x) => ({
      tag: x.tag_name || '',
      name: x.name || '',
      date: x.published_at || x.created_at || '',
      body: typeof x.body === 'string' ? x.body : '',
      url: x.html_url || `https://github.com/${fullName}/releases`,
    }));
  }

  async tags(fullName: string): Promise<string[]> {
    const r = await this.json<any[]>(`/repos/${fullName}/tags?per_page=100`, 10 * 60_000);
    return (Array.isArray(r) ? r : []).map((t) => t.name).filter(Boolean);
  }

  /** Stream a repo tarball to `dest`. See downloadToFile for why not global fetch. */
  async tarball(fullName: string, sha: string, dest: string): Promise<void> {
    await downloadToFile(`${base()}/repos/${fullName}/tarball/${encodeURIComponent(sha)}`, dest, (headers) => {
      const rem = headers['x-ratelimit-remaining'];
      if (rem !== undefined) this.remaining = Number(rem);
      const rst = headers['x-ratelimit-reset'];
      if (rst) this.resetAt = new Date(Number(rst) * 1000).toISOString();
    });
  }
}

const MAX_TARBALL_BYTES = 300 * 1024 * 1024;

/**
 * Download `url` straight to `dest`, following redirects, with a size cap.
 *
 * Deliberately not the global `fetch`: Next.js replaces global fetch with a
 * patched/deduped wrapper, and that wrapper never settles when an AbortSignal
 * races a cross-origin redirect. GitHub's /tarball/ endpoint 302s to
 * codeload.github.com, so every real download hung for the full 30s abort and
 * then threw "The operation was aborted due to timeout" — the pipeline could
 * not fetch a single repo. node:https is not patched, and streaming keeps a
 * 300MB tarball off the heap.
 */
async function downloadToFile(
  url: string,
  dest: string,
  onHeaders?: (h: http.IncomingHttpHeaders) => void,
  redirectsLeft = 5
): Promise<void> {
  const u = new URL(url);
  const get = u.protocol === 'http:' ? http.get : https.get;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'dependency-time-machine/0.1',
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  await new Promise<void>((resolve, reject) => {
    const req = get(u, { headers }, (res) => {
      const status = res.statusCode || 0;
      const loc = res.headers.location;
      if (status >= 300 && status < 400 && loc) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
        downloadToFile(new URL(loc, u).toString(), dest, onHeaders, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (status === 404) {
        res.resume();
        return reject(new NotFoundError(`GitHub returned 404 for ${u.pathname}`));
      }
      if (status === 403 || status === 429) {
        res.resume();
        return reject(
          new RateLimitError(
            'GitHub API rate limit exceeded. Set GITHUB_TOKEN to raise the limit.',
            new Date(Date.now() + 3600_000).toISOString()
          )
        );
      }
      if (status < 200 || status >= 300) {
        res.resume();
        return reject(new Error(`GitHub API ${status} for ${u.pathname}`));
      }
      onHeaders?.(res.headers);
      let seen = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          seen += chunk.length;
          if (seen > MAX_TARBALL_BYTES) return cb(new Error('Repository tarball exceeds 300MB limit'));
          cb(null, chunk);
        },
      });
      pipeline(res, meter, createWriteStream(dest)).then(() => resolve(), reject);
    });
    req.on('error', reject);
    req.setTimeout(120_000, () => req.destroy(new Error('tarball download timed out')));
  });
}

function mapCommit(c: any): GhCommit {
  return {
    sha: c.sha,
    committedDate: c.commit?.committer?.date || c.commit?.author?.date || c.commit?.committer?.date,
    message: c.commit?.message || '',
    htmlUrl: c.html_url,
  };
}

const globalForGh = globalThis as unknown as { __tmGh?: GhClient };
export function ghClient(): GhClient {
  if (!globalForGh.__tmGh) globalForGh.__tmGh = new GhClient();
  return globalForGh.__tmGh;
}
