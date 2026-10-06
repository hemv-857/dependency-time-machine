'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

function defaultDate(): string {
  const d = new Date(Date.now() - 365 * 86400_000);
  return d.toISOString().slice(0, 10);
}

export interface Preset {
  label: string;
  repo: string;
  date?: string;
  hint: string;
}

export const PRESETS: Preset[] = [
  { label: 'create-react-app · 2022', repo: 'github.com/facebook/create-react-app', date: '2022-06-01', hint: 'webpack 4→5 era, react-scripts at its peak' },
  { label: 'express · 2019', repo: 'github.com/expressjs/express', date: '2019-01-01', hint: 'a library — watch the README + tests fallback' },
  { label: 'your repo last Christmas', repo: '', date: '2025-12-25', hint: 'paste any public GitHub repo' },
];

export default function LauncherForm() {
  const router = useRouter();
  const [repo, setRepo] = useState('');
  const [date, setDate] = useState(defaultDate());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const go = (r: string, d: string) => {
    const clean = r.trim().replace(/^https?:\/\//i, '').replace(/\.git$/i, '');
    if (!clean) {
      setError('Enter a repo URL, e.g. github.com/expressjs/express');
      return;
    }
    setBusy(true);
    router.push(`/${clean}@${d}`);
  };

  return (
    <div className="w-full">
      <form
        className="flex flex-col gap-3 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          go(repo, date);
        }}
      >
        <input
          aria-label="Repository URL"
          className="input sm:flex-1"
          placeholder="github.com/facebook/create-react-app"
          value={repo}
          onChange={(e) => {
            setRepo(e.target.value);
            setError(null);
          }}
          spellCheck={false}
        />
        <input
          aria-label="Date"
          type="date"
          className="input sm:w-44"
          value={date}
          max={new Date().toISOString().slice(0, 10)}
          onChange={(e) => setDate(e.target.value)}
        />
        <button className="btn-primary sm:w-36" type="submit" disabled={busy}>
          {busy ? 'Traveling…' : 'Travel back'}
        </button>
      </form>
      {error && <p className="mt-2 text-sm text-rose-400">{error}</p>}

      <div className="mt-4 flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            title={p.hint}
            className="btn-ghost text-xs"
            onClick={() => {
              setRepo(p.repo);
              setDate(p.date || defaultDate());
              if (p.repo) go(p.repo, p.date || defaultDate());
              else setError('Paste your repo URL above, then travel to last Christmas.');
            }}
          >
            🎛 {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}
