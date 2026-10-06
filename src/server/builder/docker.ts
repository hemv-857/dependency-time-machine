import { spawn } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { BuildPlan } from './plan';
import { RunResult } from './local';
import {
  containerLogs,
  createContainer,
  getArchive,
  imageExists,
  ping,
  pullImage,
  putArchive,
  removeContainer,
  startContainer,
  waitContainer,
} from './docker-api';

/** Marker the in-container script prints to report which static dir it produced. */
const OUT_MARKER = '__TM_OUT__=';

export interface DockerRunResult extends RunResult {
  /** Local dir already holding the built output (remote-daemon runs can't use findOutDir). */
  outHint?: string;
}

/** Docker daemon reachable over the Engine API. No CLI needed. */
export async function dockerAvailable(): Promise<boolean> {
  return ping();
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The script run inside the container: every plan step in one shell, each under
 * its own `timeout`, then report which static output dir exists.
 *
 * One container for all steps (rather than one per step) because there is no
 * bind mount to carry node_modules between them.
 */
function buildScript(plan: BuildPlan, outDirs: string[]): string {
  const lines = ['set -e', 'cd /work'];
  for (const step of plan.steps) {
    const secs = Math.max(1, Math.round(step.timeoutMs / 1000));
    lines.push(`echo "__TM_STEP__=${step.name}"`);
    lines.push(`timeout ${secs}s bash -c ${shq(step.cmd)}`);
  }
  lines.push('for d in ' + outDirs.map(shq).join(' ') + '; do');
  lines.push('  if [ -d "$d" ]; then');
  lines.push('    if [ -f "$d/index.html" ] || [ -n "$(ls -A "$d" 2>/dev/null)" ]; then');
  lines.push(`      echo "${OUT_MARKER}$d"`);
  lines.push('      break');
  lines.push('    fi');
  lines.push('  fi');
  lines.push('done');
  lines.push('exit 0');
  return lines.join('\n');
}

/**
 * Docker runner that needs no docker CLI and no local daemon.
 *
 * Isolation model: the container gets **no bind mounts at all**, so it cannot
 * reach the host filesystem — only its own (discarded) layer, /tmp, and the
 * network. Capabilities are dropped, privilege escalation is disabled, and
 * memory/CPU/PIDs are capped. Isolation comes from the daemon boundary rather
 * than from flags on a shared mount.
 */
export async function runDocker(
  plan: BuildPlan,
  projDir: string,
  onLog?: (chunk: string) => void,
  image?: string
): Promise<DockerRunResult> {
  const started = Date.now();
  const parts: string[] = [];
  const emit = (s: string) => {
    if (s) parts.push(s);
    onLog?.(s);
  };

  const img = image || (plan.toolchain === 'python' ? process.env.TM_PYTHON_IMAGE || 'python:3.12-slim' : process.env.TM_NODE_IMAGE || 'node:20-bookworm-slim');
  const network = process.env.TM_DOCKER_NETWORK || 'bridge';
  const outLocal = path.join(projDir, '.tm-docker-out');

  if (!(await ping())) {
    return {
      ok: false,
      timedOut: false,
      ms: Date.now() - started,
      log: `\n[docker] unreachable — set TM_DOCKER_HOST to a reachable Docker daemon\n`,
    };
  }

  if (!(await imageExists(img))) {
    emit(`\n$ docker pull ${img}\n`);
    try {
      await pullImage(img);
    } catch (e) {
      return {
        ok: false,
        timedOut: false,
        ms: Date.now() - started,
        log: `${parts.join('')}\n[docker] image pull failed for ${img}: ${(e as Error).message}\n`,
      };
    }
  }

  let id = '';
  let outHint: string | undefined;
  try {
    id = await createContainer({
      image: img,
      cmd: ['bash', '-lc', buildScript(plan, plan.outDirs)],
      workdir: '/work',
      env: [
        'HOME=/tmp/home',
        'CI=1',
        'LANG=C.UTF-8',
        'TZ=UTC',
        'NO_COLOR=1',
        'npm_config_update_notifier=false',
        'npm_config_fund=false',
        'npm_config_audit=false',
      ],
      user: String(process.getuid?.() ?? 1000),
      network,
      memoryBytes: 1024 * 1024 * 1024,
      nanoCpus: 1_500_000_000,
      pidsLimit: 512,
      capDrop: ['ALL'],
      securityOpt: ['no-new-privileges'],
      tmpfs: { '/tmp': 'rw,noexec,nosuid,size=256m', '/tmp/home': 'rw,nosuid,size=16m' },
    });

    // upload the checked-out tree (no bind mount: a remote daemon has a
    // different filesystem, and omitting mounts also removes host fs access)
    emit(`\n$ [docker:${img}] upload project → /work\n`);
    await putArchive(id, '/work', tarStream(['-cf', '-', '-C', projDir, '.']));

    emit(`\n$ [docker:${img}] ${plan.steps.map((s) => s.cmd).join(' && ')}\n`);
    await startContainer(id);

    const logs = await containerLogs(id, (c) => emit(c));
    const budget =
      plan.steps.reduce((a, s) => a + s.timeoutMs, 0) + 120_000;
    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      void removeContainer(id);
    }, budget);

    const code = await waitContainer(id);
    clearTimeout(killer);
    logs.resume();

    if (timedOut) {
      return { ok: false, timedOut: true, ms: Date.now() - started, log: `${parts.join('')}\n[docker] exceeded ${Math.round(budget / 1000)}s hard timeout\n` };
    }

    const outRel = parseOut(parts.join(''));
    if (plan.mode !== 'test' && code === 0 && outRel) {
      await fsp.rm(outLocal, { recursive: true, force: true });
      await fsp.mkdir(outLocal, { recursive: true });
      await extractArchive(await getArchive(id, `/work/${outRel}`), outLocal);
      outHint = outLocal;
      emit(`\n[docker] output ${outRel} downloaded\n`);
    }

    const ok = code === 0 && (plan.mode === 'test' || !!outRel);
    if (!ok && code !== 0) emit(`\n[docker] build exited ${code}\n`);
    return { ok, timedOut: false, outHint, ms: Date.now() - started, log: parts.join('') };
  } catch (e) {
    return {
      ok: false,
      timedOut: false,
      ms: Date.now() - started,
      log: `${parts.join('')}\n[docker] ${(e as Error).message}\n`,
    };
  } finally {
    if (id) await removeContainer(id);
  }
}

function parseOut(log: string): string | null {
  const m = log.match(new RegExp(`${OUT_MARKER}(\\S+)`));
  return m ? m[1] : null;
}

function tarStream(args: string[]): NodeJS.ReadableStream {
  const t = spawn('tar', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  t.stderr.resume();
  return t.stdout;
}

function extractArchive(stream: import('node:http').IncomingMessage, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const x = spawn('tar', ['-xf', '-', '-C', dest], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    x.stderr.on('data', (c) => (err += c));
    x.on('error', reject);
    x.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar extract failed: ${err.slice(0, 300)}`))));
    stream.on('error', reject);
    stream.pipe(x.stdin);
  });
}