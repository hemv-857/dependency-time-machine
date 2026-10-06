import { spawn, ChildProcess } from 'node:child_process';
import { stat } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { killTree, sandboxEnv, untrustedExecAllowed, UntrustedExecRefused } from './builder/local';
import { childLogger } from './log';

const log = childLogger({ mod: 'sandbox' });

export const TTL_MS = Number(process.env.TM_SANDBOX_TTL_MS || 10 * 60 * 1000);

export interface Sandbox {
  id: string;
  snapshotId: string;
  port: number;
  /** Address the app dials to reach this sandbox. Derived from config, never user input. */
  host: string;
  kind: 'static' | 'server';
  runner: 'local' | 'docker';
  child?: ChildProcess;
  containerId?: string;
  startedAt: number;
  expiresAt: number;
}

interface Registry {
  sandboxes: Map<string, Sandbox>;
  sweeper?: NodeJS.Timeout;
}

const globalForSb = globalThis as unknown as { __tmSandbox?: Registry };

function reg(): Registry {
  if (!globalForSb.__tmSandbox) globalForSb.__tmSandbox = { sandboxes: new Map() };
  return globalForSb.__tmSandbox;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

function staticServerScript(): string {
  // resolved relative to this module; works from source and standalone builds
  return path.join(process.cwd(), 'src', 'server', 'builder', 'static-server.cjs');
}

export async function start(opts: {
  snapshotId: string;
  /** static dir to serve, or a start command to run with $PORT */
  staticDir?: string;
  startCmd?: string;
  projDir?: string;
}): Promise<Sandbox> {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const kind: Sandbox['kind'] = opts.staticDir ? 'static' : 'server';

  // Serving a static dir through our own server is inert. `npm start` in the
  // checked-out tree is not — it executes third-party code, here for the full
  // TTL, behind a public proxy route. Same rule as the build runner.
  if (!opts.staticDir && !untrustedExecAllowed()) {
    throw new UntrustedExecRefused('start a server from this repo');
  }

  const port = await freePort();
  let child: ChildProcess | undefined;

  if (opts.staticDir) {
    child = spawn(process.execPath, [staticServerScript(), opts.staticDir, String(port)], {
      env: sandboxEnv() as NodeJS.ProcessEnv,
      stdio: 'ignore',
      detached: true,
    });
  } else if (opts.startCmd && opts.projDir) {
    child = spawn('bash', ['-lc', opts.startCmd], {
      cwd: opts.projDir,
      env: sandboxEnv({ PORT: String(port), HOST: '127.0.0.1' }) as NodeJS.ProcessEnv,
      stdio: 'ignore',
      detached: true,
    });
  } else {
    throw new Error('sandbox needs staticDir or startCmd+projDir');
  }
  child.unref();

  const sb: Sandbox = {
    id,
    snapshotId: opts.snapshotId,
    port,
    host: '127.0.0.1',
    kind,
    runner: 'local',
    child,
    startedAt: Date.now(),
    expiresAt: Date.now() + TTL_MS,
  };
  reg().sandboxes.set(id, sb);
  await waitForPort('127.0.0.1', port, kind === 'static' ? 10_000 : 30_000);
  log.info({ sandboxId: id, snapshotId: opts.snapshotId, port, kind }, 'sandbox started');
  ensureSweeper();
  return sb;
}

/**
 * Address the container's port is published on, on the daemon host.
 *
 * Loopback by default, which means the untrusted preview is reachable only from
 * the machine running the daemon — anyone else (including this app on another
 * host) cannot dial it directly, so they cannot bypass the preview route's
 * liveness checks. Widening it publishes a stranger's `npm start` to the network.
 */
export function previewBindIp(): string {
  const raw = (process.env.TM_DOCKER_PREVIEW_BIND || '127.0.0.1').trim();
  return raw === 'localhost' ? '127.0.0.1' : raw;
}

/** Where this app should dial to reach a published container port. */
export function previewDialHost(): string {
  const bind = previewBindIp();
  if (bind && bind !== '0.0.0.0' && bind !== '::') return bind;
  // wildcard publish: reach the daemon over whatever address it lives on
  const h = (process.env.TM_DOCKER_HOST || '').trim();
  if (h.startsWith('tcp://') || h.startsWith('http://') || h.startsWith('https://')) {
    try {
      return new URL(h.includes('://') ? h : `tcp://${h}`).hostname;
    } catch {
      /* fall through */
    }
  }
  return '127.0.0.1';
}

export function previewBindIsPublic(): boolean {
  const b = previewBindIp();
  return b === '0.0.0.0' || b === '::';
}

/**
 * Start a repo's server inside a container so server-mode previews work with a
 * remote daemon, instead of requiring the (production-refused) local runner.
 *
 * The container gets the same treatment as a build: no bind mounts, caps dropped,
 * resource caps, and a loopback-only published port. There is no separate signed
 * token — the unguessable sandbox id plus the TTL plus the loopback bind are the
 * access control, and a URL token would add a secret without adding a boundary
 * (anyone who can reach the port directly ignores the URL anyway).
 */
export async function startContainer(opts: {
  snapshotId: string;
  projDir: string;
  startCmd: string;
  installCmd?: string;
  containerPort?: number;
  image?: string;
}): Promise<Sandbox> {
  const api = await import('./builder/docker-api');
  if (!(await api.ping())) {
    throw new Error(`docker unreachable — set TM_DOCKER_HOST to a reachable daemon to start a server preview`);
  }
  if (previewBindIsPublic()) {
    log.warn(
      { bind: previewBindIp() },
      'TM_DOCKER_PREVIEW_BIND publishes untrusted preview containers beyond loopback'
    );
  }

  const cport = opts.containerPort || Number(process.env.TM_DOCKER_PREVIEW_PORT || 3000);
  const image = opts.image || process.env.TM_NODE_IMAGE || 'node:20-bookworm-slim';
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  const containerId = await api.createContainer({
    image,
    // no bind mounts: the tree is uploaded below
    cmd: ['bash', '-lc', `set -e\ncd /work\n${opts.installCmd ? `${opts.installCmd}\n` : ''}exec ${opts.startCmd}`],
    workdir: '/work',
    env: [
      'HOME=/tmp/home',
      'PORT=' + String(cport),
      'HOST=0.0.0.0',
      'NODE_ENV=production',
      'CI=1',
      'NO_COLOR=1',
      'npm_config_update_notifier=false',
      'npm_config_fund=false',
      'npm_config_audit=false',
    ],
    network: process.env.TM_DOCKER_NETWORK || 'bridge',
    memoryBytes: 1024 * 1024 * 1024,
    nanoCpus: 1_500_000_000,
    pidsLimit: 512,
    capDrop: ['ALL'],
    securityOpt: ['no-new-privileges'],
    tmpfs: { '/tmp': 'rw,noexec,nosuid,size=256m', '/tmp/home': 'rw,nosuid,size=16m' },
    exposedPorts: [`${cport}/tcp`],
    // HostPort 0 lets the daemon pick a free port, so concurrent previews
    // cannot collide on a fixed number.
    portBindings: { [`${cport}/tcp`]: { hostIp: previewBindIp(), hostPort: '0' } },
  });

  try {
    await api.putArchive(containerId, '/work', tarStream(opts.projDir));
    await api.startContainer(containerId);

    const info = await api.inspectContainer(containerId);
    const mapped = info.NetworkSettings?.Ports?.[`${cport}/tcp`]?.[0];
    const hostPort = Number(mapped?.HostPort);
    if (!Number.isFinite(hostPort) || hostPort <= 0) {
      throw new Error(`docker did not publish a host port for ${cport}/tcp`);
    }

    const sb: Sandbox = {
      id,
      snapshotId: opts.snapshotId,
      port: hostPort,
      host: previewDialHost(),
      kind: 'server',
      runner: 'docker',
      containerId,
      startedAt: Date.now(),
      expiresAt: Date.now() + TTL_MS,
    };
    reg().sandboxes.set(id, sb);
    // installing deps inside a fresh container is the slow part
    await waitForPort(sb.host, hostPort, Number(process.env.TM_PREVIEW_READY_TIMEOUT_MS || 120_000));
    log.info({ sandboxId: id, snapshotId: opts.snapshotId, host: sb.host, port: hostPort, kind: 'server', runner: 'docker' }, 'container sandbox started');
    ensureSweeper();
    return sb;
  } catch (e) {
    await api.removeContainer(containerId);
    throw e;
  }
}

function tarStream(dir: string): NodeJS.ReadableStream {
  const t = spawn('tar', ['-cf', '-', '-C', dir, '.'], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.stderr.resume();
  return t.stdout;
}

async function waitForPort(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const up = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ port, host });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
      socket.setTimeout(1000, () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (up) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

export function info(id: string): Sandbox | null {
  const sb = reg().sandboxes.get(id);
  if (!sb) return null;
  if (Date.now() > sb.expiresAt) {
    stop(id);
    return null;
  }
  return sb;
}

/** The live sandbox for a snapshot, if any (and not expired). */
export function forSnapshot(snapshotId: string): Sandbox | null {
  for (const sb of reg().sandboxes.values()) {
    if (sb.snapshotId === snapshotId) return info(sb.id);
  }
  return null;
}

export function stop(id: string): void {
  const sb = reg().sandboxes.get(id);
  if (!sb) return;
  if (sb.child?.pid) killTree(sb.child.pid);
  if (sb.containerId) {
    // fire-and-forget: a preview container must not outlive its sandbox, and a
    // dead daemon must not block the registry from being cleaned up
    void import('./builder/docker-api')
      .then((api) => api.removeContainer(sb.containerId!))
      .catch(() => {});
  }
  reg().sandboxes.delete(id);
  log.info({ sandboxId: id, snapshotId: sb.snapshotId }, 'sandbox stopped');
}

export function stopForSnapshot(snapshotId: string): void {
  for (const [id, sb] of reg().sandboxes) {
    if (sb.snapshotId === snapshotId) stop(id);
  }
}

export function sweep(): number {
  let n = 0;
  for (const [id, sb] of reg().sandboxes) {
    if (Date.now() > sb.expiresAt) {
      stop(id);
      n++;
    }
  }
  return n;
}

export function activeCount(): number {
  return reg().sandboxes.size;
}

function ensureSweeper(): void {
  const r = reg();
  if (r.sweeper) return;
  r.sweeper = setInterval(() => {
    const n = sweep();
    if (n > 0) log.info({ expired: n }, 'sandbox TTL sweep');
  }, 30_000);
  r.sweeper.unref();
}

/** Best-effort guard that a directory exists (used before serving). */
export async function dirExists(p: string): Promise<boolean> {
  return stat(p).then(
    (s) => s.isDirectory(),
    () => false
  );
}
