import semver from 'semver';
import { BumpKind, LockDiff, Lockfile, PkgChange } from '../types';

function classify(from: string, to: string): BumpKind {
  const f = semver.coerce(from);
  const t = semver.coerce(to);
  if (!f || !t) return 'changed';
  const d = semver.diff(f, t);
  if (!d) return rawDifferent(from, to) ? 'changed' : 'patch'; // equal semver but raw differs — noise; caller filters
  switch (d) {
    case 'major':
    case 'premajor':
      return 'major';
    case 'minor':
    case 'preminor':
      return 'minor';
    default:
      return 'patch';
  }
}

function rawDifferent(a: string, b: string) {
  return a !== b;
}

const rank: Record<BumpKind, number> = { major: 0, changed: 1, minor: 2, patch: 3, added: 4, removed: 5 };

/**
 * Diff two resolved dependency universes (name -> exact version).
 * Versions that are semver-equal but textually different are ignored to keep the story clean.
 */
export function diffLockfiles(before: Lockfile | null, after: Lockfile | null): LockDiff {
  const changes: PkgChange[] = [];
  const b = before?.packages || {};
  const a = after?.packages || {};
  const names = new Set([...Object.keys(b), ...Object.keys(a)]);
  for (const name of names) {
    const bv = b[name];
    const av = a[name];
    if (bv && !av) {
      changes.push({ name, from: bv, kind: 'removed' });
      continue;
    }
    if (!bv && av) {
      changes.push({ name, to: av, kind: 'added' });
      continue;
    }
    if (bv === av) continue;
    const semEq = semver.coerce(bv) && semver.coerce(av) && semver.eq(semver.coerce(bv)!, semver.coerce(av)!);
    if (semEq) continue;
    changes.push({ name, from: bv, to: av, kind: classify(bv!, av!) });
  }
  const majorGap = (c: PkgChange) => {
    const f = semver.coerce(c.from || '0.0.0');
    const t = semver.coerce(c.to || '0.0.0');
    if (!f || !t) return 0;
    return Math.abs(semver.major(t) - semver.major(f));
  };
  changes.sort(
    (x, y) =>
      rank[x.kind] - rank[y.kind] ||
      majorGap(y) - majorGap(x) ||
      x.name.localeCompare(y.name)
  );
  const counts = { major: 0, minor: 0, patch: 0, changed: 0, added: 0, removed: 0, total: changes.length };
  for (const c of changes) counts[c.kind]++;
  return { changes, counts };
}

export function bumpEmoji(kind: BumpKind): string {
  switch (kind) {
    case 'major': return '⬆️';
    case 'minor': return '✨';
    case 'patch': return '🔧';
    case 'added': return '➕';
    case 'removed': return '➖';
    default: return '•';
  }
}
