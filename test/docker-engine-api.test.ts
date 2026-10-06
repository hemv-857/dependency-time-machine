import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { IncomingMessage, Server } from 'node:http';

/**
 * Fake Docker Engine API.
 *
 * Lets the whole remote-daemon build path be verified without a Docker daemon
 * installed: ping, image lookup, create, archive upload, start, log streaming,
 * wait, archive download, remove. Exercises src/server/builder/docker.ts against
 * a socket that behaves like a daemon.
 */
interface FakeOpts {
  imageExists?: boolean;
  exitCode?: number;
  logs?: string;
  outDir?: string;
}

function fakeTar(dir: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const t = spawn('tar', ['-cf', '-', '-C', dir, '.'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let err = '';
    t.stdout.on('data', (c) => chunks.push(c));
    t.stderr.on('data', (c) => (err += c));
    t.on('error', reject);
    t.on('close', (c) => (c === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(err))));
  });
}

async function startFakeDaemon(o: FakeOpts & { mappedPort?: number }) {
  const http = await import('node:http');
  const calls: string[] = [];
  const createdBodies: any[] = [];
  let uploadedBytes = 0;

  const server: Server = http.createServer((req: IncomingMessage, res) => {
    const url = req.url || '/';
    calls.push(`${req.method} ${url.split('?')[0]}`);
    const send = (code: number, body?: string | Buffer, type = 'application/json') => {
      res.writeHead(code, { 'Content-Type': type });
      res.end(body);
    };

    if (url.startsWith('/_ping')) return send(200, 'OK', 'text/plain');

    if (req.method === 'GET' && /^\/v?[\d.]*\/images\/.+\/json$/.test(url)) {
      return o.imageExists === false ? send(404, '{"message":"no such image"}') : send(200, '{"Id":"sha256:x"}');
    }
    if (req.method === 'POST' && url.includes('/images/create')) {
      return send(200, '{"status":"Downloaded newer image"}');
    }
    if (req.method === 'POST' && url.includes('/containers/create')) {
      let body = '';
      req.on('data', (c) => (body += c));
      return req.on('end', () => {
        try {
          createdBodies.push(JSON.parse(body));
        } catch {
          /* ignore */
        }
        send(201, JSON.stringify({ Id: 'deadbeefcafe' }));
      });
    }
    if (req.method === 'PUT' && url.includes('/archive')) {
      req.on('data', (c) => (uploadedBytes += c.length));
      return req.on('end', () => send(200, '{}'));
    }
    if (req.method === 'POST' && url.includes('/start')) return send(204);
    if (req.method === 'GET' && /\/containers\/[^/]+\/json/.test(url)) {
      // report the host port the daemon "chose" for the published mapping
      const port = o.mappedPort || 40001;
      return send(
        200,
        JSON.stringify({
          State: { Running: true, Status: 'running' },
          NetworkSettings: { Ports: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: String(port) }] } },
        })
      );
    }
    if (req.method === 'GET' && url.includes('/logs')) {
      res.writeHead(200, { 'Content-Type': 'application/vnd.docker.raw-stream' });
      res.write(o.logs ?? '$ npm run build\nbuilt ok\n');
      return setTimeout(() => res.end(), 5);
    }
    if (req.method === 'POST' && url.includes('/wait')) {
      return send(200, JSON.stringify({ StatusCode: o.exitCode ?? 0 }));
    }
    if (req.method === 'GET' && url.includes('/archive')) {
      const dir = o.outDir || '';
      if (!dir) return send(404, '{"message":"no such path"}');
      return fakeTar(dir).then(
        (buf) => send(200, buf, 'application/x-tar'),
        (e) => send(500, String(e))
      );
    }
    if (req.method === 'DELETE') return send(204);
    return send(404, '{"message":"unhandled"}');
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as import('node:net').AddressInfo).port;
  return { server, port, calls, createdBodies, uploaded: () => uploadedBytes };
}

describe('docker runner over the Engine API (no docker CLI, no local daemon)', () => {
  let prevHost: string | undefined;
  beforeAll(() => {
    prevHost = process.env.TM_DOCKER_HOST;
  });
  afterAll(() => {
    if (prevHost === undefined) delete process.env.TM_DOCKER_HOST;
    else process.env.TM_DOCKER_HOST = prevHost;
  });

  it('uploads the project, streams logs, and downloads the output dir', async () => {
    const proj = mkdtempSync(path.join(tmpdir(), 'tm-proj-'));
    writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }));

    const site = mkdtempSync(path.join(tmpdir(), 'tm-site-'));
    writeFileSync(path.join(site, 'index.html'), '<h1>Hello from the past</h1>');

    const logs = '$ npm run build\nbuilt ok\n__TM_OUT__=dist\n';
    const fake = await startFakeDaemon({ logs, outDir: site });
    process.env.TM_DOCKER_HOST = `http://127.0.0.1:${fake.port}`;

    const { runDocker, dockerAvailable } = await import('@/server/builder/docker');
    expect(await dockerAvailable()).toBe(true);

    const plan = {
      mode: 'build' as const,
      toolchain: 'node' as const,
      steps: [{ name: 'build', cmd: 'npm run build', timeoutMs: 30_000 }],
      outDirs: ['build', 'dist'],
      startScript: false,
    };

    const emitted: string[] = [];
    const res = await runDocker(plan, proj, (c) => emitted.push(c));

    expect(res.ok, res.log).toBe(true);
    expect(res.log).toContain('npm run build');
    expect(res.outHint).toBe(path.join(proj, '.tm-docker-out'));
    expect(existsSync(res.outHint!)).toBe(true);
    expect(readFileSync(path.join(res.outHint!, 'index.html'), 'utf8')).toContain('Hello from the past');
    // source really was uploaded, and the container really was cleaned up
    expect(fake.uploaded()).toBeGreaterThan(0);
    expect(fake.calls.some((c) => c === 'DELETE /v1.43/containers/deadbeefcafe')).toBe(true);
  });

  it('pulls a missing image before building', async () => {
    const proj = mkdtempSync(path.join(tmpdir(), 'tm-proj2-'));
    const site = mkdtempSync(path.join(tmpdir(), 'tm-site2-'));
    writeFileSync(path.join(site, 'index.html'), '<h1>pulled</h1>');

    const fake = await startFakeDaemon({ imageExists: false, logs: '__TM_OUT__=dist\n', outDir: site });
    process.env.TM_DOCKER_HOST = `http://127.0.0.1:${fake.port}`;

    const { runDocker } = await import('@/server/builder/docker');
    const plan = {
      mode: 'build' as const,
      toolchain: 'node' as const,
      steps: [{ name: 'build', cmd: 'echo hi', timeoutMs: 10_000 }],
      outDirs: ['dist'],
      startScript: false,
    };
    const res = await runDocker(plan, proj);
    expect(fake.calls.some((c) => c.includes('/images/create'))).toBe(true);
    expect(res.ok, res.log).toBe(true);
    expect(readFileSync(path.join(res.outHint!, 'index.html'), 'utf8')).toContain('pulled');
  });

  it('fails closed (not ok) when the daemon is unreachable', async () => {
    const proj = mkdtempSync(path.join(tmpdir(), 'tm-proj3-'));
    mkdirSync(proj, { recursive: true });
    // port 1 is reserved and refuses connections
    process.env.TM_DOCKER_HOST = 'http://127.0.0.1:1';

    const { runDocker, dockerAvailable } = await import('@/server/builder/docker');
    expect(await dockerAvailable()).toBe(false);

    const plan = {
      mode: 'build' as const,
      toolchain: 'node' as const,
      steps: [{ name: 'build', cmd: 'echo hi', timeoutMs: 10_000 }],
      outDirs: ['dist'],
      startScript: false,
    };
    const res = await runDocker(plan, proj);
    expect(res.ok).toBe(false);
    expect(res.log).toContain('unreachable');
  });
});

describe('container-backed server preview', () => {
  let prevHost: string | undefined;
  let prevBind: string | undefined;
  afterAll(() => {
    if (prevHost === undefined) delete process.env.TM_DOCKER_HOST;
    else process.env.TM_DOCKER_HOST = prevHost;
    if (prevBind === undefined) delete process.env.TM_DOCKER_PREVIEW_BIND;
    else process.env.TM_DOCKER_PREVIEW_BIND = prevBind;
  });

  it('binds the published port to loopback by default', async () => {
    delete process.env.TM_DOCKER_PREVIEW_BIND;
    const { previewBindIp, previewBindIsPublic, previewDialHost } = await import('@/server/sandbox');
    expect(previewBindIp()).toBe('127.0.0.1');
    expect(previewBindIsPublic()).toBe(false);
    expect(previewDialHost()).toBe('127.0.0.1');
  });

  it('treats a wildcard bind as public and dials the daemon host', async () => {
    process.env.TM_DOCKER_PREVIEW_BIND = '0.0.0.0';
    process.env.TM_DOCKER_HOST = 'tcp://builder.internal:2375';
    const { previewBindIsPublic, previewDialHost } = await import('@/server/sandbox');
    expect(previewBindIsPublic()).toBe(true);
    expect(previewDialHost()).toBe('builder.internal');
    delete process.env.TM_DOCKER_PREVIEW_BIND;
  });

  it('uploads the tree, asks the daemon to pick a port, and reads it back', async () => {
    const proj = mkdtempSync(path.join(tmpdir(), 'tm-srvproj-'));
    writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }));

    const fake = await startFakeDaemon({ mappedPort: 45555 });
    process.env.TM_DOCKER_HOST = `http://127.0.0.1:${fake.port}`;
    process.env.TM_PREVIEW_READY_TIMEOUT_MS = '300'; // nothing really listens

    const sandbox = await import('@/server/sandbox');
    const sb = await sandbox
      .startContainer({ snapshotId: 's1', projDir: proj, startCmd: 'npm start', installCmd: 'npm ci' })
      .catch(() => null);

    expect(fake.createdBodies).toHaveLength(1);
    const spec = fake.createdBodies[0];
    expect(spec.Cmd.slice(0, 2)).toEqual(['bash', '-lc']);
    expect(spec.Cmd[2]).toContain('npm ci');
    expect(spec.Cmd[2]).toContain('npm start');
    expect(spec.Env).toContain('HOST=0.0.0.0');
    // loopback publish with a daemon-chosen port: previews cannot collide
    expect(spec.HostConfig.PortBindings['3000/tcp']).toEqual([{ HostIp: '127.0.0.1', HostPort: '0' }]);
    // same hardening as a build, and still no bind mounts at all
    expect(spec.HostConfig.CapDrop).toEqual(['ALL']);
    expect(spec.HostConfig.SecurityOpt).toContain('no-new-privileges');
    expect(spec.HostConfig.Binds).toBeUndefined();
    expect(fake.uploaded()).toBeGreaterThan(0);

    // the port the daemon reported is the one we dial
    if (sb) {
      expect(sb.port).toBe(45555);
      expect(sb.runner).toBe('docker');
      sandbox.stop(sb.id);
    }
    delete process.env.TM_PREVIEW_READY_TIMEOUT_MS;
  });

  it('refuses to start a container preview when the daemon is down', async () => {
    process.env.TM_DOCKER_HOST = 'http://127.0.0.1:1';
    const sandbox = await import('@/server/sandbox');
    await expect(
      sandbox.startContainer({ snapshotId: 's2', projDir: '/tmp', startCmd: 'npm start' })
    ).rejects.toThrow(/docker unreachable/);
  });
});