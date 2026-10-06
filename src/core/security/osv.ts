import { Advisory, Ecosystem, Lockfile, OsvVuln, SecurityLens } from '../types';

const OSV_ECOSYSTEM: Partial<Record<Ecosystem, string>> = {
  npm: 'npm',
  pypi: 'PyPI',
};

export interface OsvQueryItem {
  name: string;
  version: string;
}

interface RawVuln {
  id: string;
  aliases?: string[];
  summary?: string;
  details?: string;
  severity?: { type: string; score?: string }[];
  database_specific?: { severity?: string };
}

function toVuln(v: RawVuln): OsvVuln {
  const sev = (v.database_specific?.severity || '').toUpperCase();
  return {
    id: v.id,
    aliases: v.aliases || [],
    summary: v.summary || (v.details || '').slice(0, 200),
    severity: ['CRITICAL', 'HIGH', 'MODERATE', 'MEDIUM', 'LOW'].includes(sev) ? (sev === 'MEDIUM' ? 'MODERATE' : sev) : 'UNKNOWN',
    url: `https://osv.dev/vulnerability/${v.id}`,
  };
}

function base(): string {
  return (process.env.TM_OSV_BASE || 'https://api.osv.dev').replace(/\/$/, '');
}

/**
 * Batch-query OSV.dev for vulnerabilities affecting exact (name, version) pairs.
 * Returns one OsvVuln[] per input item (empty when none / on per-item error).
 * Network failure resolves to `null` so callers can degrade gracefully.
 */
export async function queryOsvBatch(
  items: OsvQueryItem[],
  ecosystem: Ecosystem,
  fetchImpl: typeof fetch = fetch
): Promise<OsvVuln[][] | null> {
  const eco = OSV_ECOSYSTEM[ecosystem];
  if (!eco || items.length === 0) return items.map(() => []);
  const results: OsvVuln[][] = [];
  const CHUNK = 100;
  try {
    for (let i = 0; i < items.length; i += CHUNK) {
      const chunk = items.slice(i, i + CHUNK);
      const res = await fetchImpl(`${base()}/v1/querybatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          queries: chunk.map((it) => ({ package: { name: it.name, ecosystem: eco }, version: it.version })),
        }),
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) throw new Error(`OSV ${res.status}`);
      const j = (await res.json()) as { results?: ({ vulns?: RawVuln[] } | null)[] };
      const rs = j.results || [];
      for (const r of rs) results.push((r?.vulns || []).map(toVuln));
    }
    return results;
  } catch {
    return null;
  }
}

const sevRank: Record<string, number> = { CRITICAL: 0, HIGH: 1, MODERATE: 2, LOW: 3, UNKNOWN: 4 };

function aggregate(perPkg: { pkg: string; vulns: OsvVuln[] }[]): Advisory[] {
  const byId = new Map<string, Advisory>();
  for (const { pkg, vulns } of perPkg) {
    for (const v of vulns) {
      const existing = byId.get(v.id);
      if (existing) {
        if (!existing.packages.includes(pkg)) existing.packages.push(pkg);
      } else {
        byId.set(v.id, { ...v, packages: [pkg] });
      }
    }
  }
  return [...byId.values()].sort(
    (a, b) => sevRank[a.severity] - sevRank[b.severity] || a.id.localeCompare(b.id)
  );
}

/**
 * Build the security lens: which advisories affected the snapshot's dependency
 * versions ("then"), which are fixed in what's shipped "now", and which are still open.
 */
export async function buildSecurityLens(
  before: Lockfile | null,
  after: Lockfile | null,
  fetchImpl: typeof fetch = fetch
): Promise<SecurityLens> {
  const eco = before?.ecosystem || after?.ecosystem;
  if (!eco || !OSV_ECOSYSTEM[eco]) return emptyLens();
  const entries = (l: Lockfile | null) =>
    Object.entries(l?.packages || {}).map(([name, version]) => ({ name, version }));

  const [thenRes, nowRes] = await Promise.all([
    queryOsvBatch(entries(before), eco, fetchImpl),
    queryOsvBatch(entries(after), eco, fetchImpl),
  ]);
  if (!thenRes && !nowRes) return emptyLens();

  const thenPerPkg = (thenRes || []).map((vulns, i) => ({ pkg: entries(before)[i]?.name || '', vulns }));
  const nowPerPkg = (nowRes || []).map((vulns, i) => ({ pkg: entries(after)[i]?.name || '', vulns }));

  const then = aggregate(thenPerPkg);
  const nowIds = new Set(aggregate(nowPerPkg).map((a) => a.id));
  return {
    available: true,
    then,
    fixed: then.filter((a) => !nowIds.has(a.id)),
    stillOpen: then.filter((a) => nowIds.has(a.id)),
  };
}

export function emptyLens(): SecurityLens {
  return { available: false, then: [], fixed: [], stillOpen: [] };
}

/** CVE id from aliases, preferring the CVE form. */
export function cveOf(v: OsvVuln): string | null {
  const cve = v.aliases.find((a) => a.startsWith('CVE-'));
  return cve || null;
}
