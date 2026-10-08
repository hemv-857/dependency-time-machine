import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Dependency Time Machine',
  description:
    'Enter any repo URL + a past date → get a live, runnable snapshot of that project as it looked then, plus a human changelog of what shipped since.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* keyboard users would otherwise tab through the nav on every page */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-panel focus:px-4 focus:py-2 focus:text-slate-100"
        >
          Skip to content
        </a>
        <header className="border-b border-edge/60">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
            <Link href="/" className="flex items-center gap-2 font-semibold text-slate-100">
              <span className="text-xl" aria-hidden="true">
                ⏳
              </span>
              <span>
                Dependency <span className="text-mint">Time Machine</span>
              </span>
            </Link>
            <nav aria-label="Main" className="flex items-center gap-5 text-sm text-slate-400">
              <Link href="/compare" className="hover:text-mint">
                Compare
              </Link>
              <Link href="/docs" className="hover:text-mint">
                API
              </Link>
              <Link href="/snapshots" className="hover:text-mint">
                Browse
              </Link>
              <a
                href="https://github.com/hemv-857/dependency-time-machine"
                rel="noreferrer noopener"
                target="_blank"
                className="hover:text-mint"
              >
                GitHub
              </a>
            </nav>
          </div>
        </header>
        <main id="main" tabIndex={-1} className="mx-auto max-w-6xl px-4 pb-16 focus:outline-none">
          {children}
        </main>
        <footer className="border-t border-edge/60 py-6 text-center text-xs text-slate-500">
          Ephemeral instances expire in 10 minutes · private repos via GitHub App · built with the checkout, not
          against it
        </footer>
      </body>
    </html>
  );
}
