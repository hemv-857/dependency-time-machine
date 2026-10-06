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
  kind: 'static' | 'server';
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

  const sb: Sandbox = { id, snapshotId: opts.snapshotId, port, kind, child, startedAt: Date.now(), expiresAt: Date.now() + TTL_MS };
  reg().sandboxes.set(id, sb);
  await waitForPort(port, kind === 'static' ? 10_000 : 30_000);
  log.info({ sandboxId: id, snapshotId: opts.snapshotId, port, kind }, 'sandbox started');
  ensureSweeper();
  return sb;
}

async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const up = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ port, host: '127.0.0.1' });
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
