import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findOutDir, runLocal } from '@/server/builder/local';
import { planBuild } from '@/server/builder/plan';
import * as sandbox from '@/server/sandbox';
import { rateLimit } from '@/server/ratelimit';

describe('build + serve integration (local runner)', () => {
  let sb: sandbox.Sandbox | null = null;
  let dir: string | null = null;

  afterAll(() => {
    if (sb) sandbox.stop(sb.id);
  });

  it('builds a zero-dependency fixture and serves it in an ephemeral sandbox', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'tm-fixture-'));
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'fixture-app',
        version: '1.0.0',
        scripts: { build: 'node make-dist.js' },
      })
    );
    writeFileSync(
      path.join(dir, 'make-dist.js'),
      `require('node:fs').mkdirSync('dist', {recursive:true});` +
        `require('node:fs').writeFileSync('dist/index.html', '<h1>Hello from the past</h1>');`
    );

    const plan = planBuild({
      type: 'node',
      manifest: { ecosystem: 'npm', path: 'package.json', dependencies: {}, scripts: { build: 'node make-dist.js' }, files: [] },
      hasLockfile: false,
    });
    expect(plan?.mode).toBe('build');
    const run = await runLocal(plan!, dir);
    expect(run.ok, run.log).toBe(true);

    const out = await findOutDir(dir, plan!.outDirs);
    expect(out).toContain('dist');

    sb = await sandbox.start({ snapshotId: 'test-snap', staticDir: out! });
    const res = await fetch(`http://127.0.0.1:${sb.port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Hello from the past');

    expect(sandbox.info(sb.id)?.snapshotId).toBe('test-snap');
    expect(sandbox.forSnapshot('test-snap')?.id).toBe(sb.id);

    sandbox.stop(sb.id);
    expect(sandbox.info(sb.id)).toBeNull();
    sb = null;
  });
});

describe('rateLimit', () => {
  it('enforces a fixed window per key', async () => {
    const key = `test:${Math.random()}`;
    expect((await rateLimit(key, 2, 60)).ok).toBe(true);
    expect((await rateLimit(key, 2, 60)).ok).toBe(true);
    const third = await rateLimit(key, 2, 60);
    expect(third.ok).toBe(false);
    expect(third.retryAfterSec).toBeGreaterThan(0);
  });
});
