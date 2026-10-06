'use client';

import { useEffect, useMemo, useState } from 'react';
import { PublicSnapshot } from '@/lib/tm-types';
import { copyText } from '@/lib/clipboard';
import Markdown from './Markdown';

export default function PreviewPanel({ snap }: { snap: PublicSnapshot }) {
  const [starting, setStarting] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(snap.preview.url || null);
  const [expiresAt, setExpiresAt] = useState<number | null>(snap.preview.expiresAt || null);
  const [startError, setStartError] = useState<string | null>(null);

  const startPreview = async () => {
    setStarting(true);
    setStartError(null);
    try {
      const res = await fetch(`/api/snapshot/${snap.id}/preview`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `failed (${res.status})`);
      setPreviewUrl(body.url);
      setExpiresAt(body.expiresAt);
    } catch (e) {
      setStartError((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  // auto-start the sandbox as soon as the snapshot is ready with an iframe mode
  useEffect(() => {
    if (snap.status === 'ready' && snap.previewMode === 'iframe' && !previewUrl && !starting && !startError) {
      startPreview();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.status, snap.previewMode, previewUrl]);

  if (snap.previewMode === 'iframe' || (snap.status === 'ready' && previewUrl)) {
    return (
      <section className="mt-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="section-title mb-0">Live preview — as it was</h2>
          <div className="flex items-center gap-3 text-xs text-slate-500">
            {expiresAt && <Ttl expiresAt={expiresAt} />}
            {previewUrl && (
              <a href={previewUrl} target="_blank" className="btn-ghost text-xs">
                ⧉ Open full
              </a>
            )}
          </div>
        </div>
        {previewUrl ? (
          <div className="card overflow-hidden">
            <iframe
              src={previewUrl}
              className="h-[560px] w-full bg-white"
              sandbox="allow-scripts allow-forms allow-popups allow-modals"
              title={`${snap.repo.fullName} @ ${snap.commitDate.slice(0, 10)} preview`}
            />
          </div>
        ) : (
          <div className="card p-8 text-center text-sm text-slate-400">
            {starting ? '⏳ warming up the sandbox…' : 'sandbox not running.'}{' '}
            {!starting && <button className="link" onClick={startPreview}>start it →</button>}
            {startError && <p className="mt-2 text-rose-400">{startError}</p>}
          </div>
        )}
      </section>
    );
  }

  if (snap.previewMode === 'readme') {
    return (
      <section className="mt-6 grid gap-6 lg:grid-cols-[1fr_320px]">
        <div>
          <h2 className="section-title">Not a runnable web app — here&apos;s the project as it was</h2>
          <div className="card p-6">
            {snap.readmeMd ? <Markdown md={snap.readmeMd} /> : <p className="text-slate-400">No README at this commit.</p>}
          </div>
        </div>
        <div className="space-y-4">
          {snap.installSnippet && (
            <div className="card p-4">
              <h3 className="section-title">Install it</h3>
              <div className="flex items-center gap-2">
                <code className="mono flex-1 overflow-x-auto rounded bg-black/50 p-2 text-mint">{snap.installSnippet}</code>
                <button
                  className="btn-ghost text-xs"
                  onClick={() => void copyText(snap.installSnippet!)}
                >
                  copy
                </button>
              </div>
            </div>
          )}
          {snap.testLog && (
            <div className="card p-4">
              <h3 className="section-title">Tests at this commit</h3>
              <pre className="log-box">{snap.testLog.slice(-3000)}</pre>
            </div>
          )}
        </div>
      </section>
    );
  }

  return null;
}

function Ttl({ expiresAt }: { expiresAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);
  const left = Math.max(0, Math.round((expiresAt - now) / 1000));
  const mm = String(Math.floor(left / 60)).padStart(2, '0');
  const ss = String(left % 60).padStart(2, '0');
  return (
    <span className="mono text-amber-300/80" title="ephemeral instance TTL">
      ⏱ {mm}:{ss}
    </span>
  );
}
