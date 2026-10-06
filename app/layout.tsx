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
        <header className="border-b border-edge/60">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
            <Link href="/" className="flex items-center gap-2 font-semibold text-slate-100">
              <span className="text-xl">⏳</span>
              <span>
                Dependency <span className="text-mint">Time Machine</span>
              </span>
            </Link>
            <nav className="flex items-center gap-5 text-sm text-slate-400">
              <Link href="/compare" className="hover:text-mint">
                Compare
              </Link>
              <Link href="/docs" className="hover:text-mint">
                API
              </Link>
              <a href="https://github.com/your-org/dependency-time-machine" className="hover:text-mint">
                GitHub
              </a>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 pb-16">{children}</main>
        <footer className="border-t border-edge/60 py-6 text-center text-xs text-slate-500">
          Ephemeral instances expire in 10 minutes · public repos only in v1 · built with the checkout, not against it
        </footer>
      </body>
    </html>
  );
}
