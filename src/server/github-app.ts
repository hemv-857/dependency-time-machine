import { createSign } from 'node:crypto';

/**
 * GitHub App authentication for private repositories.
 *
 * A personal GITHUB_TOKEN can read whatever that one user can read, which is the
 * wrong trust boundary for a service that builds code: it would inherit access to
 * every private repo the operator happens to have open. A GitHub App is scoped to
 * the repositories it is explicitly installed on, and GitHub enforces that — our
 * authorization gate is simply "is there an installation for this repo".
 *
 * Flow: app private key -> short-lived JWT (max 10 min) -> installation access
 * token (1 h) -> normal API calls as that installation.
 *
 * ponytail: JWT signing and the two calls are all this needs; no SDK.
 */

const APP_ID = () => process.env.GITHUB_APP_ID || '';
const INSTALLATION_ID = () => process.env.GITHUB_APP_INSTALLATION_ID || '';

function apiBase(): string {
  return (process.env.TM_GITHUB_API_BASE || 'https://api.github.com').replace(/\/$/, '');
}

/** Private key: PEM contents, or a path to it. Never logged, never persisted. */
function privateKey(): string | null {
  const raw = process.env.GITHUB_APP_PRIVATE_KEY || '';
  if (!raw) return null;
  if (raw.includes('BEGIN') && raw.includes('PRIVATE KEY')) return raw.replace(/\\n/g, '\n');
  const p = raw.startsWith('~') ? raw.replace('~', process.env.HOME || '') : raw;
  try {
    // lazy require so this file never pulls fs into the client bundle
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('node:fs').readFileSync(p, 'utf8') as string;
  } catch {
    return null;
  }
}

export function appConfigured(): boolean {
  return !!APP_ID() && !!privateKey();
}

/** Base64url without padding, per RFC 7515. */
function b64u(input: string | Buffer): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Mint an app JWT. GitHub requires exp <= iat + 10 minutes; we use 9 to stay
 * clear of clock skew.
 */
export function appJwt(now = Math.floor(Date.now() / 1000)): string {
  const id = APP_ID();
  const key = privateKey();
  if (!id || !key) throw new Error('GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required for App auth');
  const header = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64u(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: id }));
  const signingInput = `${header}.${payload}`;
  // .sign() returns the signature buffer — .end().toString() would stringify
  // the Sign stream object instead and produce a JWT GitHub rejects
  const sig = createSign('RSA-SHA256').update(signingInput).sign(key);
  return `${signingInput}.${b64u(sig)}`;
}

interface CachedToken {
  token: string;
  exp: number;
}
// short-lived by design: an installation token is a bearer credential, so it is
// held in process memory only and dropped well before GitHub expires it
const cache = new Map<string, CachedToken>();
const TOKEN_TTL_MS = 50 * 60 * 1000;

async function api(path: string, init: { method?: string; body?: unknown; auth: string }): Promise<any> {
  const res = await fetch(`${apiBase()}${path}`, {
    method: init.method || 'GET',
    headers: {
      Authorization: `Bearer ${init.auth}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'dependency-time-machine/0.1',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub App API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

export type AppAuthOutcome =
  | { kind: 'token'; token: string }
  | { kind: 'not-installed'; owner: string; repo: string }
  | { kind: 'unavailable' };

/**
 * Resolve a bearer token able to read `owner/repo`.
 *
 * Prefers the App installation, but honours GITHUB_APP_INSTALLATION_ID for
 * single-installation setups so the /repos/.../installation lookup can be skipped.
 */
export async function tokenForRepo(owner: string, repo: string): Promise<AppAuthOutcome> {
  if (!appConfigured()) return { kind: 'unavailable' };

  const key = `${owner}/${repo}`;
  const hit = cache.get(key);
  if (hit && Date.now() < hit.exp) return { kind: 'token', token: hit.token };

  try {
    const jwt = appJwt();
    let installationId = INSTALLATION_ID();
    if (!installationId) {
      const inst = await api(`/repos/${owner}/${repo}/installation`, { auth: jwt });
      if (!inst) return { kind: 'not-installed', owner, repo };
      installationId = String(inst.id);
    }
    const minted = await api(`/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      auth: jwt,
      body: { repository_names: [repo] },
    });
    if (!minted?.token) return { kind: 'not-installed', owner, repo };
    cache.set(key, { token: minted.token, exp: Date.now() + TOKEN_TTL_MS });
    return { kind: 'token', token: minted.token };
  } catch {
    // an expired/revoked key or a transient failure must not take down public
    // snapshots; the caller falls back to the plain token
    return { kind: 'unavailable' };
  }
}

/** Forget cached tokens — call on credential rotation or after a 401. */
export function clearTokenCache(): void {
  cache.clear();
}
