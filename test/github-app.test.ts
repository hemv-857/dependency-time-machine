import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, createVerify, createPublicKey } from 'node:crypto';
import http from 'node:http';

/**
 * GitHub App auth, verified without real credentials: generate an RSA keypair,
 * assert the minted JWT verifies against its public key with the right claims,
 * and drive the installation-token exchange against a stub API.
 */
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

function b64u(input: string | Buffer): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function verifyJwt(jwt: string) {
  const [h, p, s] = jwt.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  const ok = createVerify('RSA-SHA256')
    .update(`${h}.${p}`)
    .verify(createPublicKey(publicKey), Buffer.from(s, 'base64url'));
  return { header, payload, signatureValid: ok };
}

const ENV_KEYS = ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_INSTALLATION_ID', 'TM_GITHUB_API_BASE'] as const;

describe('GitHub App auth', () => {
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.GITHUB_APP_ID = '424242';
    process.env.GITHUB_APP_PRIVATE_KEY = privateKey;
    process.env.GITHUB_APP_INSTALLATION_ID = '';
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  it('reports unconfigured when no key is present', async () => {
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    const { appConfigured, tokenForRepo } = await import('@/server/github-app');
    expect(appConfigured()).toBe(false);
    expect(await tokenForRepo('o', 'r')).toEqual({ kind: 'unavailable' });
  });

  it('signs a verifiable RS256 JWT with the app id and a <=10min expiry', async () => {
    const { appConfigured, appJwt } = await import('@/server/github-app');
    expect(appConfigured()).toBe(true);

    const now = 1_800_000_000;
    const jwt = appJwt(now);
    const { header, payload, signatureValid } = verifyJwt(jwt);

    expect(signatureValid).toBe(true);
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(payload.iss).toBe('424242');
    // GitHub rejects exp > iat + 600
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);
    // and a token minted now must not already look expired to GitHub
    expect(payload.iat).toBeLessThanOrEqual(now);
  });

  it('produces a different token each time (unique iat/jti window)', async () => {
    const { appJwt } = await import('@/server/github-app');
    expect(appJwt(1_800_000_000)).not.toBe(appJwt(1_800_000_000 + 5));
  });

  it('rejects a tampered token', async () => {
    const { appJwt } = await import('@/server/github-app');
    const jwt = appJwt(1_800_000_000);
    const [h, p, s] = jwt.split('.');
    const forged = `${h}.${b64u(JSON.stringify({ iss: '1', exp: 9_999_999_999, iat: 1 }))}.${s}`;
    expect(verifyJwt(forged).signatureValid).toBe(false);
  });

  it('exchanges a JWT for an installation token scoped to the repo', async () => {
    const seen: { url: string; auth: string; body?: any }[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({
          url: req.url || '',
          auth: String(req.headers.authorization || ''),
          body: body ? JSON.parse(body) : undefined,
        });
        if (req.url === '/app/installations/999/access_tokens') {
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ token: 'ghs_installationtoken', expires_at: '2099-01-01T00:00:00Z' }));
          return;
        }
        res.writeHead(404).end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as any).port;
    process.env.TM_GITHUB_API_BASE = `http://127.0.0.1:${port}`;

    const { tokenForRepo, clearTokenCache } = await import('@/server/github-app');
    clearTokenCache();
    process.env.GITHUB_APP_INSTALLATION_ID = '999';

    const out = await tokenForRepo('acme', 'secret');
    expect(out).toEqual({ kind: 'token', token: 'ghs_installationtoken' });

    const mint = seen.find((s) => s.url.includes('/access_tokens'))!;
    // the JWT authenticates the App, and the request is scoped to one repo
    expect(mint.auth.startsWith('Bearer ')).toBe(true);
    expect(verifyJwt(mint.auth.slice(7)).signatureValid).toBe(true);
    expect(mint.body).toEqual({ repository_names: ['secret'] });

    // second call is served from cache, so no second mint
    const before = seen.length;
    expect(await tokenForRepo('acme', 'secret')).toEqual({ kind: 'token', token: 'ghs_installationtoken' });
    expect(seen.length).toBe(before);

    server.close();
    clearTokenCache();
  });

  it('looks up the installation when no id is configured, and reports not-installed', async () => {
    const urls: string[] = [];
    const server = http.createServer((req, res) => {
      urls.push(req.url || '');
      // GitHub 404s this when the App is not installed on the repo
      res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"message":"Not Found"}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as any).port;
    process.env.TM_GITHUB_API_BASE = `http://127.0.0.1:${port}`;

    const { tokenForRepo, clearTokenCache } = await import('@/server/github-app');
    clearTokenCache();

    expect(await tokenForRepo('acme', 'private-thing')).toEqual({
      kind: 'not-installed',
      owner: 'acme',
      repo: 'private-thing',
    });
    expect(urls[0]).toBe('/repos/acme/private-thing/installation');

    server.close();
  });

  it('degrades to unavailable instead of throwing when the App API is down', async () => {
    const server = http.createServer((_req, res) => res.writeHead(500).end('boom'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as any).port;
    process.env.TM_GITHUB_API_BASE = `http://127.0.0.1:${port}`;
    process.env.GITHUB_APP_INSTALLATION_ID = '999';

    const { tokenForRepo, clearTokenCache } = await import('@/server/github-app');
    clearTokenCache();
    // must not take down public snapshots — the caller falls back to GITHUB_TOKEN
    expect(await tokenForRepo('acme', 'r')).toEqual({ kind: 'unavailable' });

    server.close();
    clearTokenCache();
  });

  it('refuses to mint without credentials', async () => {
    delete process.env.GITHUB_APP_ID;
    const { appJwt } = await import('@/server/github-app');
    expect(() => appJwt()).toThrow(/GITHUB_APP_ID/);
  });
});
