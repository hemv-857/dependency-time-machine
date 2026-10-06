'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { PublicSnapshot } from '@/lib/tm-types';
import { copyText } from '@/lib/clipboard';
import PreviewPanel from './PreviewPanel';
import TimelineSlider from './TimelineSlider';
import StoryCards from './StoryCards';
import DiffTable from './DiffTable';
import SecurityPanel from './SecurityPanel';

const TERMINAL = new Set(['ready', 'degraded', 'failed']);

function StatusChip({ status }: { status: PublicSnapshot['status'] }) {
  const map: Record<string, string> = {
    queued: 'bg-amber-500/15 text-amber-300 animate-pulse',
    analyzing: 'bg-amber-500/15 text-amber-300 animate-pulse',
    building: 'bg-sky-500/15 text-sky-300 animate-pulse',
    ready: 'bg-mint/15 text-mint',
    degraded: 'bg-amber-500/15 text-amber-300',
    failed: 'bg-rose-500/15 text-rose-300',
  };
  const label: Record<string, string> = {
    queued: 'queued',
    analyzing: 'analyzing…',
    building: 'building sandbox…',
    ready: 'ready',
    degraded: 'changelog only',
    failed: 'failed',
  };
  return <span className={`chip ${map[status]}`}>{label[status] || status}</span>;
}

export default function SnapshotView({ owner, name, when, sharePath }: { owner: string; name: string; when?: string; sharePath: string }) {
  const [snap, setSnap] = useState<PublicSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/snapshot/${snap?.id}`, { cache: 'no-store' });
    if (res.ok) setSnap(await res.json());
  }, [snap?.id]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/snapshot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repo: `github.com/${owner}/${name}`, date: when }),
        });
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok && res.status !== 202) {
          setError(body.message || body.error || `Request failed (${res.status})`);
          return;
        }
        setSnap(body);
        const es = new EventSource(`/api/snapshot/${body.id}/events`);
        esRef.current = es;
        es.addEventListener('snapshot', (ev) => setSnap(JSON.parse((ev as MessageEvent).data)));
        es.addEventListener('done', (ev) => {
          setSnap(JSON.parse((ev as MessageEvent).data));
          es.close();
        });
        es.onerror = () => {
          es.close();
          // fallback: poll until terminal
          pollRef.current = setInterval(async () => {
            const r = await fetch(`/api/snapshot/${body.id}`, { cache: 'no-store' });
            if (r.ok) {
              const s = await r.json();
              setSnap(s);
              if (TERMINAL.has(s.status) && pollRef.current) clearInterval(pollRef.current);
            }
          }, 2500);
        };
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
      esRef.current?.close();
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, name, when]);

  if (error) {
    return (
      <div className="py-16">
        <div className="card mx-auto max-w-xl p-8 text-center">
          <div className="text-3xl">🕳️</div>
          <h1 className="mt-3 text-xl font-bold text-slate-100">Could not open the time machine</h1>
          <p className="mt-2 text-sm text-slate-400">{error}</p>
          <a href="/" className="btn-ghost mt-5">← Back</a>
        </div>
      </div>
    );
  }
  if (!snap) {
    return (
      <div className="py-24 text-center text-slate-500">
        <div className="mono animate-pulse">resolving commit…</div>
      </div>
    );
  }

  const busy = snap.status === 'queued' || snap.status === 'analyzing' || snap.status === 'building';

  return (
    <div className="pt-6">
      {/* header */}
      <div className="card flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">
            <a href={snap.repo.htmlUrl || '#'} target="_blank" className="hover:text-mint">{snap.repo.fullName}</a>
            <span className="text-slate-500"> @ </span>
            <span className="mono text-mint">{snap.commitDate.slice(0, 10)}</span>
          </h1>
          <p className="mono mt-0.5 text-xs text-slate-500">
            <a href={snap.commit.url} target="_blank" className="hover:text-sky-400">{snap.commit.sha.slice(0, 10)}</a>
            {snap.headSha ? ` · head ${snap.headSha.slice(0, 7)}` : ''}
            {snap.toolchain?.node ? ` · node ${snap.toolchain.node}` : ''}
            {snap.toolchain?.python ? ` · python ${snap.toolchain.python}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusChip status={snap.status} />
          <button
            className="btn-ghost text-xs"
            onClick={async () => {
              // only claim success when the copy actually landed
              if (!(await copyText(`${location.origin}${snap.sharePath}`))) return;
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? '✓ copied' : '🔗 share'}
          </button>
        </div>
      </div>

      {snap.timeline && snap.timeline.length > 1 && (
        <TimelineSlider owner={owner} name={name} points={snap.timeline} currentIso={snap.commitDate} />
      )}

      {busy && <ProgressPanel snap={snap} />}

      {snap.status === 'failed' && (
        <div className="card mt-6 p-6">
          <div className="text-2xl">💥</div>
          <p className="mt-2 text-slate-300">{snap.error || 'Something went wrong.'}</p>
          <a href="/" className="btn-ghost mt-4">← Try another repo</a>
        </div>
      )}

      {snap.status === 'degraded' && (
        <div className="card mt-6 border-amber-500/30 p-4 text-sm text-amber-200">
          ⚠️ The sandbox build didn&apos;t make it — showing the changelog only.{' '}
          {snap.buildLog && (
            <details className="mt-2">
              <summary className="cursor-pointer text-amber-300/80">build log</summary>
              <pre className="log-box mt-2">{snap.buildLog.slice(-4000)}</pre>
            </details>
          )}
        </div>
      )}

      {(snap.status === 'ready' || snap.status === 'degraded') && (
        <>
          <PreviewPanel snap={snap} />
          {snap.story && <StoryCards story={snap.story} thenIso={snap.commitDate} />}
          {snap.diff && <DiffTable diff={snap.diff} />}
          {snap.advisories && <SecurityPanel lens={snap.advisories} />}
          <div className="mono mt-8 flex flex-wrap gap-4 text-xs text-slate-500">
            {snap.buildMs ? <span>build {Math.round(snap.buildMs / 1000)}s</span> : null}
            {snap.toolchain?.npm ? <span>npm {snap.toolchain.npm}</span> : null}
            <span>snapshot {snap.id}</span>
            <span>
              <a className="hover:text-sky-400" href={`/api/snapshot/${snap.id}`} target="_blank">GET /api/snapshot/{snap.id}</a>
            </span>
          </div>
        </>
      )}

      {/* readme rendering lives inside PreviewPanel */}
    </div>
  );
}

function ProgressPanel({ snap }: { snap: PublicSnapshot }) {
  return (
    <div className="card mt-6 p-5">
      <h2 className="section-title">Time travel in progress</h2>
      <ul className="space-y-2">
        {(snap.stages || []).map((s) => (
          <li key={s.name} className="flex items-center gap-3 text-sm">
            <span className="w-20 shrink-0 text-slate-500">{s.name}</span>
            <span
              className={
                s.status === 'ok'
                  ? 'text-mint'
                  : s.status === 'running'
                    ? 'text-sky-300 animate-pulse'
                    : s.status === 'failed'
                      ? 'text-rose-400'
                      : 'text-slate-500'
              }
            >
              {s.status === 'ok' ? '✓' : s.status === 'running' ? '◐' : s.status === 'failed' ? '✗' : '–'}
            </span>
            <span className="text-slate-400">{s.detail || s.status}</span>
          </li>
        ))}
      </ul>
      {snap.status === 'building' && <BuildLogTail id={snap.id} />}
    </div>
  );
}

function BuildLogTail({ id }: { id: string }) {
  const [log, setLog] = useState('');
  useEffect(() => {
    const iv = setInterval(async () => {
      const r = await fetch(`/api/snapshot/${id}/log`, { cache: 'no-store' });
      if (r.ok) setLog((await r.text()).slice(-2000));
    }, 3000);
    return () => clearInterval(iv);
  }, [id]);
  if (!log) return null;
  return <pre className="log-box mt-3">{log}</pre>;
}
