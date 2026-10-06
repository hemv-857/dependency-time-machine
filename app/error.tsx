'use client';

import { useEffect } from 'react';

/**
 * Catches render errors below the root layout so a crash shows a recoverable
 * page instead of a blank screen. Without this, any client-side throw during
 * hydration or interaction leaves the user staring at an empty document.
 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // server-side detail is logged there; keep the UI calm and non-leaky
    console.error('render error', error);
  }, [error]);

  return (
    <div className="py-16">
      <div className="card mx-auto max-w-2xl p-8">
        <h1 className="text-2xl font-bold text-slate-100">Something broke while rendering this</h1>
        <p className="mt-3 text-slate-400">
          The page failed to render. Retrying usually clears it — the snapshot itself is unaffected.
        </p>
        {error.digest && <p className="mono mt-3 text-xs text-slate-500">ref: {error.digest}</p>}
        <div className="mt-6 flex gap-3">
          <button className="btn-primary" onClick={() => reset()}>
            Try again
          </button>
          <a className="btn-ghost" href="/">
            Back to the launcher
          </a>
        </div>
      </div>
    </div>
  );
}