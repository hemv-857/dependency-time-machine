import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { childLogger } from './log';

const execFileP = promisify(execFile);
const log = childLogger({ mod: 'trees' });

function dataDir(): string {
  return process.env.TM_DATA_DIR || '.data';
}

export function treeDir(owner: string, name: string, sha: string): string {
  return path.join(dataDir(), 'trees', `${owner}~${name}`, sha);
}

const inflight = new Map<string, Promise<string>>();

/**
 * Materialize a repo commit as a plain directory (cached on disk per sha).
 * Uses the GitHub tarball endpoint + system tar — no git binary needed.
 */
export async function fetchTree(
  gh: { tarball(fullName: string, sha: string, dest: string): Promise<void> },
  fullName: string,
  sha: string
): Promise<string> {
  const [owner, name] = fullName.split('/');
  const dir = treeDir(owner, name, sha);
  const exists = await stat(dir).then(
    () => true,
    () => false
  );
  if (exists) return dir;
  const running = inflight.get(dir);
  if (running) return running;
  const p = (async () => {
    const tmp = path.join(os.tmpdir(), `tm-tar-${sha.slice(0, 12)}-${Date.now()}`);
    await mkdir(tmp, { recursive: true });
    try {
      const tgz = path.join(tmp, 'repo.tgz');
      await gh.tarball(fullName, sha, tgz);
      await mkdir(dir, { recursive: true });
      await execFileP('tar', ['-xzf', tgz, '-C', dir, '--strip-components=1'], { timeout: 120_000 });
      log.info({ fullName, sha }, 'tree extracted');
      return dir;
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
      inflight.delete(dir);
    }
  })();
  inflight.set(dir, p);
  return p;
}

export async function listFiles(root: string, prefix = ''): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      // don't descend into heavy/irrelevant dirs, but still record their marker files
      out.push(rel);
      out.push(...(await listFiles(path.join(root, e.name), rel)));
    } else {
      out.push(rel);
    }
  }
  return out;
}

export function readTreeFile(root: string, relPath: string): string | null {
  try {
    return readFileSync(path.join(root, relPath), 'utf8');
  } catch {
    return null;
  }
}

export async function readTreeFileAsync(root: string, relPath: string): Promise<string | null> {
  try {
    return await readFile(path.join(root, relPath), 'utf8');
  } catch {
    return null;
  }
}
