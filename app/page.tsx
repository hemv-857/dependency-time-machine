import LauncherForm from '@/components/LauncherForm';

export default function Landing() {
  return (
    <div>
      <section className="py-16 text-center">
        <p className="mono mb-4 text-mint">git checkout `$(date -d &quot;1 year ago&quot;)`</p>
        <h1 className="mx-auto max-w-3xl text-4xl font-bold leading-tight text-slate-50 sm:text-5xl">
          Any repo. Any date.{' '}
          <span className="bg-gradient-to-r from-mint to-sky-400 bg-clip-text text-transparent">Running again.</span>
        </h1>
        <p className="mx-auto mt-4 max-w-2xl text-slate-400">
          Paste a repo URL and a past date. Dependency Time Machine checks out the commit closest to that day, spins up
          an ephemeral sandboxed build of that exact dependency tree, and tells the story of everything that shipped
          since — majors, minors and the CVEs that no longer exist.
        </p>
      </section>

      <section className="mx-auto max-w-3xl">
        <LauncherForm />
      </section>

      <section className="mt-16 grid gap-4 sm:grid-cols-3">
        {[
          {
            icon: '🧭',
            title: '1 · Find the moment',
            body: 'git rev-list -n 1 --before=DATE picks the commit closest to your date — or jump along the release timeline.',
          },
          {
            icon: '🏗️',
            title: '2 · Rebuild it',
            body: 'An ephemeral container installs that exact lockfile and boots the app. 3-minute hard timeout; libraries get README + install snippet + test log instead.',
          },
          {
            icon: '📖',
            title: '3 · Read the story',
            body: 'Lockfile then-vs-now diff, changelog links for every bump, and a security lens: which CVEs existed then vs fixed now.',
          },
        ].map((c) => (
          <div key={c.title} className="card p-5">
            <div className="text-2xl">{c.icon}</div>
            <h3 className="mt-2 font-semibold text-slate-100">{c.title}</h3>
            <p className="mt-1 text-sm text-slate-400">{c.body}</p>
          </div>
        ))}
      </section>

      <section className="mt-12 card p-6">
        <h2 className="section-title">Shareable by construction</h2>
        <p className="mono text-slate-300">
          timemachine.dev/github.com/foo/bar@2024-01-15
        </p>
        <p className="mt-2 text-sm text-slate-400">
          Every snapshot gets a permalink. Instances are ephemeral (10 min TTL, rebuilt on demand) — the changelog,
          diff and security lens stay cached.
        </p>
      </section>
    </div>
  );
}
