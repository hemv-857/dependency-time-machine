'use client';

/**
 * Last-resort boundary: catches failures in the root layout itself, where
 * app/error.tsx cannot help. Must render its own <html>/<body> because the
 * layout that would normally supply them has failed.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body className="bg-ink text-slate-200 antialiased">
        <div className="mx-auto max-w-2xl px-6 py-24">
          <div className="card p-8">
            <h1 className="text-2xl font-bold text-slate-100">The app failed to start</h1>
            <p className="mt-3 text-slate-400">
              This is a bug rather than a bad URL. Reloading usually recovers.
            </p>
            {error.digest && <p className="mono mt-3 text-xs text-slate-500">ref: {error.digest}</p>}
            <div className="mt-6 flex gap-3">
              <button className="btn-primary" onClick={() => reset()}>
                Reload
              </button>
              <a className="btn-ghost" href="/">
                Back to the launcher
              </a>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}