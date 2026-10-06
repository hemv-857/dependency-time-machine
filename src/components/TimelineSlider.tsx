'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { TimelinePoint } from '@/lib/tm-types';

/** "Jump to this date" slider along the repo release timeline. */
export default function TimelineSlider({
  owner,
  name,
  points,
  currentIso,
}: {
  owner: string;
  name: string;
  points: TimelinePoint[];
  currentIso: string;
}) {
  const router = useRouter();
  const asc = useMemo(() => [...points].sort((a, b) => Date.parse(a.date) - Date.parse(b.date)), [points]);
  const currentIdx = useMemo(() => {
    let best = 0;
    let delta = Infinity;
    for (let i = 0; i < asc.length; i++) {
      const d = Math.abs(Date.parse(asc[i].date) - Date.parse(currentIso));
      if (d < delta) {
        delta = d;
        best = i;
      }
    }
    return best;
  }, [asc, currentIso]);
  const [idx, setIdx] = useState(currentIdx);
  const point = asc[Math.min(idx, asc.length - 1)];

  return (
    <div className="card mt-4 p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="section-title mb-1">Repo timeline</h2>
          <p className="text-sm text-slate-300">
            <span className="mono text-mint">{point?.label}</span>{' '}
            <span className="mono text-slate-500">{point?.date.slice(0, 10)}</span>
            {idx === currentIdx && <span className="ml-2 text-xs text-slate-500">← you are here</span>}
          </p>
        </div>
        <button
          className="btn-primary text-xs"
          disabled={idx === currentIdx}
          onClick={() => router.push(`/github.com/${owner}/${name}@${point.date.slice(0, 10)}`)}
        >
          ⏱ Jump to this date
        </button>
      </div>
      <input
        type="range"
        className="tm-range mt-4"
        min={0}
        max={asc.length - 1}
        value={idx}
        onChange={(e) => setIdx(Number(e.target.value))}
        aria-label="Timeline"
      />
      <div className="mono mt-1 flex justify-between text-[10px] text-slate-600">
        <span>{asc[0]?.date.slice(0, 10)}</span>
        <span>{asc.length} points</span>
        <span>{asc[asc.length - 1]?.date.slice(0, 10)}</span>
      </div>
    </div>
  );
}
