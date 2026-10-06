import { describe, expect, it } from 'vitest';
import { normalizeDateInput, parseRepoInput } from '@/core/repo-url';
import { planBuild } from '@/server/builder/plan';
import { Manifest } from '@/core/types';

describe('parseRepoInput', () => {
  it('accepts the many shapes users paste', () => {
    const shapes = [
      'github.com/expressjs/express',
      'https://github.com/expressjs/express',
      'https://github.com/expressjs/express.git',
      'expressjs/express',
      'github.com/expressjs/express@2019-01-01',
    ];
    for (const s of shapes) {
      const r = parseRepoInput(s);
      expect(r.fullName).toBe('expressjs/express');
    }
    expect(parseRepoInput('github.com/o/r@2024-01-15').date).toBe('2024-01-15');
  });

  it('rejects non-github hosts and garbage', () => {
    expect(() => parseRepoInput('https://gitlab.com/a/b')).toThrow(/github/i);
    expect(() => parseRepoInput('not a repo')).toThrow();
    expect(() => parseRepoInput('')).toThrow();
  });

  it('rejects traversal-shaped owner/repo', () => {
    // '.' / '..' satisfy the [\w.-] charset but are never valid GitHub names,
    // and must not be forwarded to the API as '../..'.
    expect(() => parseRepoInput('github.com/../..')).toThrow(/Invalid owner\/repo/);
    expect(() => parseRepoInput('github.com/./.')).toThrow(/Invalid owner\/repo/);
    expect(() => parseRepoInput('../../etc/passwd')).toThrow();
  });
});

describe('normalizeDateInput', () => {
  it('normalizes dates to UTC midnight instants and passes refs through', () => {
    expect(normalizeDateInput('2024-01-15')).toEqual({ kind: 'date', iso: '2024-01-15T00:00:00.000Z' });
    expect(normalizeDateInput('v3.1.0')).toEqual({ kind: 'ref', ref: 'v3.1.0' });
    const d = normalizeDateInput();
    expect(d.kind).toBe('date');
    expect(Date.parse((d as any).iso)).toBeLessThan(Date.now());
  });
});

describe('planBuild', () => {
  const manifest = (scripts: Record<string, string>, deps: Record<string, string> = {}): Manifest => ({
    ecosystem: 'npm',
    path: 'package.json',
    dependencies: deps,
    scripts,
    files: [],
  });

  it('web app: install + build + start, static out dirs', () => {
    const p = planBuild({ type: 'node', manifest: manifest({ build: 'vite build', start: 'vite preview' }, { react: '^18' }), hasLockfile: true });
    expect(p?.mode).toBe('build');
    expect(p?.steps.map((s) => s.name)).toEqual(['install', 'build']);
    expect(p?.steps[0].cmd).toContain('npm ci');
    expect(p?.startScript).toBe(true);
  });

  it('library with tests: test mode', () => {
    const p = planBuild({ type: 'node', manifest: manifest({ test: 'mocha' }, { mocha: '^10' }), hasLockfile: false });
    expect(p?.mode).toBe('test');
    expect(p?.steps[0].cmd).toContain('npm install');
  });

  it('plain library: null → README fallback', () => {
    expect(planBuild({ type: 'node', manifest: manifest({}), hasLockfile: true })).toBeNull();
    expect(planBuild({ type: 'python', manifest: null, hasLockfile: false })).toBeNull();
  });

  it('zero-dependency apps skip install (offline-friendly)', () => {
    const p = planBuild({ type: 'node', manifest: manifest({ build: 'node make-dist.js' }), hasLockfile: false });
    expect(p?.steps.map((s) => s.name)).toEqual(['build']);
  });
});
