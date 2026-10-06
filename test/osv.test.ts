import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSecurityLens, queryOsvBatch } from '@/core/security/osv';
import { Lockfile } from '@/core/types';

const thenLock: Lockfile = {
  ecosystem: 'npm',
  path: 'package-lock.json',
  packages: { 'left-pad': '1.3.0', lodash: '4.17.15', safe: '1.0.0' },
};
const nowLock: Lockfile = {
  ecosystem: 'npm',
  path: 'package-lock.json',
  packages: { 'left-pad': '1.3.0', lodash: '4.17.21', safe: '1.0.0' },
};

function mockOsvResponse(queries: any[]) {
  return {
    results: queries.map((q: any) => {
      const vulns: any[] = [];
      if (q.package.name === 'lodash' && q.version === '4.17.15') {
        vulns.push({
          id: 'GHSA-lodash-old',
          aliases: ['CVE-2020-8203'],
          summary: 'Prototype pollution in lodash',
          database_specific: { severity: 'HIGH' },
        });
      }
      if (q.package.name === 'left-pad') {
        vulns.push({
          id: 'GHSA-leftpad',
          aliases: [],
          summary: 'ReDoS in left-pad',
          database_specific: { severity: 'MODERATE' },
        });
      }
      return { vulns };
    }),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('queryOsvBatch', () => {
  it('maps OSV results to normalized vulns', async () => {
    const fetchMock = vi.fn(async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      return new Response(JSON.stringify(mockOsvResponse(body.queries)), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const res = await queryOsvBatch([{ name: 'lodash', version: '4.17.15' }], 'npm');
    expect(res).not.toBeNull();
    expect(res![0]).toHaveLength(1);
    expect(res![0][0]).toMatchObject({ id: 'GHSA-lodash-old', severity: 'HIGH', url: 'https://osv.dev/vulnerability/GHSA-lodash-old' });
  });

  it('returns null on network failure (graceful degradation)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));
    const res = await queryOsvBatch([{ name: 'lodash', version: '4.17.15' }], 'npm');
    expect(res).toBeNull();
  });
});

describe('buildSecurityLens', () => {
  it('computes existed-then / fixed-now / still-open', async () => {
    const fetchMock = vi.fn(async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      return new Response(JSON.stringify(mockOsvResponse(body.queries)), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const lens = await buildSecurityLens(thenLock, nowLock, fetchMock as unknown as typeof fetch);
    expect(lens.available).toBe(true);
    expect(lens.then.map((a) => a.id).sort()).toEqual(['GHSA-leftpad', 'GHSA-lodash-old']);
    const lodashVuln = lens.then.find((a) => a.id === 'GHSA-lodash-old')!;
    expect(lodashVuln.packages).toEqual(['lodash']);
    // lodash 4.17.21 has no vuln in the mock → fixed
    expect(lens.fixed.map((a) => a.id)).toContain('GHSA-lodash-old');
    // left-pad unchanged → still open
    expect(lens.stillOpen.map((a) => a.id)).toEqual(['GHSA-leftpad']);
  });
});
