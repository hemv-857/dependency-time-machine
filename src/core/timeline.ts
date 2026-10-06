import { ReleaseInfo, TimelinePoint } from './types';

/** Dated timeline points (releases) for the "jump to this date" slider. */
export function buildTimeline(releases: ReleaseInfo[], repoCreatedAt?: string): TimelinePoint[] {
  const points: TimelinePoint[] = releases
    .filter((r) => r.date && !Number.isNaN(Date.parse(r.date)))
    .map((r) => ({ date: new Date(r.date).toISOString(), label: r.tag || r.name || 'release', href: r.url }));
  if (repoCreatedAt && !Number.isNaN(Date.parse(repoCreatedAt))) {
    points.push({ date: new Date(repoCreatedAt).toISOString(), label: 'first commit' });
  }
  points.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  // dedupe by day+label
  const seen = new Set<string>();
  return points.filter((p) => {
    const k = `${p.date.slice(0, 10)}:${p.label}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Index of the point closest to (but not after, when possible) the given date. */
export function nearestPointIndex(points: TimelinePoint[], iso: string): number {
  if (points.length === 0) return -1;
  const t = Date.parse(iso);
  let best = 0;
  let bestDelta = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = Date.parse(points[i].date);
    const delta = Math.abs(d - t);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = i;
    }
  }
  return best;
}
