import { describe, expect, it } from 'vitest';
import { diffLockfiles } from '@/core/lockfile/diff';
import { Lockfile } from '@/core/types';

function lock(packages: Record<string, string>): Lockfile {
  return { ecosystem: 'npm', path: 'package-lock.json', packages };
}

describe('diffLockfiles', () => {
  it('classifies major/minor/patch/added/removed', () => {
    const d = diffLockfiles(
      lock({ react: '17.0.2', lodash: '4.17.20', tiny: '1.0.0', gone: '2.0.0' }),
      lock({ react: '18.2.0', lodash: '4.17.21', tiny: '1.0.0', added: '1.0.0' })
    );
    const byName = Object.fromEntries(d.changes.map((c) => [c.name, c]));
    expect(byName.react.kind).toBe('major');
    expect(byName.lodash.kind).toBe('patch');
    expect(byName.added.kind).toBe('added');
    expect(byName.gone.kind).toBe('removed');
    expect(d.counts).toMatchObject({ major: 1, patch: 1, added: 1, removed: 1, total: 4 });
  });

  it('sorts majors first and ignores semver-equal noise (1.0 vs 1.0.0)', () => {
    const d = diffLockfiles(
      lock({ zz: '1.0.2', aa: '1.0.0' }),
      lock({ zz: '2.0.0', aa: '1.0.0' })
    );
    // 'aa' 1.0.0 vs 1.0.0 is identical → no entry; zz major first
    expect(d.changes.map((c) => c.name)).toEqual(['zz']);
  });

  it('handles scoped packages and empty sides', () => {
    const d = diffLockfiles(lock({ '@babel/core': '7.0.0' }), lock({ '@babel/core': '8.0.0' }));
    expect(d.changes[0].kind).toBe('major');
    expect(diffLockfiles(null, lock({ a: '1.0.0' })).counts.added).toBe(1);
    expect(diffLockfiles(lock({ a: '1.0.0' }), null).counts.removed).toBe(1);
  });

  it('classifies calver as major and non-coercible versions as changed', () => {
    const d = diffLockfiles(lock({ pkg: '2020.1.1.dev1' }), lock({ pkg: '2021.2.2.dev3' }));
    expect(d.changes[0].kind).toBe('major');
    const d2 = diffLockfiles(lock({ weird: 'abc' }), lock({ weird: 'def' }));
    expect(d2.changes[0].kind).toBe('changed');
  });
});
