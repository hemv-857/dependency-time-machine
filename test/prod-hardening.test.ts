import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as local from '@/server/builder/local';
import { planBuild } from '@/server/builder/plan';
import { fetchTree } from '@/server/trees';
import * as sandbox from '@/server/sandbox';

/**
 * Regression guard for two defects that made the app unusable / unsafe in prod.
 *
 * 1. Tarball download hung forever inside the Next runtime: Next replaces global
 *    fetch with a wrapper that never settles when an AbortSignal races a
 *    cross-origin redirect. GitHub's /tarball/ 302s to codeload.github.com, so
 *    every real snapshot failed at the `fetch` stage with
 *    "The operation was aborted due to timeout" after 30s. Only observable
 *    against a real (or redirecting) endpoint — unit tests with a local mock
 *    never saw it.
 *
 * 2. The local runner and the preview sandbox executed untrusted repo code on
 *    the host, and fly.toml shipped TM_RUNNER=local, making that the documented
 *    production posture.
 */
describe('tarball download (must not use the Next-patched global fetch)', () => {
  it('streams a tarball through a redirect to disk', async () => {
    // Local http server that 302s, mirroring GitHub -> codeload.
    const http = await import('node:http');
    const { readFileSync } = await import('node:fs');
    const tgz = Buffer.from('fake-tarball-bytes');
    const server = http.createServer((req, res) => {
      if (req.url?.includes('/tarball/')) {
        res.writeHead(302, { location: '/final' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/gzip' });
      res.end(tgz);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as import('node:net').AddressInfo).port;

    const prevBase = process.env.TM_GITHUB_API_BASE;
    process.env.TM_GITHUB_API_BASE = `http://127.0.0.1:${port}`;
    const dir = mkdtempSync(path.join(tmpdir(), 'tm-tarball-'));
    const dest = path.join(dir, 'out.tgz');
    try {
      // Real GhClient path: redirect follow + stream to file, no patched fetch.
      const { GhClient } = await import('@/server/github');
      await new GhClient().tarball('owner/repo', 'deadbeef', dest);
      expect(readFileSync(dest).equals(tgz)).toBe(true);
    } finally {
      if (prevBase === undefined) delete process.env.TM_GITHUB_API_BASE;
      else process.env.TM_GITHUB_API_BASE = prevBase;
      server.close();
    }
  });

  it('fetchTree hands the tarball a file path, not a buffer', async () => {
    // Guards the signature: a buffer return reintroduces the heap-heavy path.
    const got: string[] = [];
    const fake = {
      tarball: async (_f: string, _s: string, dest: string) => {
        got.push(dest);
        const { writeFileSync } = await import('node:fs');
        writeFileSync(dest, Buffer.from('x'));
      },
    };
    const dir = mkdtempSync(path.join(tmpdir(), 'tm-tree-'));
    const prev = process.env.TM_DATA_DIR;
    process.env.TM_DATA_DIR = dir;
    try {
      await fetchTree(fake, 'owner~name-probe', 'deadbeefcafe1234').catch(() => {});
      expect(got[0]).toMatch(/\.tgz$/);
    } finally {
      if (prev === undefined) delete process.env.TM_DATA_DIR;
      else process.env.TM_DATA_DIR = prev;
    }
  });
});

describe('TtlCache stays bounded', () => {
  it('evicts past the cap and expires by ttl', async () => {
    const { TtlCache } = await import('@/server/ttl-cache');
    const c = new TtlCache<string>(60_000, 3);
    c.set('a', 'A');
    c.set('b', 'B');
    c.set('c', 'C');
    expect(c.get('a')).toBe('A');
    expect(c.size).toBe(3);

    // 4th key evicts the oldest insertion
    c.set('d', 'D');
    expect(c.size).toBe(3);
    expect(c.get('a')).toBeUndefined();
    expect(c.get('d')).toBe('D');

    // per-entry ttl override is honoured (this is what the GitHub client relies on)
    c.set('short', 'S', 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(c.get('short')).toBeUndefined();

    // and the default ttl still applies to other keys
    expect(c.get('d')).toBe('D');
  });
});

describe('untrusted code execution is refused in production', () => {
  const manifest = {
    ecosystem: 'npm' as const,
    path: 'package.json',
    dependencies: {},
    scripts: { build: 'node make-dist.js' },
    files: [],
  };
  const plan = planBuild({ type: 'node', manifest, hasLockfile: false })!;

  it('gates on production + explicit opt-in', () => {
    const prevNode = process.env.NODE_ENV;
    const prevAllow = process.env.TM_ALLOW_UNSAFE_LOCAL_EXEC;
    try {
      delete process.env.TM_ALLOW_UNSAFE_LOCAL_EXEC;
      process.env.NODE_ENV = 'production';
      expect(local.untrustedExecAllowed()).toBe(false);

      process.env.TM_ALLOW_UNSAFE_LOCAL_EXEC = '1';
      expect(local.untrustedExecAllowed()).toBe(true);

      delete process.env.TM_ALLOW_UNSAFE_LOCAL_EXEC;
      process.env.NODE_ENV = 'test';
      expect(local.untrustedExecAllowed()).toBe(true);
    } finally {
      if (prevNode === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNode;
      if (prevAllow === undefined) delete process.env.TM_ALLOW_UNSAFE_LOCAL_EXEC;
      else process.env.TM_ALLOW_UNSAFE_LOCAL_EXEC = prevAllow;
    }
  });

  it('runLocal refuses instead of spawning bash when gated off', async () => {
    const prevNode = process.env.NODE_ENV;
    const prevAllow = process.env.TM_ALLOW_UNSAFE_LOCAL_EXEC;
    delete process.env.TM_ALLOW_UNSAFE_LOCAL_EXEC;
    process.env.NODE_ENV = 'production';
    const marker = path.join(mkdtempSync(path.join(tmpdir(), 'tm-refuse-')), 'pwned');
    try {
      const evil = planBuild({
        type: 'node',
        manifest: {
          ecosystem: 'npm',
          path: 'package.json',
          dependencies: {},
          scripts: { build: `node -e "require('fs').writeFileSync('${marker}','x')"` },
          files: [],
        },
        hasLockfile: false,
      })!;
      const res = await local.runLocal(evil, path.dirname(marker));
      expect(res.ok).toBe(false);
      expect(res.log).toContain('[blocked]');
      const { existsSync } = await import('node:fs');
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (prevNode === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNode;
      if (prevAllow === undefined) delete process.env.TM_ALLOW_UNSAFE_LOCAL_EXEC;
      else process.env.TM_ALLOW_UNSAFE_LOCAL_EXEC = prevAllow;
    }
  });

  it('sandbox refuses to start a server from repo code, but still serves static', async () => {
    const prevNode = process.env.NODE_ENV;
    const prevAllow = process.env.TM_ALLOW_UNSAFE_LOCAL_EXEC;
    delete process.env.TM_ALLOW_UNSAFE_LOCAL_EXEC;
    process.env.NODE_ENV = 'production';
    try {
      await expect(
        sandbox.start({ snapshotId: 's', startCmd: 'npm start', projDir: '/tmp' })
      ).rejects.toThrow(/Refusing to start a server/);

      // static serving is inert and must keep working in production
      const dir = mkdtempSync(path.join(tmpdir(), 'tm-static-'));
      writeFileSync(path.join(dir, 'index.html'), '<h1>ok</h1>');
      const sb = await sandbox.start({ snapshotId: 's2', staticDir: dir });
      try {
        expect(sb.kind).toBe('static');
      } finally {
        sandbox.stop(sb.id);
      }
    } finally {
      if (prevNode === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNode;
      if (prevAllow === undefined) delete process.env.TM_ALLOW_UNSAFE_LOCAL_EXEC;
      else process.env.TM_ALLOW_UNSAFE_LOCAL_EXEC = prevAllow;
    }
  });
});