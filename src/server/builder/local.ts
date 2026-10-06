import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { BuildPlan } from './plan';

export interface RunResult {
  ok: boolean;
  timedOut: boolean;
  log: string;
  ms: number;
}

/**
 * Is it safe to execute a checked-out third-party repo on this host?
 *
 * `npm ci` / `npm install` runs dependency lifecycle scripts (preinstall,
 * postinstall, prepare) and `npm run build` / `npm test` / `npm start` run the
 * repo's own scripts. The tree is arbitrary public GitHub content chosen by
 * whoever hits the endpoint, so running it is arbitrary code execution as this
 * process — with network egress and this user's filesystem. A reduced env var
 * does not change that; only an isolation boundary does.
 *
 * So the local runner is dev/test-only. Production must run the docker runner
 * (see TM_RUNNER). Set TM_ALLOW_UNSAFE_LOCAL_EXEC=1 to accept the risk
 * deliberately — for example on a disposable VM with no secrets and no egress.
 */
export function untrustedExecAllowed(): boolean {
  if (process.env.TM_ALLOW_UNSAFE_LOCAL_EXEC === '1') return true;
  return process.env.NODE_ENV !== 'production';
}

export class UntrustedExecRefused extends Error {
  constructor(what: string) {
    super(
      `Refusing to ${what}: executing untrusted repository code on this host is disabled in production. ` +
        `Use the isolated docker runner (TM_RUNNER=docker) so builds cannot touch the host, ` +
        `or set TM_ALLOW_UNSAFE_LOCAL_EXEC=1 on a disposable, secret-free sandbox host.`
    );
    this.name = 'UntrustedExecRefused';
  }
}

/** Reduced environment for the sandboxed helpers. Not a security boundary — see untrustedExecAllowed. */
export function sandboxEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: extra.HOME || process.env.HOME || '/tmp',
    LANG: 'C.UTF-8',
    TZ: 'UTC',
    CI: '1',
    NO_COLOR: '1',
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
  };
  return { ...env, ...extra };
}

export function toolchainVersions(): Record<string, string> {
  const versions: Record<string, string> = {};
  const probes: [string, string, string[]][] = [
    ['node', 'node', ['--version']],
    ['npm', 'npm', ['--version']],
    ['python', 'python3', ['--version']],
  ];
  for (const [key, cmd, args] of probes) {
    try {
      const r = spawnSyncSafe(cmd, args);
      if (r.ok) versions[key] = r.out.trim().replace(/^v/, '');
    } catch {
      /* not installed */
    }
  }
  return versions;
}

function spawnSyncSafe(cmd: string, args: string[]): { ok: boolean; out: string } {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 5000 });
    return { ok: r.status === 0, out: (r.stdout || r.stderr || '').trim() };
  } catch {
    return { ok: false, out: '' };
  }
}

/**
 * Local runner (dev + no-docker deploys): executes the plan's steps via bash in
 * a process group so the hard timeout can kill the whole tree.
 */
export async function runLocal(
  plan: BuildPlan,
  projDir: string,
  onLog?: (chunk: string) => void
): Promise<RunResult> {
  if (!untrustedExecAllowed()) {
    return {
      ok: false,
      timedOut: false,
      ms: 0,
      log: `\n[blocked] ${new UntrustedExecRefused('build this repo').message}\n`,
    };
  }
  const started = Date.now();
  const logParts: string[] = [];
  const emit = (s: string) => {
    logParts.push(s);
    onLog?.(s);
  };

  for (const step of plan.steps) {
    emit(`\n$ ${step.cmd}\n`);
    const r = await execStep(step.cmd, projDir, step.timeoutMs, (chunk) => emit(chunk));
    if (!r.ok) {
      return { ok: false, timedOut: r.timedOut, log: logParts.join(''), ms: Date.now() - started };
    }
  }
  return { ok: true, timedOut: false, log: logParts.join(''), ms: Date.now() - started };
}

function execStep(
  cmd: string,
  cwd: string,
  timeoutMs: number,
  onOutput: (chunk: string) => void
): Promise<{ ok: boolean; timedOut: boolean }> {
  return new Promise((resolve) => {
    let timedOut = false;
    const child: ChildProcess = spawn('bash', ['-c', cmd], {
      cwd,
      env: sandboxEnv() as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // own process group → we can kill the whole tree
    });
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
    }, timeoutMs);
    const onData = (d: Buffer) => onOutput(d.toString());
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (e: Error) => {
      clearTimeout(timer);
      onOutput(`\n[spawn error] ${e.message}\n`);
      resolve({ ok: false, timedOut });
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, timedOut });
    });
  });
}

export function killTree(pid: number): void {
  try {
    process.kill(-pid, 'SIGTERM');
    setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }, 3000);
  } catch {
    /* already gone */
  }
}

/** After a build, find the static output dir (if any). */
export async function findOutDir(projDir: string, outDirs: string[]): Promise<string | null> {
  for (const dir of outDirs) {
    const p = path.join(projDir, dir);
    const ok = await stat(p).then(
      (s) => s.isDirectory(),
      () => false
    );
    if (ok) {
      // sanity: must contain at least one file
      try {
        await access(path.join(p, 'index.html'));
        return p;
      } catch {
        const { readdir } = await import('node:fs/promises');
        const entries = await readdir(p);
        if (entries.length > 0) return p;
      }
    }
  }
  return null;
}
