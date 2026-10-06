import { Ecosystem, Lockfile, Manifest } from '../types';

function splitSpec(spec: string): { name: string; rest: string } {
  let s = spec.trim();
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  let idx: number;
  if (s.startsWith('@')) idx = s.indexOf('@', 1);
  else idx = s.lastIndexOf('@');
  if (idx === -1) return { name: s, rest: '' };
  return { name: s.slice(0, idx), rest: s.slice(idx + 1) };
}
export { splitSpec };

function putBest(packages: Record<string, string>, depths: Record<string, number>, name: string, version: string, depth: number) {
  if (!name || !version) return;
  if (!(name in packages) || depth < depths[name]) {
    packages[name] = version;
    depths[name] = depth;
  }
}

/** package-lock.json v1 (dependencies tree) and v2/v3 (packages map). */
export function parsePackageLock(text: string): Lockfile {
  const j = JSON.parse(text);
  const packages: Record<string, string> = {};
  const depths: Record<string, number> = {};
  if (j && typeof j.packages === 'object' && j.packages) {
    for (const [key, info] of Object.entries<Record<string, unknown>>(j.packages)) {
      if (!key || !info || typeof info.version !== 'string') continue;
      const m = /node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(key);
      if (!m) continue;
      const depth = (key.match(/node_modules\//g) || []).length;
      putBest(packages, depths, m[1], info.version, depth);
    }
  } else if (j && typeof j.dependencies === 'object' && j.dependencies) {
    const walk = (deps: Record<string, any>, depth: number) => {
      for (const [name, info] of Object.entries(deps)) {
        if (info && typeof info.version === 'string') putBest(packages, depths, name, info.version, depth);
        if (info && typeof info.dependencies === 'object') walk(info.dependencies, depth + 1);
      }
    };
    walk(j.dependencies, 0);
  }
  return { ecosystem: 'npm', path: 'package-lock.json', packages };
}

/** yarn.lock v1 (classic) and Berry formats. */
export function parseYarnLock(text: string): Lockfile {
  const packages: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  let specs: { name: string; rest: string }[] = [];
  let inBody = false;
  let lastVersion = '';
  const flush = () => {
    if (!lastVersion) {
      specs = [];
      return;
    }
    for (const { name, rest } of specs) {
      if (/^(workspace|portal|link|patch|file|exec):/.test(rest)) continue;
      if (!packages[name]) packages[name] = lastVersion;
    }
    specs = [];
  };
  for (const raw of lines) {
    const line = raw.replace(/\t/g, '  ');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      if (inBody) {
        flush();
        inBody = false;
      }
      continue;
    }
    // header: starts at column 0 (quoted or not) and ends with ':'
    if (!/^\s/.test(line) && trimmed.endsWith(':')) {
      if (inBody) flush();
      lastVersion = '';
      specs = trimmed
        .slice(0, -1)
        .split(/,\s*(?=["']?[\w@])/)
        .map((s) => splitSpec(s.trim()))
        .filter((s) => s.name && s.name !== '__metadata');
      inBody = true;
      continue;
    }
    if (inBody) {
      const vm = /^\s*version:?\s+"?([^"\s]+)"?\s*$/.exec(line);
      if (vm) lastVersion = vm[1];
    }
  }
  if (inBody) flush();
  return { ecosystem: 'npm', path: 'yarn.lock', packages };
}

/** pnpm-lock.yaml v5/v6 (`packages:`) and v9 (`snapshots:` + `packages:`). */
export function parsePnpmLock(text: string): Lockfile {
  const packages: Record<string, string> = {};
  let section: 'packages' | 'snapshots' | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^#/.test(line) || !line.trim()) continue;
    const top = /^([\w."'-]+):\s*$/.exec(line);
    if (top) {
      section = top[1] === 'packages' || top[1] === 'snapshots' ? (top[1] as any) : null;
      continue;
    }
    if (!section) continue;
    const entry = /^\s{2}(.+):\s*$/.exec(line);
    if (!entry) continue;
    let key = entry[1].trim().replace(/^["']|["']$/g, '');
    key = key.replace(/\(.*\)$/, ''); // peer suffix
    key = key.replace(/^\//, ''); // registry prefix
    const { name, rest } = splitSpec(key);
    let version = rest.replace(/^npm:/, '').replace(/^file:/, '');
    if (!version || !/^[v\d]/.test(version)) continue;
    version = version.replace(/^v(?=\d)/, '');
    if (!packages[name]) packages[name] = version;
  }
  return { ecosystem: 'npm', path: 'pnpm-lock.yaml', packages };
}

/** requirements.txt (pinned `name==version` lines). */
export function parseRequirementsTxt(text: string): Lockfile {
  const packages: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split('#')[0].trim();
    if (!line || line.startsWith('-')) continue;
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*==\s*([A-Za-z0-9._!+-]+)/.exec(line);
    if (!m) continue;
    const name = m[1].toLowerCase().replace(/_/g, '-');
    if (!packages[name]) packages[name] = m[3];
  }
  return { ecosystem: 'pypi', path: 'requirements.txt', packages };
}

export function parsePackageJson(text: string): Manifest {
  const j = JSON.parse(text);
  return {
    ecosystem: 'npm',
    path: 'package.json',
    dependencies: { ...(j.dependencies || {}), ...(j.devDependencies || {}), ...(j.peerDependencies || {}) },
    ownName: j.name,
    ownVersion: j.version,
    scripts: j.scripts || {},
    files: [],
  };
}

/**
 * Parse whichever lockfile exists in the tree, by preference.
 * `files` is a lowercase relative path list of the tree root.
 */
export function parseLockfileFrom(files: string[], read: (relPath: string) => string | null): Lockfile | null {
  const has = (p: string) => files.includes(p);
  if (has('package-lock.json')) {
    const t = read('package-lock.json');
    if (t) return parsePackageLock(t);
  }
  if (has('npm-shrinkwrap.json')) {
    const t = read('npm-shrinkwrap.json');
    if (t) return parsePackageLock(t);
  }
  if (has('yarn.lock')) {
    const t = read('yarn.lock');
    if (t) return parseYarnLock(t);
  }
  if (has('pnpm-lock.yaml')) {
    const t = read('pnpm-lock.yaml');
    if (t) return parsePnpmLock(t);
  }
  if (has('requirements.txt')) {
    const t = read('requirements.txt');
    if (t) return parseRequirementsTxt(t);
  }
  return null;
}

export function parseManifestFrom(files: string[], read: (relPath: string) => string | null): Manifest | null {
  if (files.includes('package.json')) {
    const t = read('package.json');
    if (t) {
      const m = parsePackageJson(t);
      m.files = files;
      return m;
    }
  }
  return null;
}
