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

/**
 * go.sum — one `<module> <version> <hash>` line per module, plus a duplicate
 * line per module ending in `/go.mod`. Only the plain entry is a real pin.
 */
export function parseGoSum(text: string): Lockfile {
  const packages: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const module = parts[0];
    const rawVersion = parts[1];
    if (!module || !rawVersion.startsWith('v')) continue;
    if (rawVersion.endsWith('/go.mod')) continue;
    // normalize to the bare semver so diffs and OSV lookups match the other
    // ecosystems (OSV accepts both forms)
    const version = rawVersion.replace(/^v/, '');
    if (packages[module]) continue;
    packages[module] = version;
  }
  return { ecosystem: 'go', path: 'go.sum', packages };
}

/**
 * Cargo.lock — TOML with repeated `[[package]]` blocks. Hand-parsed rather than
 * pulling in a TOML dependency: the shape is fixed and tiny.
 */
export function parseCargoLock(text: string): Lockfile {
  const packages: Record<string, string> = {};
  let name: string | undefined;
  let version: string | undefined;
  // Cargo.lock also contains [[patch.*]] and other tables; only [[package]]
  // entries are real pins.
  let inPackage = false;

  const flush = () => {
    if (inPackage && name && version && !packages[name]) packages[name] = version;
    name = undefined;
    version = undefined;
    inPackage = false;
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '[[package]]') {
      flush();
      inPackage = true;
      continue;
    }
    if (line.startsWith('[')) {
      // any other table (e.g. [[patch.unused]]) is not a dependency
      flush();
      continue;
    }
    if (!inPackage) continue;
    const n = /^name\s*=\s*"([^"]+)"/.exec(line);
    if (n) name = n[1];
    const v = /^version\s*=\s*"([^"]+)"/.exec(line);
    if (v) version = v[1];
  }
  flush();
  return { ecosystem: 'cargo', path: 'Cargo.lock', packages };
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
  if (has('go.sum')) {
    const t = read('go.sum');
    if (t) return parseGoSum(t);
  }
  if (has('Cargo.lock')) {
    const t = read('Cargo.lock');
    if (t) return parseCargoLock(t);
  }
  return null;
}

/**
 * go.mod — we only need the main module path, for an install snippet.
 */
export function parseGoMod(text: string): Manifest {
  const m = /^module\s+(\S+)/m.exec(text);
  return {
    ecosystem: 'go',
    path: 'go.mod',
    dependencies: {},
    ownName: m ? m[1] : undefined,
    ownVersion: undefined,
    scripts: {},
    files: [],
  };
}

/** Cargo.toml — name/version from the [package] table. */
export function parseCargoToml(text: string): Manifest {
  const pkgSection = /^\s*\[package\]([\s\S]*?)(?=^\s*\[|\Z)/m.exec(text);
  const body = pkgSection ? pkgSection[1] : text;
  const n = /^\s*name\s*=\s*"([^"]+)"/m.exec(body);
  const v = /^\s*version\s*=\s*"([^"]+)"/m.exec(body);
  return {
    ecosystem: 'cargo',
    path: 'Cargo.toml',
    dependencies: {},
    ownName: n ? n[1] : undefined,
    ownVersion: v ? v[1] : undefined,
    scripts: {},
    files: [],
  };
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
  if (files.includes('go.mod')) {
    const t = read('go.mod');
    if (t) {
      const m = parseGoMod(t);
      m.files = files;
      return m;
    }
  }
  if (files.includes('Cargo.toml')) {
    const t = read('Cargo.toml');
    if (t) {
      const m = parseCargoToml(t);
      m.files = files;
      return m;
    }
  }
  return null;
}
